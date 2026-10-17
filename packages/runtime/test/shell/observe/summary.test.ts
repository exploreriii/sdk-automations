/**
 * The job summary and its annotations, read from a store a real one-shot run decided into.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capture } from "@hiero-hackers/automation-testkit";
import {
    parseActionEnvironment,
    runAction,
    runStore,
    type ActionRun,
    type RunOutcome,
} from "../../../src/shell/compose/action.js";
import { annotations, appendSummary, renderSummary } from "../../../src/shell/observe/summary.js";
import { CONFIGS } from "../compose/journeys.js";
import { scriptedGitHub } from "../compose/scripted-github.js";

const START = new Date("2026-09-15T10:00:00.000Z");

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

async function decided(
    run: ActionRun,
    mode: string,
): Promise<{ store: ReturnType<typeof runStore>; outcome: RunOutcome }> {
    scriptedGitHub({ now: () => START, config: () => configFor("triageQueue", mode) });
    const store = runStore();
    const outcome = await runAction(run, {
        payload: capture("issues.opened.json").bytes(),
        store,
        clock: () => START,
        log: () => undefined,
    });
    return { store, outcome };
}

describe("the job summary", () => {
    it("names the repository, event and item, and lists the decision rows", async () => {
        const run = runOf();
        const { store, outcome } = await decided(run, "dry-run");
        const text = renderSummary(store, run, outcome);
        expect(text).toContain("scrubbed-1/scrubbed-2");
        expect(text).toContain("issues");
        expect(text).toContain("delivery");
        expect(text).toContain("issue#164");
        expect(text.match(/modeRecordsOnly/g)).toHaveLength(2);
        expect(text).not.toContain("dry-run because");
        expect(annotations(outcome)).toEqual([]);
        store.close();
    });

    it("says active was decided as dry-run when writes were not armed", async () => {
        const run = runOf({ armWrites: false });
        const { store, outcome } = await decided(run, "active");
        const text = renderSummary(store, run, outcome);
        expect(text).toContain("dry-run");
        expect(text).toContain("did not arm writes");
        expect(annotations(outcome)[0]).toMatch(/^::notice::/);
        expect(annotations(outcome)).toHaveLength(1);
        store.close();
    });

    it("closes with the event that made the run exit non-zero", async () => {
        const run = runOf({ repository: { owner: "other", repo: "place" } });
        const { store, outcome } = await decided(run, "dry-run");
        expect(outcome.exitCode).toBe(1);
        const text = renderSummary(store, run, outcome);
        expect(text).toContain("exited non-zero");
        expect(text).toContain("repositoryMismatch");
        const lines = annotations(outcome);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^::warning::deliveryCompleted \(repositoryMismatch\)/);
        store.close();
    });
});

describe("appendSummary", () => {
    it("writes nothing without a path and appends with one", () => {
        const dir = mkdtempSync(join(tmpdir(), "summary-"));
        try {
            const file = join(dir, "step-summary.md");
            writeFileSync(file, "first\n");
            appendSummary(undefined, "ignored\n");
            expect(readFileSync(file, "utf8")).toBe("first\n");
            appendSummary(file, "second\n");
            expect(readFileSync(file, "utf8")).toBe("first\nsecond\n");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
