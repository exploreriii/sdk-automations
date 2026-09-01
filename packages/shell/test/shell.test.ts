/**
 * The definition of done, executed: a delivery GitHub actually sent (the
 * captured, scrubbed issues.opened fixture) travels webhook → verify →
 * durable accept → 202 → parseConfigDocument → decide() → persisted
 * report, over a real socket, a real SQLite store, and a real config
 * file — with only GitHub itself absent. Dry-run: the report is the
 * product and active mode stops before the decision path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import {
    asDeliveryGuid,
    problems,
    signBody,
    toEngine,
    SIGNATURE_HEADER,
    type EngineCapability,
    type Report,
} from "@hiero-hackers/automation-core";
import { Store } from "@hiero-hackers/automation-store";
import { intake, prQuality } from "@hiero-hackers/automation-probes";
import { capture, useTempDir } from "@hiero-hackers/automation-testkit";
import { createShell, fileConfigSource, stubbedExternals, type Shell } from "../src/index.js";

const SECRET = "shell-test-secret";
const GUID = "83e4273f-dd89-22f4-92bc-5da478ed1a69";
const SECOND_GUID = "83e4273f-dd89-22f4-92bc-5da478ed1a6a";
const FIXTURE = capture("issues.opened.json").bytes();

const CONFIG = `schemaVersion: 1
mode: dry-run
capabilities:
  intake:
    enabled: true
    settings:
      announce: true
mappings:
  labels:
    awaitingTriage: "status: triage"
`;

const BASE = new Date("2026-08-07T10:00:00.000Z");

const temp = useTempDir("shell-test-");
let store: Store;
let configFile: string;
/** Every shell built here, so its sweep stops with the test that made it. */
let running: Shell[];

beforeEach(() => {
    configFile = temp.file("automations.yml");
    writeFileSync(configFile, CONFIG);
    store = new Store(temp.file("store.sqlite"));
    running = [];
});
afterEach(() => {
    for (const shell of running) shell.stopSweep();
    vi.restoreAllMocks();
    store.close();
});

function buildShell(
    capability: EngineCapability = toEngine(intake),
    sweepIntervalMs = 60_000,
): Shell {
    let tick = 0;
    const shell = createShell({
        secret: SECRET,
        store,
        capabilities: [capability],
        configSource: fileConfigSource(configFile),
        externals: () => stubbedExternals(),
        repository: { owner: "owner-sandbox", repo: "automation-sandbox" },
        clock: () => new Date(BASE.getTime() + 1000 * tick++),
        sweepIntervalMs,
    });
    running.push(shell);
    return shell;
}

async function deliver(shell: Shell, guid = GUID): Promise<number> {
    await new Promise<void>((resolve) => shell.server.listen(0, "127.0.0.1", resolve));
    try {
        const { port } = shell.server.address() as AddressInfo;
        const response = await fetch(`http://127.0.0.1:${String(port)}/`, {
            method: "POST",
            headers: {
                [SIGNATURE_HEADER]: signBody(SECRET, FIXTURE),
                "x-github-delivery": guid,
                "x-github-event": "issues",
            },
            body: FIXTURE,
        });
        await response.arrayBuffer();
        return response.status;
    } finally {
        await new Promise<void>((resolve, reject) =>
            shell.server.close((error) => (error ? reject(error) : resolve())),
        );
    }
}

interface RecordIdentity {
    readonly deliveryId: string;
    readonly event: string;
    readonly receivedAt: string;
    readonly decidedAt: string;
    readonly configRevision: string;
}

type StoredRecord = RecordIdentity &
    (
        | { readonly kind: "decision"; readonly report: Report }
        | { readonly kind: "configRejected"; readonly errors: readonly unknown[] }
        | { readonly kind: "modeUnsupported"; readonly reason: string }
    );

function records(): StoredRecord[] {
    return store.deliveryReports().map((report) => JSON.parse(report.reportJson) as StoredRecord);
}

describe("the first slice, end to end", () => {
    it("rejects duplicate direct capability names before returning a server", () => {
        const intakeCapability = toEngine(intake);
        const prQualityCapability = toEngine(prQuality);
        expect(() =>
            createShell({
                secret: SECRET,
                store,
                capabilities: [
                    intakeCapability,
                    intakeCapability,
                    prQualityCapability,
                    prQualityCapability,
                ],
                configSource: fileConfigSource(configFile),
                externals: () => stubbedExternals(),
                repository: { owner: "owner-sandbox", repo: "automation-sandbox" },
            }),
        ).toThrow(
            'invalid capability declarations: duplicate capability name "intake"; duplicate capability name "prQuality"',
        );
    });

    it("a real delivery becomes a persisted dry-run report", async () => {
        const shell = buildShell();
        expect(await deliver(shell)).toBe(202);
        await shell.drain();

        const [entry, ...rest] = records();
        expect(rest).toEqual([]);
        expect(entry).toMatchObject({
            kind: "decision",
            deliveryId: GUID,
            event: "issues",
        });
        if (entry?.kind !== "decision") throw new Error("expected a decision");
        expect(entry.report.mode).toBe("dry-run");
        // The engine named the repository from the payload, not our routing default.
        expect(entry.report.repository).toEqual({
            owner: "scrubbed-1",
            repo: "scrubbed-2",
        });
        expect(problems(entry.report as Report)).toEqual([]);
        expect(entry.report.findings.length).toBeGreaterThan(0);
        expect(entry).not.toHaveProperty("approved");
        expect(store.deliveryReports()).toEqual([
            expect.objectContaining({
                deliveryId: GUID,
                reportJson: JSON.stringify(entry),
            }),
        ]);
        // The queue is empty: the delivery completed.
        expect(
            store.claimNextDelivery(
                "assert",
                "2026-08-07T11:00:00.000Z",
                "2026-08-07T10:59:00.000Z",
            ),
        ).toBeUndefined();
    });

    it("rejects active mode canonically without deciding or retrying", async () => {
        writeFileSync(configFile, CONFIG.replace("mode: dry-run", "mode: active"));
        const capability = toEngine(intake);
        const shell = buildShell({
            ...capability,
            evaluate: async () => {
                throw new Error("active mode reached capability evaluation");
            },
        });
        expect(await deliver(shell)).toBe(202);
        await shell.drain();

        const [entry, ...rest] = records();
        expect(rest).toEqual([]);
        expect(entry).toMatchObject({
            kind: "modeUnsupported",
            deliveryId: GUID,
            event: "issues",
            reason: "active mode is unsupported by the runnable shell",
        });
        expect(entry).not.toHaveProperty("report");
        expect(entry).not.toHaveProperty("approved");
        expect(JSON.stringify(entry)).not.toContain("applied");
        expect(store.deliveryReports()).toEqual([
            expect.objectContaining({ reportJson: JSON.stringify(entry) }),
        ]);
        expect(
            store.claimNextDelivery(
                "assert",
                "2026-08-07T11:00:00.000Z",
                "2026-08-07T10:59:00.000Z",
            ),
        ).toBeUndefined();

        expect(await deliver(shell)).toBe(202);
        await shell.drain();
        expect(records()).toHaveLength(1);
    });

    it("a process restart observes the committed canonical report", async () => {
        const shell = buildShell();
        expect(await deliver(shell)).toBe(202);
        await shell.drain();
        const committed = store.deliveryReports();

        store.close();
        store = new Store(temp.file("store.sqlite"));

        expect(store.deliveryReports()).toEqual(committed);
        expect(records()).toHaveLength(1);
    });

    it("startup draining recovers a pending delivery after restart", async () => {
        expect(
            store.acceptDelivery({
                deliveryId: asDeliveryGuid(SECOND_GUID)!,
                eventName: "issues",
                payload: FIXTURE,
                receivedAt: BASE.toISOString(),
            }),
        ).toMatchObject({ outcome: "accepted", state: "pending" });
        store.close();
        store = new Store(temp.file("store.sqlite"));

        const shell = buildShell();
        await shell.drain();

        expect(records()).toEqual([
            expect.objectContaining({
                kind: "decision",
                deliveryId: SECOND_GUID,
            }),
        ]);
        expect(
            store.claimNextDelivery(
                "assert",
                "2026-08-07T11:00:00.000Z",
                "2026-08-07T10:59:00.000Z",
            ),
        ).toBeUndefined();
    });

    it("starts durable processing after the acknowledgment without a manual drain", async () => {
        const shell = buildShell();
        expect(await deliver(shell)).toBe(202);
        await vi.waitFor(() => expect(records()).toHaveLength(1));
    });

    it("sweeps a dead worker's claim back into a drain with no delivery to wake it", async () => {
        expect(
            store.acceptDelivery({
                deliveryId: asDeliveryGuid(SECOND_GUID)!,
                eventName: "issues",
                payload: FIXTURE,
                receivedAt: BASE.toISOString(),
            }),
        ).toMatchObject({ outcome: "accepted" });
        // A worker that died twenty minutes ago still holds the claim, and
        // in a quiet repository nothing else will ever arrive to drain it.
        expect(
            store.claimNextDelivery(
                "dead-worker",
                new Date(BASE.getTime() - 20 * 60_000).toISOString(),
                new Date(BASE.getTime() - 60 * 60_000).toISOString(),
            ),
        ).toBeDefined();

        buildShell(toEngine(intake), 5);
        await vi.waitFor(() => expect(records()).toHaveLength(1));
        expect(records()[0]).toMatchObject({ kind: "decision", deliveryId: SECOND_GUID });
    });

    it("reports a sweep it cannot run instead of taking the process down", async () => {
        // A closed store is the sweep's worst case: a throw inside a timer
        // callback is an unhandled exception, and this shell keeps serving.
        const doomed = new Store(temp.file("doomed.sqlite"));
        const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
        running.push(
            createShell({
                secret: SECRET,
                store: doomed,
                capabilities: [toEngine(intake)],
                configSource: fileConfigSource(configFile),
                externals: () => stubbedExternals(),
                repository: { owner: "owner-sandbox", repo: "automation-sandbox" },
                sweepIntervalMs: 5,
            }),
        );
        doomed.close();

        await vi.waitFor(() =>
            expect(reported).toHaveBeenCalledWith(
                "shell: sweep failed; inspect durable store state",
                expect.anything(),
            ),
        );
    });

    it("a broken config fails closed: recorded, completed, nothing decided", async () => {
        writeFileSync(configFile, "mode: [unclosed\n");
        const shell = buildShell();
        expect(await deliver(shell)).toBe(202);
        await shell.drain();

        const [entry] = records();
        expect(entry?.kind).toBe("configRejected");
        if (entry?.kind !== "configRejected") throw new Error("expected rejection");
        expect(entry.errors.length).toBeGreaterThan(0);
        expect(
            store.claimNextDelivery(
                "assert",
                "2026-08-07T11:00:00.000Z",
                "2026-08-07T10:59:00.000Z",
            ),
        ).toBeUndefined();
    });

    it("an absent config file decides in observe mode, like an empty one", async () => {
        rmSync(configFile);
        const shell = buildShell();
        expect(await deliver(shell)).toBe(202);
        await shell.drain();

        const [entry] = records();
        if (entry?.kind !== "decision") throw new Error("expected a decision");
        expect(entry.report.mode).toBe("observe");
        expect(entry.configRevision).toBe("sha256:absent");
    });
});
