/**
 * What `pnpm shell:explain` prints, over a store a test wrote: one effect's facts
 * and the fold's assumption about a plan the rows do not hold, one item's effects
 * and decisions, and the two answers that end in 1 — no store, and nothing asked.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTempDir } from "@hiero-hackers/automation-testkit";
import type { ItemRef } from "@hiero-hackers/automation-core";
import { Store, type Decision, type Fact } from "../../src/store/index.js";
import { explain, explainEffect, explainItem } from "../../src/shell/explain.js";

const ITEM: ItemRef = { kind: "issue", number: 40 };
const AT = "2026-09-12T09:00:00.000Z";
const later = (seconds: number): string => new Date(Date.parse(AT) + seconds * 1000).toISOString();

const fact = (over: Partial<Fact> = {}): Fact => ({
    effectId: "effect-a",
    seq: 1,
    kind: "sent",
    at: AT,
    revision: "revision-1",
    capability: "intake",
    item: ITEM,
    verb: "postComment",
    login: null,
    code: null,
    detail: null,
    payload: '{"verb":"postComment"}',
    ...over,
});

const decision = (over: Partial<Decision> = {}): Decision => ({
    passId: "pass-1",
    source: "webhook",
    sourceId: "pass-1",
    at: AT,
    item: ITEM,
    capability: "intake",
    verdict: "info",
    code: "wouldApply",
    detail: "dry-run: intake would applyMappedLabel",
    effectId: null,
    ...over,
});

const temp = useTempDir("shell-explain-");
let path: string;
let store: Store;

/**
 * One landed effect and one still open on its second send, both on the item,
 * plus the two decisions the passes that minted them recorded.
 */
beforeEach(() => {
    path = temp.file("store.sqlite");
    store = new Store(path);
    store.ledger.record(fact());
    store.ledger.record(fact({ kind: "landed", at: later(1), payload: null }));
    store.ledger.record(fact({ effectId: "effect-b", at: later(2) }));
    store.ledger.record(fact({ effectId: "effect-b", at: later(3) }));
    store.ledger.decide(decision({ effectId: "effect-a" }));
    store.ledger.decide(
        decision({
            passId: "sweep:o/r:issue#40",
            source: "sweep",
            sourceId: "sweep:o/r",
            at: later(4),
            verdict: "refused",
            code: "itemClosed",
            detail: null,
            effectId: "effect-b",
        }),
    );
});
afterEach(() => {
    store.close();
});

describe("one effect explained", () => {
    it("prints every fact in ledger order, then the fold over the longest seq seen", () => {
        expect(explainEffect(store, "effect-b")).toEqual({
            found: true,
            lines: [
                "effect effect-b",
                `1  ${later(2)}  sent  1  postComment  -  -  -`,
                `2  ${later(3)}  sent  1  postComment  -  -  -`,
                "state: open (seq 1 of ≥1, attempts 2)",
            ],
        });
    });

    /** The other three the fold can answer; `settled` and `open` are the cases above. */
    it("prints the state line of every other kind the fold answers", () => {
        const state = (effectId: string): string | undefined =>
            explainEffect(store, effectId).lines.at(-1);
        store.ledger.record(
            fact({ effectId: "warned-effect", seq: 0, kind: "warned", verb: null, payload: "{}" }),
        );
        store.ledger.record(fact({ effectId: "resumed-effect" }));
        store.ledger.record(
            fact({ effectId: "resumed-effect", kind: "landed", at: later(1), payload: null }),
        );
        store.ledger.record(fact({ effectId: "resumed-effect", seq: 2, at: later(2) }));
        store.ledger.record(
            fact({ effectId: "resumed-effect", seq: 2, kind: "unsent", at: later(3) }),
        );
        store.ledger.record(fact({ effectId: "broken-effect", kind: "landed", payload: null }));

        expect(state("warned-effect")).toBe("state: neverStarted");
        expect(state("resumed-effect")).toBe("state: resumable (next seq 2 of ≥2)");
        expect(state("broken-effect")).toBe(
            "state: inconsistent (a landed at seq 1 closes no open send)",
        );
    });

    it("says so in one line when no fact names the effect", () => {
        expect(explainEffect(store, "effect-z")).toEqual({
            found: false,
            lines: ['no facts for effect "effect-z"'],
        });
    });
});

describe("one item explained", () => {
    it("prints each effect with its state, then the decisions newest first", () => {
        expect(explainItem(store, ITEM)).toEqual({
            found: true,
            lines: [
                "issue#40",
                "effect effect-a  state: settled landed (seq 1 of ≥1)",
                "effect effect-b  state: open (seq 1 of ≥1, attempts 2)",
                `decision  ${later(4)}  sweep  sweep:o/r:issue#40  intake  refused  itemClosed  -  effect-b`,
                `decision  ${AT}  webhook  pass-1  intake  info  wouldApply  dry-run: intake would applyMappedLabel  effect-a`,
            ],
        });
    });

    it("finds nothing for an item no fact and no decision names", () => {
        expect(explainItem(store, { kind: "pullRequest", number: 41 })).toEqual({
            found: false,
            lines: ["pullRequest#41"],
        });
    });
});

describe("the command around the two reads", () => {
    it("reads the store the environment names", () => {
        expect(explain(["--item", "issue#40"], { STORE_PATH: path }).lines[0]).toBe("issue#40");
        expect(explain(["effect-a"], { STORE_PATH: path }).found).toBe(true);
    });

    /** `pnpm shell:explain` reaches the script as `explain -- <question>`. */
    it("steps over the separator pnpm forwards", () => {
        expect(explain(["--", "--item", "issue#40"], { STORE_PATH: path }).lines[0]).toBe(
            "issue#40",
        );
        expect(explain(["--", "effect-a"], { STORE_PATH: path }).found).toBe(true);
    });

    it("answers a store that is not there without creating one", () => {
        const missing = temp.file("absent.sqlite");

        expect(explain(["effect-a"], { STORE_PATH: missing })).toEqual({
            found: false,
            lines: [`no store at ${missing}`],
        });
    });

    it("prints how to ask when asked nothing, or asked for an item it cannot spell", () => {
        const usage = expect.stringContaining("usage: pnpm shell:explain");

        expect(explain([], { STORE_PATH: path })).toEqual({ found: false, lines: [usage] });
        expect(explain(["--item", "issue-40"], { STORE_PATH: path })).toEqual({
            found: false,
            lines: [usage],
        });
    });
});
