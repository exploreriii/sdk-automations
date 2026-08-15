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
import { lines, repoRoot, trackedFiles } from "./helpers.js";

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

function workflowLines(path: string): string[] {
    return lines(readFileSync(join(repoRoot, path), "utf8"));
}

function permissionWrites(path: string): string[] {
    const writes: string[] = [];
    let inPermissions = false;
    for (const line of workflowLines(path)) {
        if (/^\s*permissions:\s*$/.test(line)) {
            inPermissions = true;
            continue;
        }
        if (inPermissions) {
            const match = /^\s+([A-Za-z_-]+):\s*(read|write|none)\s*(?:#.*)?$/.exec(line);
            if (match) {
                if (match[2] === "write") writes.push(`${path}:${match[1]}`);
                continue;
            }
            if (/^\S/.test(line)) inPermissions = false;
        }
    }
    return writes;
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
        const actual = workflows.flatMap(permissionWrites);
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
});
