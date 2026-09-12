/**
 * `pnpm shell:explain`: one effect's facts and where it stands, or one item's effects and decisions.
 * A read, printed as plain lines — never a log line, and it changes nothing (D163).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ItemRef } from "@hiero-hackers/automation-core";
import { fold, Store, type Decision, type Fact, type LedgerState } from "../store/index.js";
import { defaultDataDir } from "./paths.js";

/** What one question came to: the lines to print, and whether the store held an answer. */
export interface Explanation {
    readonly found: boolean;
    readonly lines: readonly string[];
}

/** How a column that holds nothing is spelled. */
const NOTHING = "-";

const column = (value: string | number | null): string =>
    value === null ? NOTHING : String(value);

const spelled = (item: ItemRef): string => `${item.kind}#${String(item.number)}`;

/** The store `main.ts` would open, by the same rule. */
function storePath(env: Readonly<Partial<Record<string, string>>>): string {
    return env["STORE_PATH"] ?? join(defaultDataDir(env), "shell.sqlite");
}

/** `issue#40` or `pullRequest#40`, and nothing else. */
function itemOf(spec: string): ItemRef | null {
    const named = /^(issue|pullRequest)#(\d+)$/.exec(spec);
    return named === null ? null : { kind: named[1] as ItemRef["kind"], number: Number(named[2]) };
}

/** The plan length no row holds: the longest call this effect ever named. */
const planOf = (facts: readonly Fact[]): number =>
    facts.reduce((longest, fact) => Math.max(longest, fact.seq), 0);

/** One fact: its place in the effect's order, then what it says. */
function factLine(place: number, fact: Fact): string {
    return [
        place,
        fact.at,
        fact.kind,
        fact.seq,
        column(fact.verb),
        column(fact.login),
        column(fact.code),
        column(fact.detail),
    ].join("  ");
}

/** Where the effect stands. `≥` carries the assumption: the plan is the longest seq seen. */
function stateLine(state: LedgerState, plan: number): string {
    const of = `of ≥${String(plan)}`;
    switch (state.kind) {
        case "neverStarted":
            return "state: neverStarted";
        case "open":
            return `state: open (seq ${String(state.seq)} ${of}, attempts ${String(state.attempts)})`;
        case "resumable":
            return `state: resumable (next seq ${String(state.nextSeq)} ${of})`;
        case "settled":
            return `state: settled ${state.how} (seq ${String(state.seq)} ${of})`;
        case "inconsistent":
            return `state: inconsistent (${state.detail})`;
    }
}

function decisionLine(decision: Decision): string {
    return [
        "decision",
        decision.at,
        decision.source,
        decision.passId,
        decision.capability,
        decision.verdict,
        column(decision.code),
        column(decision.detail),
        column(decision.effectId),
    ].join("  ");
}

/** One effect's history in ledger order, then the fold over it. */
export function explainEffect(store: Store, effectId: string): Explanation {
    const facts = store.ledger.factsOf(effectId);
    if (facts.length === 0) {
        return { found: false, lines: [`no facts for effect "${effectId}"`] };
    }
    const plan = planOf(facts);
    return {
        found: true,
        lines: [
            `effect ${effectId}`,
            ...facts.map((fact, place) => factLine(place + 1, fact)),
            stateLine(fold(facts, plan), plan),
        ],
    };
}

/** Every effect with a fact on one item and where each stands, then its decisions, newest first. */
export function explainItem(store: Store, item: ItemRef): Explanation {
    const effects = store.ledger.effectsOn(item);
    const decisions = [...store.ledger.decisionsOn(item)].reverse();
    return {
        found: effects.length > 0 || decisions.length > 0,
        lines: [
            spelled(item),
            ...effects.map((effectId) => {
                const facts = store.ledger.factsOf(effectId);
                const plan = planOf(facts);
                return `effect ${effectId}  ${stateLine(fold(facts, plan), plan)}`;
            }),
            ...decisions.map(decisionLine),
        ],
    };
}

const USAGE = "usage: pnpm shell:explain <effect-id> | pnpm shell:explain --item issue#40";

/** The command: which store to open, and which of the two questions to ask it. */
export function explain(
    argv: readonly string[],
    env: Readonly<Partial<Record<string, string>>> = process.env,
): Explanation {
    // pnpm forwards the root script's `--` separator as an argument; it asks nothing.

    const [first, second] = argv[0] === "--" ? argv.slice(1) : argv;
    const item = first === "--item" ? itemOf(second ?? "") : null;
    if (first === undefined || first === "" || (first === "--item" && item === null)) {
        return { found: false, lines: [USAGE] };
    }
    const path = storePath(env);
    if (!existsSync(path)) return { found: false, lines: [`no store at ${path}`] };
    const store = new Store(path);
    try {
        return item === null ? explainEffect(store, first) : explainItem(store, item);
    } finally {
        store.close();
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const answer = explain(process.argv.slice(2));
    for (const line of answer.lines) process.stdout.write(`${line}\n`);
    process.exit(answer.found ? 0 : 1);
}
