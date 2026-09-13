/**
 * The shell's directories are a direction (D172): every import goes down the
 * table below or stays in its own directory, only the applier's table names
 * the fold's five states, and only the shared box calls the applier. Read as
 * text, like every check about another package (D85). One invariant per file (D89).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { repoRoot, repositoryFiles } from "./repository.js";

const SHELL = "packages/runtime/src/shell";

/** The re-export surface: it names every directory and belongs to none. */
const BARREL = `${SHELL}/index.ts`;

/** `log.ts`, `paths.ts` and `effects.ts` — the vocabulary any directory may name. */
const ROOT = "root";

/**
 * Who may name whom. `compose` composes; the lanes and the tick's jobs reach
 * the shared box and the applier; `apply` reaches only its operations and the
 * root; `observe` reads. Nothing at all names `compose`.
 */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
    compose: ["jobs", "inbound", "sweep", "decide", "apply", "observe", ROOT],
    jobs: ["inbound", "sweep", "decide", "apply", ROOT],
    inbound: ["sweep", "decide", ROOT],
    sweep: ["decide", "apply", ROOT],
    decide: ["apply", ROOT],
    apply: ["apply/operations", ROOT],
    "apply/operations": [ROOT],
    observe: [ROOT],
    [ROOT]: [],
};

/** One shell file, as the checks read every file they do not import. */
interface Source {
    readonly path: string;
    readonly text: string;
}

/** The directory a shell file belongs to; the files at the top are `root`. */
function directoryOf(path: string): string {
    const within = path.slice(SHELL.length + 1);
    const cut = within.lastIndexOf("/");
    return cut === -1 ? ROOT : within.slice(0, cut);
}

/** Every relative specifier a file names — `import` and `export … from` alike. */
function specifiersIn(text: string): string[] {
    return [...text.matchAll(/from "(\.[^"]+)"/g)].map((match) => match[1]!);
}

/** Which directory one specifier lands in, or `null` when it leaves the shell. */
function targetOf(path: string, specifier: string): string | null {
    const landed = posix.normalize(posix.join(posix.dirname(path), specifier));
    return landed.startsWith(`${SHELL}/`) ? directoryOf(landed) : null;
}

/** Every edge a file draws out of its own directory, as the table spells one. */
function edgesIn({ path, text }: Source): string[] {
    const from = directoryOf(path);
    return specifiersIn(text)
        .map((specifier) => targetOf(path, specifier))
        .filter((to): to is string => to !== null && to !== from)
        .map((to) => `${from} -> ${to}`);
}

/** The edges the table refuses, including any drawn from a directory it never named. */
function forbiddenEdges(sources: readonly Source[]): string[] {
    const found = sources.flatMap(edgesIn);
    return [...new Set(found)]
        .filter((edge) => {
            const [from, to] = edge.split(" -> ") as [string, string];
            return !(ALLOWED[from] ?? []).includes(to);
        })
        .sort();
}

/** The five the fold hands the applier, as a case names one. */
const STATES = ["neverStarted", "resumable", "open", "settled", "inconsistent"] as const;

/** Where the five become one row each. */
const TABLE = `${SHELL}/apply/actions.ts`;

/** The one other file that may spell a state: it renders one to a reader, and acts on none. */
const RENDERER = `${SHELL}/observe/explain.ts`;

/** Which of the five a file spells as a value; a word in prose is not one. */
function statesNamedIn({ text }: Source): string[] {
    return STATES.filter((state) => text.includes(`"${state}"`));
}

/** The files that spell a state and are neither the table nor the renderer. */
function statesNamedElsewhere(sources: readonly Source[]): string[] {
    return sources
        .filter(({ path }) => path !== TABLE && path !== RENDERER)
        .filter((source) => statesNamedIn(source).length > 0)
        .map(({ path }) => path)
        .sort();
}

/** Where the applier is driven from. */
const CALLER = `${SHELL}/decide/item.ts`;

/** Every file that CALLS the applier; `apply.ts` declares the method and calls none. */
function appliersCalledIn(sources: readonly Source[]): string[] {
    return sources
        .filter(({ text }) => text.includes(".applyAll("))
        .map(({ path }) => path)
        .sort();
}

/** Every file under `src/shell/`, the barrel excepted. */
function shellSources(): Source[] {
    return repositoryFiles()
        .filter((path) => path.startsWith(`${SHELL}/`) && path.endsWith(".ts") && path !== BARREL)
        .map((path) => ({ path, text: readFileSync(join(repoRoot, path), "utf8") }));
}

describe("the shell's imports flow one way", () => {
    const sources = shellSources();

    it("finds the shell's files", () => {
        expect(sources.length).toBeGreaterThan(20);
        expect(sources.map(({ path }) => directoryOf(path))).toContain("apply/operations");
    });

    it("draws no edge the table refuses", () => {
        expect(forbiddenEdges(sources)).toEqual([]);
    });

    it("catches an import that climbs, and one that stays in the table", () => {
        const climbing = {
            path: `${SHELL}/apply/gates.ts`,
            text: 'import { warn } from "../decide/externals.js";',
        };
        expect(forbiddenEdges([climbing])).toEqual(["apply -> decide"]);
        const naming = {
            path: `${SHELL}/observe/status.ts`,
            text: 'import { createShell } from "../compose/shell.js";',
        };
        expect(forbiddenEdges([naming])).toEqual(["observe -> compose"]);
        const allowed = {
            path: `${SHELL}/decide/item.ts`,
            text: 'import { a } from "../apply/apply.js";\nimport { b } from "../log.js";',
        };
        expect(forbiddenEdges([allowed])).toEqual([]);
    });
});

describe("one file names the fold's five states", () => {
    const sources = shellSources();

    it("names all five in the applier's table", () => {
        const table = sources.find(({ path }) => path === TABLE);
        expect(statesNamedIn(table!)).toEqual([...STATES]);
    });

    it("names none of them anywhere else that acts on one", () => {
        expect(statesNamedElsewhere(sources)).toEqual([]);
    });

    it("catches a state named outside the table", () => {
        const elsewhere = {
            path: `${SHELL}/inbound/deliveries.ts`,
            text: 'if (state.kind === "resumable") return;',
        };
        expect(statesNamedElsewhere([elsewhere])).toEqual([elsewhere.path]);
        const prose = {
            path: `${SHELL}/inbound/deliveries.ts`,
            text: "// the send stays open until the switch lifts\nconst open = 1;",
        };
        expect(statesNamedElsewhere([prose])).toEqual([]);
    });
});

describe("one file calls the applier", () => {
    const sources = shellSources();

    it("is the shared box, and nothing else", () => {
        expect(appliersCalledIn(sources)).toEqual([CALLER]);
    });

    it("catches a second caller, and does not count the declaration", () => {
        const second = {
            path: `${SHELL}/sweep/sweep.ts`,
            text: "await applier.applyAll(approved, config, budget);",
        };
        expect(appliersCalledIn([second])).toEqual([second.path]);
        const declaration = {
            path: `${SHELL}/apply/apply.ts`,
            text: "    applyAll(effects: readonly Effect[]): Promise<EffectOutcome[]>;",
        };
        expect(appliersCalledIn([declaration])).toEqual([]);
    });
});
