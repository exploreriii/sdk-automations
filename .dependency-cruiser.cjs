/**
 * The workspace dependency graph, as rules rather than as a hand-written
 * scanner.
 *
 * `packages/checks/test/architecture.test.ts` is this file's ENFORCEMENT
 * GATE: it cruises the real tree with these rules and fails on any
 * violation, and it cruises a deliberately-violating fixture tree with the
 * same rules to prove they can still fire. There is no CLI step and no
 * separate CI job — if a rule here stops matching, that test goes red.
 *
 * The gate also supplies the roots to cruise (every workspace package's
 * `src/` and `test/`, plus the lab's local-only harness when it is present),
 * because that list is discovered from `pnpm-workspace.yaml` and a config
 * file cannot run discovery.
 *
 * These rules are a LAYER POLICY, not a copied workspace list. The six role
 * names below are spelled out only because this file cannot execute the
 * discovery the gate does; everything else — which directories exist, which
 * packages are present — stays derived.
 */

/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
    forbidden: [
        {
            name: "no-circular",
            severity: "error",
            comment:
                "A cycle makes the layer table unenforceable: whichever direction you read it in, " +
                "both packages are above the other. This one applies to every package, including " +
                "the ones the direction rules leave unrestricted.",
            from: {},
            to: { circular: true },
        },
        {
            name: "core-imports-no-internal-package",
            severity: "error",
            comment:
                "core is the bottom of the stack: pure logic, no workspace neighbours. Its TESTS " +
                "may still reach the testkit, which is why testkit is absent from this list and " +
                "owns its own rule below.",
            from: { path: "^packages/core/(?:src|test)/" },
            to: { path: "^packages/(?:store|shell|probes|checks|lab)/" },
        },
        {
            name: "store-imports-core-only",
            severity: "error",
            comment: "The owned operational store sits directly on core and on nothing else.",
            from: { path: "^packages/store/(?:src|test)/" },
            to: { path: "^packages/(?:shell|probes|checks|lab)/" },
        },
        {
            name: "shell-imports-core-store-probes",
            severity: "error",
            comment:
                "The transport shell composes core, store and probes. D93 owns shell -> probes: " +
                "the shell decides nothing, so the disposable capability stubs are a legitimate " +
                "runtime edge rather than a leak, and they leave with probes/ at stage four.",
            from: { path: "^packages/shell/(?:src|test)/" },
            to: { path: "^packages/(?:checks|lab)/" },
        },
        {
            name: "testkit-imports-no-internal-package",
            severity: "error",
            comment:
                "The testkit is a leaf on purpose. A config or declaration builder here would " +
                "need core, and core's tests need the testkit — the cycle this rule refuses in " +
                "advance.",
            from: { path: "^packages/testkit/(?:src|test)/" },
            to: { path: "^packages/(?:core|store|shell|probes|checks|lab)/" },
        },
        {
            name: "production-imports-no-checks-or-lab",
            severity: "error",
            comment:
                "checks is tests about the repository and lab is an instrument pointed at " +
                "GitHub. Neither ships, so nothing that ships may reach them — stated separately " +
                "from the layer directions because it survives any future reordering of them.",
            from: { path: "^packages/(?:core|store|shell)/" },
            to: { path: "^packages/(?:checks|lab)/" },
        },
        {
            name: "testkit-is-test-only",
            severity: "error",
            comment:
                "The testkit is importable from a test path and nowhere else. 'Who may depend on " +
                "it' is not the question — every package's tests may — so this reads the " +
                "IMPORTER's directory rather than the layer table.",
            from: { path: "^packages/(?!testkit/)[^/]+/src/" },
            to: { path: "^packages/testkit/" },
        },
        {
            name: "no-import-past-the-barrel",
            severity: "error",
            comment:
                "The package's public export is the boundary. Reaching a module THROUGH it is " +
                "fine; reaching past it — a named subpath, or a relative path that climbs out of " +
                "one package and down into another — is not. `$1` is the importing package, so " +
                "a package's own internals stay reachable from itself.",
            from: { path: "^packages/([^/]+)/" },
            to: {
                path: "^packages/[^/]+/src/",
                pathNot: ["^packages/$1/", "^packages/[^/]+/src/index\\.ts$"],
            },
        },
        {
            name: "not-to-unresolvable",
            severity: "error",
            comment:
                "The other half of the rule above, and the reason it is not decoration: a named " +
                "subpath like `@hiero-hackers/automation-core/private` never resolves at all, " +
                "because every package's exports map exposes exactly '.'. Without this rule such " +
                "an import produces no edge and therefore no violation — silence where the " +
                "loudest possible error belongs.",
            from: {},
            to: { couldNotResolve: true },
        },
    ],
    options: {
        // node_modules is followed only far enough to land on the workspace
        // symlink targets, which resolve back into `packages/` and are the
        // whole point of the rules above.
        doNotFollow: { path: "node_modules" },
        exclude: {
            path: [
                "/node_modules/",
                // Stryker sandboxes hold a full copy of a package's src/ and
                // test/ under a path that still starts with `packages/`.
                // Cruising them would double every module and report every
                // rule twice against files nobody edits.
                "\\.stryker-tmp",
                // The gate's own negative control: a tree of deliberate
                // violations, cruised separately and on purpose.
                "^packages/checks/test/fixtures/",
            ],
        },
        // The old scanner counted `import type` as an edge, and it was right
        // to: a type-only import is still one package knowing another's
        // shape. Without this, erasable imports would leave the graph.
        tsPreCompilationDeps: true,
        enhancedResolveOptions: {
            // dependency-cruiser defaults `exportsFields` to `[]` — it
            // ignores exports maps for backwards compatibility. Every package
            // here declares `exports` and no `main`, so with the default
            // every workspace import resolves to nothing, and the rule that
            // treats non-resolution as an error would report the whole
            // workspace rather than the one subpath it is there to catch.
            exportsFields: ["exports"],
            conditionNames: ["import", "require", "node", "types", "default"],
        },
    },
};
