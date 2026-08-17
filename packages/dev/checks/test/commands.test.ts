/**
 * Every `pnpm` command a contributor is told to run exists as a script. CI
 * gained `format:check` and no document mentioned it, so a contributor could
 * follow CONTRIBUTING exactly, pass locally, and still go red on push (#94).
 * The reverse is the same bug: a documented command that does not exist sends
 * someone to a failure with no explanation. One invariant per file (D89).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, trackedFiles, workspacePackages } from "./repository.js";

/** The documents that instruct a human. Not `design/` — that explains, it does not instruct. */
const INSTRUCTING = ["CONTRIBUTING.md", "README.md"];

/**
 * One `pnpm …` invocation, to the end of its code span or line. Horizontal
 * whitespace only: `\s` crosses newlines, so `cache: pnpm` followed by the
 * next line's `- run:` read as a command named `run:`.
 */
const COMMAND = /pnpm[ \t]+([^\n`]*)/g;

/** Flags that swallow the token after them, so it is never the script name. */
const TAKES_VALUE = new Set(["--filter", "-F", "--dir", "-C", "--workspace-root"]);

/** pnpm's own subcommands, which need no script to exist. */
const BUILTIN = new Set([
    "install",
    "add",
    "remove",
    "why",
    "dlx",
    "exec",
    "run",
    "store",
    "audit",
]);

/** The first token that is neither a flag nor a flag's value. */
function scriptName(invocation: string): string | null {
    const tokens = invocation.trim().split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!;
        if (TAKES_VALUE.has(token)) {
            i++;
            continue;
        }
        if (token.startsWith("-")) continue;
        return /^[a-z][a-z:-]*$/.test(token) ? token : null;
    }
    return null;
}

function scriptsOf(manifest: string): Set<string> {
    const json = JSON.parse(readFileSync(join(repoRoot, manifest), "utf8")) as {
        scripts?: Record<string, unknown>;
    };
    return new Set(Object.keys(json.scripts ?? {}));
}

/** Every script name declared anywhere in the workspace, root included. */
function allScripts(): Set<string> {
    const manifests = ["package.json", ...workspacePackages().map((p) => `${p}/package.json`)];
    return new Set(manifests.flatMap((m) => [...scriptsOf(m)]));
}

export function documentedCommands(text: string): string[] {
    return [...text.matchAll(COMMAND)]
        .map((m) => scriptName(m[1]!))
        .filter((name): name is string => name !== null && !BUILTIN.has(name));
}

describe("every documented pnpm command exists", () => {
    const scripts = allScripts();
    const docs = INSTRUCTING.filter((d) => trackedFiles().includes(d)).map((doc) => ({
        doc,
        text: readFileSync(join(repoRoot, doc), "utf8"),
    }));

    it("finds documents and commands to check", () => {
        expect(docs.length).toBe(INSTRUCTING.length);
        expect(docs.flatMap((d) => documentedCommands(d.text)).length).toBeGreaterThan(3);
    });

    it("every pnpm command in an instructing document is a real script", () => {
        const unknown: string[] = [];
        for (const { doc, text } of docs) {
            for (const name of documentedCommands(text)) {
                if (!scripts.has(name)) unknown.push(`${doc} -> pnpm ${name}`);
            }
        }
        expect([...new Set(unknown)]).toEqual([]);
    });

    it("the gates CI runs are documented somewhere a contributor reads", () => {
        const documented = new Set(docs.flatMap((d) => documentedCommands(d.text)));
        const ciText = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
        const inCi = new Set(documentedCommands(ciText));
        const undocumented = [...inCi].filter(
            (name) => !documented.has(name) && !name.startsWith("test:"),
        );
        expect(undocumented).toEqual([]);
    });

    it("proves the check can fail", () => {
        expect(documentedCommands("run `pnpm format:check` before pushing")).toEqual([
            "format:check",
        ]);
        expect(documentedCommands("run `pnpm -r test` and `pnpm lint`")).toEqual(["test", "lint"]);
        expect(documentedCommands("`pnpm --filter @scope/pkg test:coverage`")).toEqual([
            "test:coverage",
        ]);
        expect(documentedCommands("`pnpm install --frozen-lockfile`")).toEqual([]);
        expect(documentedCommands("cache: pnpm\n      - run: pnpm lint")).toEqual(["lint"]);
        expect(allScripts().has("format:check")).toBe(true);
        expect(allScripts().has("no-such-script")).toBe(false);
    });
});
