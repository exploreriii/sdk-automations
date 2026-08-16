/**
 * The four security claims the workflow comments make, as checks: actions
 * SHA-pinned with version comments, no `pull_request_target`, permissions
 * read-only outside an explicit allowlist, and no checkout persisting the
 * token. The whole directory is read, because this class regresses through a
 * NEW job that quietly omits the hardening rather than through a removal (D100).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { lines, repoRoot, trackedFiles } from "./repository.js";

const workflows = trackedFiles().filter(
    (path) => path.startsWith(".github/workflows/") && /\.ya?ml$/.test(path),
);

/**
 * The SARIF uploads' declared needs. A workflow that needs a write must add
 * its file and key here visibly, rather than weaken the check.
 */
const WRITE_ALLOWLIST = new Set([
    ".github/workflows/scorecard.yml:security-events",
    ".github/workflows/scorecard.yml:id-token",
    // CodeQL's SARIF upload, declared on the analyze job only so no other
    // step can inherit it (D101, #42).
    ".github/workflows/codeql.yml:security-events",
]);

function workflowText(path: string): string {
    return readFileSync(join(repoRoot, path), "utf8");
}

function workflowLines(path: string): string[] {
    return lines(workflowText(path));
}

/** A `permissions:` value, in every shape the Actions schema allows. */
type PermissionBlock = string | Readonly<Record<string, unknown>> | null | undefined;

interface WorkflowDocument {
    readonly permissions?: PermissionBlock;
    readonly jobs?: Readonly<Record<string, { readonly permissions?: PermissionBlock } | null>>;
}

/**
 * The writes one block grants, as `<path>:<scope>`.
 *
 * `write-all` reports under that name rather than expanding to every scope:
 * it is a different decision from granting one scope, and no allowlist entry
 * naming a scope should ever match it.
 */
function writesIn(path: string, block: PermissionBlock): string[] {
    if (block === null || block === undefined) return [];
    if (typeof block === "string") return block === "write-all" ? [`${path}:write-all`] : [];
    return Object.entries(block)
        .filter(([, level]) => level === "write")
        .map(([scope]) => `${path}:${scope}`);
}

/**
 * Parsed, never scanned line by line. A regex reading `permissions:` off its
 * own line is blind to a flow mapping, a quoted `"write"`, and the
 * `write-all` shorthand — three legal spellings of the grant this check
 * exists to refuse, each of which passed silently. Same argument, same
 * parser, as `mutation-coverage.test.ts` reading `ci.yml`.
 *
 * Both levels the schema permits: the workflow's own block, and each job's.
 */
function permissionWrites(path: string, text: string): string[] {
    const document = parse(text) as WorkflowDocument | null;
    if (document === null || typeof document !== "object") return [];
    const jobs = Object.values(document.jobs ?? {});
    return [
        ...writesIn(path, document.permissions),
        ...jobs.flatMap((job) => writesIn(path, job?.permissions)),
    ];
}

describe("workflow hygiene stays a checked invariant", () => {
    it("reads every workflow file", () => {
        expect(workflows.length).toBeGreaterThan(0);
    });

    it("pins every action to a full commit SHA with a version comment", () => {
        for (const path of workflows) {
            for (const line of workflowLines(path)) {
                if (!line.includes("uses:")) continue;
                const match = /^\s*(?:-\s+)?uses:\s+([^\s#]+)\s+#\s*v.+$/.exec(line);
                expect(match, `${path}: ${line}`).not.toBeNull();
                const ref = match![1]!.split("@").at(-1)!;
                expect(ref, `${path}: ${line}`).toMatch(/^[0-9a-f]{40}$/);
            }
        }
    });

    it("never uses pull_request_target", () => {
        for (const path of workflows) {
            expect(
                workflowLines(path).join("\n"),
                `${path} must not contain pull_request_target`,
            ).not.toContain("pull_request_target");
        }
    });

    it("keeps permissions read-only outside the explicit write allowlist", () => {
        const actual = workflows.flatMap((path) => permissionWrites(path, workflowText(path)));
        expect([...actual].sort()).toEqual([...WRITE_ALLOWLIST].sort());
    });

    /**
     * Without the flag the token is written into `.git/config` and stays
     * readable to every later step. `ci.yml` claims every checkout sets it,
     * and a claim in this repository becomes an invariant (D100).
     */
    it("never persists the token past checkout", () => {
        const missing: string[] = [];
        for (const path of workflows) {
            const body = workflowLines(path);
            body.forEach((line, i) => {
                if (!/uses:\s+actions\/checkout@/.test(line)) return;
                // The `with:` block belongs to this step: scan forward until
                // the next step (`- `) at the same or shallower indentation.
                const indent = line.search(/\S/);
                let persists = false;
                for (let j = i + 1; j < body.length; j++) {
                    const next = body[j]!;
                    if (next.trim() === "") continue;
                    if (next.search(/\S/) <= indent && /^\s*-\s/.test(next)) break;
                    if (next.search(/\S/) <= indent && next.trim() !== "") break;
                    if (/persist-credentials:\s*false/.test(next)) {
                        persists = true;
                        break;
                    }
                }
                if (!persists) missing.push(`${path}:${String(i + 1)}`);
            });
        }
        expect(missing).toEqual([]);
    });

    it("proves the pin check can fail in both directions", () => {
        const pin = (ref: string): boolean => /^[0-9a-f]{40}$/.test(ref);
        expect(pin("v4")).toBe(false);
        expect(pin("3d3c42e5aac5ba805825da76410c181273ba90b1")).toBe(true);
    });

    /**
     * The allowlist comparison guards the workflows that exist; this guards
     * the check itself against the way it regresses — a NEW job whose grant
     * is spelt in a shape the reader never learned. Every row below is valid
     * YAML that GitHub honours, and the first three were invisible to the
     * line scanner this replaced.
     */
    it.each([
        [
            "a block mapping",
            "jobs:\n  a:\n    permissions:\n      contents: write\n",
            ["w:contents"],
        ],
        ["a flow mapping", "jobs:\n  a:\n    permissions: { contents: write }\n", ["w:contents"]],
        ["a quoted value", 'permissions:\n  contents: "write"\n', ["w:contents"]],
        ["the write-all shorthand", "permissions: write-all\n", ["w:write-all"]],
        ["a workflow-level block", "permissions:\n  contents: write\n", ["w:contents"]],
    ] as const)("finds the write granted by %s", (_name, yaml, expected) => {
        expect(permissionWrites("w", yaml)).toEqual(expected);
    });

    it.each([
        ["read", "permissions:\n  contents: read\n"],
        ["none", "permissions:\n  contents: none\n"],
        ["read-all", "permissions: read-all\n"],
        ["an empty block", "permissions: {}\n"],
        ["no permissions key at all", "jobs:\n  a:\n    runs-on: ubuntu-latest\n"],
    ] as const)("reports no write for %s", (_name, yaml) => {
        expect(permissionWrites("w", yaml)).toEqual([]);
    });
});
