/**
 * Every package that owns a Stryker config owns a real recursive source
 * scope and a numeric gate, and CI runs that exact package set. This is the
 * repository-level lock against a config or matrix entry drifting alone.
 *
 * The workflow is read with a YAML parser rather than sliced with regular
 * expressions. A check whose grip on `ci.yml` depends on where the line
 * breaks fall is the exact fragility this package exists to remove — and it
 * was reading a file format it already had a parser for.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { normalizeRepoPath, repoRoot, trackedFiles, workspacePackages } from "./helpers.js";

interface StrykerConfig {
    readonly mutate: readonly string[];
    readonly thresholds: { readonly break: unknown };
}

interface ConfiguredPackage {
    readonly name: string;
    readonly path: string;
    readonly config: StrykerConfig;
    readonly sources: readonly string[];
}

interface Job {
    readonly name?: string;
    readonly strategy?: {
        readonly matrix?: Readonly<Record<string, readonly string[] | undefined>>;
    };
    readonly steps?: readonly { readonly run?: string }[];
}

interface Workflow {
    readonly jobs?: Readonly<Record<string, Job | undefined>>;
}

function mutationJob(workflow: string): Job {
    const job = (parse(workflow) as Workflow).jobs?.mutation;
    if (job === undefined) throw new Error("the ci workflow has no mutation job");
    return job;
}

/** The matrix axis CI fans the job out over, in declaration order. */
function matrixPackages(job: Job): string[] {
    return [...(job.strategy?.matrix?.package ?? [])];
}

function runCommands(job: Job): string[] {
    return (job.steps ?? []).map(({ run }) => run ?? "");
}

function matrixDrift(
    configured: readonly string[],
    matrix: readonly string[],
): { missing: string[]; extra: string[] } {
    const configuredSet = new Set(configured);
    const matrixSet = new Set(matrix);
    return {
        missing: configured.filter((name) => !matrixSet.has(name)).sort(),
        extra: matrix.filter((name) => !configuredSet.has(name)).sort(),
    };
}

const tracked = trackedFiles();
const trackedSet = new Set(tracked);
const configuredPackages: ConfiguredPackage[] = workspacePackages()
    .filter((packagePath) => trackedSet.has(`${packagePath}/stryker.config.json`))
    .map((packagePath) => {
        const configPath = `${packagePath}/stryker.config.json`;
        const config = JSON.parse(
            readFileSync(join(repoRoot, configPath), "utf8"),
        ) as StrykerConfig;
        const prefix = `${packagePath}/`;
        const sources = tracked
            .filter((path) => path.startsWith(`${prefix}src/`) && path.endsWith(".ts"))
            .map((path) => normalizeRepoPath(path.slice(prefix.length)));
        return { name: basename(packagePath), path: packagePath, config, sources };
    });

const mutation = mutationJob(
    readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8"),
);

describe("mutation policy stays complete across packages and CI", () => {
    it("discovers every configured workspace package", () => {
        expect(configuredPackages.map(({ name }) => name).sort()).toEqual([
            "core",
            "shell",
            "store",
        ]);
    });

    /**
     * Two facts, and together they are the whole of what the deleted
     * glob-to-RegExp compiler proved: the scope is EXACTLY the recursive one,
     * and the package has sources for it to reach. A hand-written matcher
     * asking whether `src/**` covers `src/a/b.ts` was answering a question
     * about globbing, not about this repository.
     */
    it("mutates every tracked TypeScript source recursively", () => {
        for (const subject of configuredPackages) {
            expect(subject.config.mutate, subject.path).toEqual(["src/**/*.ts"]);
            expect(subject.sources.length, subject.path).toBeGreaterThan(0);
        }
    });

    it("sets a numeric break threshold in every package policy", () => {
        for (const subject of configuredPackages) {
            expect(typeof subject.config.thresholds.break, subject.path).toBe("number");
        }
    });

    it("runs every configured package independently in the mutation matrix", () => {
        expect(mutation.name).toBe("mutation testing (${{ matrix.package }})");
        expect(runCommands(mutation)).toContain(
            "pnpm --filter @hiero-hackers/automation-${{ matrix.package }} exec stryker run",
        );
        expect(
            matrixDrift(
                configuredPackages.map(({ name }) => name),
                matrixPackages(mutation),
            ),
        ).toEqual({ missing: [], extra: [] });
    });

    it("proves misspelled scopes fail in both directions, and reformatting does not", () => {
        expect(matrixDrift(["core", "shell", "store"], ["core", "shell", "stroe"])).toEqual({
            missing: ["store"],
            extra: ["stroe"],
        });
        // The improvement over the regex, stated as a test: the same matrix
        // written as a block sequence instead of a flow sequence, with the
        // job's keys reordered and the run command folded across lines. The
        // old `package:\s*\[([^\]]+)\]` slice read nothing at all from this,
        // and reported an empty matrix as a drift-free one.
        const reformatted = mutationJob(
            [
                "jobs:",
                "  mutation:",
                "    strategy:",
                "      matrix:",
                "        package:",
                "          - core",
                "          - shell",
                "          - store",
                "    name: mutation testing (${{ matrix.package }})",
                "    steps:",
                "      - run: >-",
                "          pnpm --filter",
                "          @hiero-hackers/automation-${{ matrix.package }} exec stryker run",
                "",
            ].join("\n"),
        );
        expect(matrixPackages(reformatted)).toEqual(matrixPackages(mutation));
        expect(reformatted.name).toBe(mutation.name);
        expect(runCommands(reformatted)).toContain(
            "pnpm --filter @hiero-hackers/automation-${{ matrix.package }} exec stryker run",
        );
    });
});
