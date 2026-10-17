/**
 * One run decides one capture or one sweep over the live adapter with GitHub scripted behind
 * `fetch`: the runner's environment in, decision rows in the in-memory store, an exit code out.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { asDeliveryGuid } from "@hiero-hackers/automation-core";
import { CAPABILITIES } from "@hiero-hackers/automation-capabilities";
import { capture } from "@hiero-hackers/automation-testkit";
import {
    ACTION_REFUSAL,
    deliveryIdOf,
    parseActionEnvironment,
    runAction,
    runStore,
    type ActionRun,
} from "../../../src/shell/compose/action.js";
import { explainItem } from "../../../src/shell/observe/explain.js";
import type { ShellEvent } from "../../../src/shell/log.js";
import { CONFIGS } from "./journeys.js";
import { scriptedGitHub } from "./scripted-github.js";

const START = new Date("2026-09-15T10:00:00.000Z");
const REPOSITORY = { owner: "scrubbed-1", repo: "scrubbed-2" } as const;

const ENVIRONMENT = {
    GITHUB_REPOSITORY: "scrubbed-1/scrubbed-2",
    GITHUB_EVENT_NAME: "issues",
    GITHUB_EVENT_PATH: "/tmp/event.json",
    INPUT_TOKEN: "runner-token",
    GITHUB_RUN_ID: "42",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SERVER_URL: "https://github.com",
};

const configFor = (capability: string, mode = "dry-run"): string => `schemaVersion: 2
mode: ${mode}
capabilities:
${CONFIGS[capability] ?? ""}mappings:
  labels:
    awaitingTriage: "status: triage"
  commands:
    assign: /assign
    unassign: /unassign
    working: /working
`;

afterEach(() => {
    vi.unstubAllGlobals();
});

function runOf(overrides: Partial<ActionRun> = {}): ActionRun {
    const parsed = parseActionEnvironment(ENVIRONMENT);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    return { ...parsed.run, ...overrides };
}

const kinds = (events: readonly ShellEvent[]): string[] => events.map(({ event }) => event);

describe("the runner's environment", () => {
    it("refuses an empty one, naming every missing piece", () => {
        const parsed = parseActionEnvironment({});
        const { arm: _unasked, ...required } = ACTION_REFUSAL;
        expect(parsed).toEqual({ ok: false, errors: Object.values(required) });
    });

    it("refuses an arming input that is neither true nor false", () => {
        const parsed = parseActionEnvironment({ ...ENVIRONMENT, "INPUT_ARM-WRITES": "yes" });
        expect(parsed).toEqual({ ok: false, errors: [ACTION_REFUSAL.arm] });
    });

    it("reads a run, unarmed by default, with a GUID that is the attempt's alone", () => {
        const parsed = parseActionEnvironment({ ...ENVIRONMENT, "INPUT_ARM-WRITES": "true" });
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.run.repository).toEqual(REPOSITORY);
        expect(parsed.run.armWrites).toBe(true);
        expect(parsed.run.runUrl).toBe("https://github.com/scrubbed-1/scrubbed-2/actions/runs/42");
        expect(asDeliveryGuid(parsed.run.deliveryId)).toBe(parsed.run.deliveryId);
        expect(parsed.run.deliveryId).toBe(deliveryIdOf("42", "1"));
        expect(deliveryIdOf("42", "2")).not.toBe(parsed.run.deliveryId);
        expect(runOf().armWrites).toBe(false);
    });
});

describe("one run", () => {
    it("decides a captured issue through the live seams and explains it from the store", async () => {
        scriptedGitHub({ now: () => START, config: () => configFor("triageQueue") });
        const store = runStore();
        const outcome = await runAction(runOf(), {
            payload: capture("issues.opened.json").bytes(),
            store,
            clock: () => START,
            log: () => undefined,
            capabilities: CAPABILITIES,
        });
        expect(outcome.kind).toBe("delivery");
        expect(outcome.exitCode).toBe(0);
        expect(outcome.modeLowered).toBe(false);
        expect(outcome.items).toEqual([{ kind: "issue", number: 164 }]);
        expect(outcome.events.find((event) => event.event === "deliveryCompleted")).toMatchObject({
            kind: "decision",
        });
        const rows = store.ledger.decisionsOn(REPOSITORY, { kind: "issue", number: 164 });
        // Two dry-run effects, each explained, would apply, and recorded only.
        expect(rows.filter((row) => row.code === "modeRecordsOnly")).toHaveLength(2);
        expect(explainItem(store, REPOSITORY, { kind: "issue", number: 164 }).found).toBe(true);
        store.close();
    });

    it("decides an active repository as dry-run while writes are not armed", async () => {
        scriptedGitHub({ now: () => START, config: () => configFor("triageQueue", "active") });
        const store = runStore();
        const outcome = await runAction(runOf({ armWrites: false }), {
            payload: capture("issues.opened.json").bytes(),
            store,
            clock: () => START,
            log: () => undefined,
        });
        expect(outcome.exitCode).toBe(0);
        expect(outcome.modeLowered).toBe(true);
        expect(kinds(outcome.events)).not.toContain("effectApplied");
        expect(store.ledger.decisionsOn(REPOSITORY, { kind: "issue", number: 164 })).not.toEqual(
            [],
        );
        store.close();
    });

    it("exits non-zero when the payload names a repository this workflow does not run in", async () => {
        scriptedGitHub({ now: () => START, config: () => configFor("triageQueue") });
        const store = runStore();
        const outcome = await runAction(runOf({ repository: { owner: "other", repo: "place" } }), {
            payload: capture("issues.opened.json").bytes(),
            store,
            clock: () => START,
            log: () => undefined,
        });
        expect(outcome.exitCode).toBe(1);
        expect(outcome.events.find((event) => event.event === "deliveryCompleted")).toMatchObject({
            kind: "repositoryMismatch",
        });
        store.close();
    });

    it("fires the sweep on the schedule when a scheduled capability is enabled", async () => {
        scriptedGitHub({ now: () => START, config: () => configFor("inactivity") });
        const store = runStore();
        const outcome = await runAction(runOf({ eventName: "schedule" }), {
            payload: Buffer.from("{}"),
            store,
            clock: () => START,
            log: () => undefined,
        });
        expect(outcome.kind).toBe("sweep");
        expect(outcome.exitCode).toBe(0);
        expect(kinds(outcome.events)).toContain("sweepFinished");
        store.close();
    });

    it("is idle on the schedule when nothing asks to be swept", async () => {
        scriptedGitHub({ now: () => START, config: () => configFor("triageQueue") });
        const store = runStore();
        const outcome = await runAction(runOf({ eventName: "schedule" }), {
            payload: Buffer.from("{}"),
            store,
            clock: () => START,
            log: () => undefined,
        });
        expect(outcome.kind).toBe("idle");
        expect(outcome.exitCode).toBe(0);
        expect(kinds(outcome.events)).not.toContain("sweepClaimed");
        store.close();
    });
});
