/**
 * The workspace dependency graph is architecture, not package-manager trivia.
 * Membership comes from pnpm; dependency-cruiser supplies the import edges.
 *
 * Two halves, because the graph is written down in two places. Manifests are
 * read here — a `package.json` is not a module and no import scanner will
 * ever open one. Source imports are read by dependency-cruiser against
 * `.dependency-cruiser.cjs`, which this file is the enforcement gate for: it
 * cruises the real tree and fails on any violation, then cruises a fixture
 * tree of deliberate violations to prove the rules can still fire.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, posix, resolve } from "node:path";
import { cruise } from "dependency-cruiser";
import type { ICruiseOptions, ICruiseResult, IConfiguration } from "dependency-cruiser";
import { describe, expect, it } from "vitest";
import { normalizeRepoPath, repoRoot, trackedFiles, workspacePackages } from "./helpers.js";

/**
 * The manifest SECTION a dependency was declared in is part of the edge, not
 * bookkeeping: `testkit` is legal from `devDependencies` and illegal from
 * every other section, and a tuple that had forgotten where it came from
 * could not tell the two apart.
 */
type Section = "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies";

type Dependency = readonly [specifier: string, reference: string, section: Section];

interface WorkspacePackage {
    readonly directory: string;
    readonly name: string;
    readonly dependencies: readonly Dependency[];
}

interface Edge {
    readonly importer: WorkspacePackage;
    readonly imported: WorkspacePackage;
    readonly file: string;
    readonly section: Section;
}

interface Violation {
    readonly importer: string;
    readonly imported: string;
    readonly file: string;
    readonly rule: string;
}

interface Manifest {
    readonly name?: unknown;
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
    readonly optionalDependencies?: Readonly<Record<string, string>>;
    readonly peerDependencies?: Readonly<Record<string, string>>;
}

/** Layer policy, not a copied workspace list. D93 owns shell -> probes. */
const ALLOWED: Readonly<Record<string, ReadonlySet<string>>> = {
    core: new Set(),
    store: new Set(["core"]),
    shell: new Set(["core", "store", "probes"]),
    // The testkit is a leaf on purpose. A config or declaration builder here
    // would need core, and core's tests need the testkit — the cycle this
    // empty set refuses in advance.
    testkit: new Set(),
};
const NON_PRODUCTION = new Set(["checks", "lab", "probes", "testkit"]);

/**
 * The testkit is test-only in two directions, and each half is checked where
 * it is written down. A manifest may name it from `devDependencies` and
 * nowhere else — that is this file's business. A source file may import it
 * from a `test/` path and nowhere else, which is the cruiser's
 * `testkit-is-test-only` rule.
 */
const TESTKIT = "testkit";

function role(workspacePackage: WorkspacePackage): string {
    return posix.basename(workspacePackage.directory);
}

const SECTIONS: readonly Section[] = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
];

function manifestDependencies(manifest: Manifest): Dependency[] {
    return SECTIONS.flatMap((section) =>
        Object.entries(manifest[section] ?? {}).map(([specifier, reference]): Dependency => [
            specifier,
            reference,
            section,
        ]),
    );
}

function loadPackages(directories: readonly string[]): WorkspacePackage[] {
    return directories.map((directory) => {
        const manifest = JSON.parse(
            readFileSync(join(repoRoot, directory, "package.json"), "utf8"),
        ) as Manifest;
        if (typeof manifest.name !== "string") {
            throw new Error(`${directory}/package.json has no package name`);
        }
        return {
            directory: normalizeRepoPath(directory).replace(/\/$/, ""),
            name: manifest.name,
            dependencies: manifestDependencies(manifest),
        };
    });
}

function packageContaining(
    path: string,
    packages: readonly WorkspacePackage[],
): WorkspacePackage | undefined {
    return packages.find(
        (candidate) => path === candidate.directory || path.startsWith(`${candidate.directory}/`),
    );
}

function dependencyTarget(
    importer: WorkspacePackage,
    [specifier, reference]: Dependency,
    packages: readonly WorkspacePackage[],
): WorkspacePackage | undefined {
    const protocol = /^(workspace|link|file):(.*)$/.exec(reference);
    if (protocol === null) {
        return packages.find(({ name }) => name === specifier);
    }
    const target = protocol[2]!;
    if (protocol[1] !== "workspace" || target.startsWith(".")) {
        const path = normalizeRepoPath(resolve(repoRoot, importer.directory, target));
        return packageContaining(posix.relative(normalizeRepoPath(repoRoot), path), packages);
    }
    return (
        packages.find(({ name }) => target === name || target.startsWith(`${name}@`)) ??
        packages.find(({ name }) => name === specifier)
    );
}

function violation(edge: Edge, rule: string): Violation {
    return {
        importer: edge.importer.name,
        imported: edge.imported.name,
        file: edge.file,
        rule,
    };
}

/**
 * Edges INTO the testkit answer to their own rule and skip the layer table
 * entirely: every package's tests may reach it, so asking ALLOWED would mean
 * naming every package there — the copied-workspace-list shape this file's
 * header rejects.
 */
function testkitViolation(edge: Edge): Violation | undefined {
    return edge.section === "devDependencies"
        ? undefined
        : violation(edge, "testkit is test-only; declare it under devDependencies");
}

function directionViolation(edge: Edge): Violation | undefined {
    if (role(edge.imported) === TESTKIT) return testkitViolation(edge);
    const importerRole = role(edge.importer);
    const importedRole = role(edge.imported);
    if (
        !NON_PRODUCTION.has(importerRole) &&
        (importedRole === "checks" || importedRole === "lab")
    ) {
        return violation(edge, "production packages cannot import checks or lab");
    }
    const allowed = ALLOWED[importerRole];
    if (allowed === undefined || allowed.has(importedRole)) return undefined;
    return violation(
        edge,
        `${importerRole} may import only ${[...allowed].join(", ") || "external packages"}`,
    );
}

/**
 * A `package.json` is not a module, so no import scanner will ever open one —
 * and a declared-but-unimported edge is exactly the kind that survives a
 * refactor unnoticed. Hence this half stays hand-written.
 */
function manifestViolations(packages: readonly WorkspacePackage[]): Violation[] {
    if (new Set(packages.map(({ name }) => name)).size !== packages.length) {
        throw new Error("workspace package names must be unique");
    }
    const violations: Violation[] = [];
    for (const importer of packages) {
        for (const dependency of importer.dependencies) {
            const imported = dependencyTarget(importer, dependency, packages);
            const file = `${importer.directory}/package.json`;
            if (dependency[1].startsWith("workspace:") && imported === undefined) {
                violations.push({
                    importer: importer.name,
                    imported: dependency[1],
                    file,
                    rule: "workspace dependency target cannot be resolved",
                });
                continue;
            }
            if (imported === undefined) continue;
            const edge: Edge = { importer, imported, file, section: dependency[2] };
            const direction = directionViolation(edge);
            if (direction !== undefined) violations.push(direction);
            if (dependency[0] !== imported.name) {
                violations.push(
                    violation(
                        edge,
                        "local workspace aliases are forbidden; use the canonical package export",
                    ),
                );
            }
        }
    }
    return violations;
}

function messages(violations: readonly Violation[]): string[] {
    return violations.map(
        ({ file, importer, imported, rule }) => `${file}: ${importer} -> ${imported}: ${rule}`,
    );
}

const packages = loadPackages(workspacePackages());
const packageName = (wantedRole: string): string => {
    const found = packages.find((candidate) => role(candidate) === wantedRole);
    if (found === undefined) throw new Error(`workspace has no ${wantedRole}`);
    return found.name;
};

describe("workspace manifests declare the allowed dependency directions", () => {
    it("accepts the real manifests discovered from pnpm-workspace.yaml", () => {
        expect(packages.length).toBeGreaterThan(0);
        expect(messages(manifestViolations(packages))).toEqual([]);
    });

    it("detects every forbidden production direction", () => {
        const declare = (wantedRole: string, target: string): WorkspacePackage[] =>
            packages.map((candidate) =>
                role(candidate) === wantedRole
                    ? {
                          ...candidate,
                          dependencies: [
                              ...candidate.dependencies,
                              [packageName(target), "workspace:*", "dependencies"] as const,
                          ],
                      }
                    : candidate,
            );
        for (const [from, to] of [
            ["core", "store"],
            ["store", "shell"],
            ["shell", "checks"],
            ["shell", "lab"],
        ]) {
            expect(messages(manifestViolations(declare(from!, to!)))).toEqual(
                expect.arrayContaining([
                    expect.stringContaining(`${packageName(from!)} -> ${packageName(to!)}`),
                ]),
            );
        }
    });

    it("rejects local aliases while retaining their hidden graph edges", () => {
        const aliased = packages.map((candidate) =>
            role(candidate) === "core"
                ? {
                      ...candidate,
                      dependencies: [
                          ...candidate.dependencies,
                          [
                              "store-workspace-alias",
                              `workspace:${packageName("store")}@*`,
                              "dependencies",
                          ] as const,
                          ["store-link-alias", "link:../store", "dependencies"] as const,
                          ["store-file-alias", "file:../store", "dependencies"] as const,
                      ],
                  }
                : candidate,
        );
        const actual = messages(manifestViolations(aliased));
        expect(
            actual.filter((message) => message.includes("workspace aliases are forbidden")),
        ).toHaveLength(3);
        expect(
            actual.filter((message) =>
                message.includes(
                    `${packageName("core")} -> ${packageName("store")}: core may import only external packages`,
                ),
            ),
        ).toHaveLength(3);
    });

    it("detects a workspace dependency that resolves to no package", () => {
        const dangling = packages.map((candidate) =>
            role(candidate) === "shell"
                ? {
                      ...candidate,
                      dependencies: [
                          ...candidate.dependencies,
                          [
                              "@hiero-hackers/automation-gone",
                              "workspace:*",
                              "dependencies",
                          ] as const,
                      ],
                  }
                : candidate,
        );
        expect(messages(manifestViolations(dangling))).toEqual([
            `packages/shell/package.json: ${packageName("shell")} -> workspace:*: workspace dependency target cannot be resolved`,
        ]);
    });

    it("detects a testkit dependency declared outside devDependencies", () => {
        const asRuntime = packages.map((candidate) =>
            role(candidate) === "shell"
                ? {
                      ...candidate,
                      dependencies: [
                          ...candidate.dependencies.filter(
                              ([specifier]) => specifier !== packageName("testkit"),
                          ),
                          [packageName("testkit"), "workspace:*", "dependencies"] as const,
                      ],
                  }
                : candidate,
        );
        expect(messages(manifestViolations(asRuntime))).toEqual([
            `packages/shell/package.json: ${packageName("shell")} -> ${packageName("testkit")}: testkit is test-only; declare it under devDependencies`,
        ]);
    });
});

/**
 * The rule set lives at the repository root so a reader looking for "what may
 * import what" finds one file, and so a future `depcruise` invocation and
 * this gate cannot disagree about the answer.
 */
const configuration = createRequire(import.meta.url)(
    join(repoRoot, ".dependency-cruiser.cjs"),
) as IConfiguration;

const cruiseOptions = (baseDir: string): ICruiseOptions => ({
    ...configuration.options,
    ruleSet: { forbidden: configuration.forbidden ?? [] },
    validate: true,
    baseDir,
});

async function cruiseViolations(roots: readonly string[], baseDir: string): Promise<string[]> {
    const { output } = await cruise([...roots], cruiseOptions(baseDir));
    if (typeof output === "string") throw new Error("expected a cruise result, not a report");
    return (output as ICruiseResult).summary.violations.map(
        ({ rule, from, to }) => `${rule.name}: ${from} -> ${to}`,
    );
}

/**
 * The roots come from the workspace file for the same reason the package list
 * does: a hard-coded array is a test that needs editing to stay correct.
 *
 * `packages/lab/harness/` is deliberately absent. It is the era-1 harness —
 * local-only, gitignored, not a workspace member, with its own lockfile and
 * `node_modules` — so CI never sees it and cruising it could only ever
 * produce failures on the machines that do the work, which is the same
 * disagreement D95 removed from `pnpm lint`. It reaches into core by relative
 * path BECAUSE it is not a workspace member; the layer policy has nothing to
 * say to it.
 */
const cruiseRoots = workspacePackages()
    .flatMap((directory) => [`${directory}/src`, `${directory}/test`])
    .filter((directory) => existsSync(join(repoRoot, directory)));

const FIXTURES = "test/fixtures/architecture";

describe("source imports follow the layer policy, checked by dependency-cruiser", () => {
    it("accepts the real tree", async () => {
        expect(cruiseRoots.length).toBeGreaterThan(5);
        expect(await cruiseViolations(cruiseRoots, repoRoot)).toEqual([]);
    });

    /**
     * The negative control the hand-written scanner used to carry inline. The
     * fixture tree mirrors `packages/<role>/src/` so the very same path
     * regexes apply to it; only the base directory differs, which is also the
     * proof that the rules are about layers rather than about this checkout.
     */
    it("fires every rule against a tree of deliberate violations", async () => {
        const fixtureRoot = join(repoRoot, "packages/checks", FIXTURES);
        const fired = new Set(
            (await cruiseViolations(["packages"], fixtureRoot)).map(
                (message) => message.split(":")[0]!,
            ),
        );
        expect([...fired].sort()).toEqual([
            "core-imports-no-internal-package",
            "no-circular",
            "no-import-past-the-barrel",
            "not-to-unresolvable",
            "production-imports-no-checks-or-lab",
            "shell-imports-core-store-probes",
            "store-imports-core-only",
            "testkit-imports-no-internal-package",
            "testkit-is-test-only",
        ]);
    });

    it("keeps the fixture tree out of the real cruise", async () => {
        // Belt and braces: the fixtures live under `packages/checks/test/`,
        // which IS a cruise root. If the config's exclude ever stopped
        // matching them, the test above would start reporting nine
        // violations against files that are supposed to have them.
        const scanned = await cruise(cruiseRoots, cruiseOptions(repoRoot));
        const result = scanned.output as ICruiseResult;
        expect(result.modules.length).toBeGreaterThan(50);
        expect(result.modules.filter(({ source }) => source.includes(FIXTURES))).toEqual([]);
    });
});

/**
 * The hole every import scanner has, the deleted AST walk and
 * dependency-cruiser alike: `import.meta.resolve` takes the same specifier an
 * import does, but it is a FUNCTION CALL. Nothing that reads import syntax
 * sees it, so a module can turn a package name into a directory and then walk
 * wherever it likes inside it — past the barrel, into a private test tree —
 * and leave no edge for any rule above to forbid.
 */
const RESOLVE_REACH = /import\.meta\.resolve\(\s*["'`]@hiero-hackers\//;

/**
 * The two survivors, and why the assertion is an exact set rather than an
 * empty one. Both transpile core's `github/ids.ts` into a scratch directory
 * so a `node:worker_threads` contender can import it, which is a genuine
 * reach past core's barrel that no import rule can see. Naming them here is
 * the smallest honest statement: the pattern is closed to everything else,
 * and the day these two stop needing it this array becomes empty.
 */
const RESOLVE_REACH_ALLOWED: readonly string[] = [
    "packages/store/test/delivery-finalization.test.ts",
    "packages/store/test/delivery-intake.test.ts",
];

function resolveReaches(sources: readonly { path: string; text: string }[]): string[] {
    return sources
        .filter(({ text }) => RESOLVE_REACH.test(text))
        .map(({ path }) => path)
        .sort();
}

describe("no new module reaches into another package by resolving its specifier", () => {
    it("finds import.meta.resolve of a workspace package nowhere else", () => {
        const sources = trackedFiles()
            .filter((path) => path.endsWith(".ts"))
            .map((path) => ({ path, text: readFileSync(join(repoRoot, path), "utf8") }));
        expect(sources.length).toBeGreaterThan(20);
        expect(resolveReaches(sources)).toEqual([...RESOLVE_REACH_ALLOWED].sort());
    });

    it("proves the check can fail", () => {
        // The specifier is assembled rather than written out, so that this
        // file — which `trackedFiles()` above also reads — does not report
        // itself as the third offender.
        const scope = "@hiero-hackers";
        expect(
            resolveReaches([
                {
                    path: "packages/shell/src/reach.ts",
                    text: `const core = import.meta.resolve("${scope}/automation-core");`,
                },
                { path: "packages/shell/src/fine.ts", text: 'import.meta.resolve("./local.js");' },
            ]),
        ).toEqual(["packages/shell/src/reach.ts"]);
    });
});
