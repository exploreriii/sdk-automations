/**
 * The worker's failure honesty: a crash mid-decision COUNTS an attempt —
 * the delivery stays durable, waits out a widening backoff, and is
 * eventually dead-lettered rather than retried forever — and a completed
 * delivery never runs twice. The receiver acknowledged long before any of
 * this; GitHub is not watching.
 *
 * Failures here are injected through the externals seam, which is the one
 * this worker actually meets (`live externals unavailable`) and the one
 * whose throw the processor sees: a capability that throws is contained by
 * `decide()` and reported, never raised.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asDeliveryGuid, toEngine, type EngineCapability } from "@hiero-hackers/automation-core";
import { Store } from "@hiero-hackers/automation-store";
import { intake, intakeDeclaration } from "@hiero-hackers/automation-probes";
import { capture, useTempDir } from "@hiero-hackers/automation-testkit";
import { createProcessor } from "../src/processor.js";
import { stubbedExternals } from "../src/externals.js";
import type { ConfigSource } from "../src/config.js";

const GUID = asDeliveryGuid("94f5384a-ee9a-33a5-a3cd-6eb589fe2b7a")!;
const SECOND_GUID = asDeliveryGuid("94f5384a-ee9a-33a5-a3cd-6eb589fe2b7b")!;
const FIXTURE = capture("issues.opened.json").bytes();

const CONFIG_TEXT = `schemaVersion: 1
mode: dry-run
capabilities:
  intake:
    enabled: true
    settings:
      announce: false
`;
const configSource: ConfigSource = {
    load: async () => ({ ok: true, document: { revision: "rev-test-1", text: CONFIG_TEXT } }),
};

const BASE = new Date("2026-08-07T10:00:00.000Z");

const temp = useTempDir("shell-processor-");
let store: Store;
beforeEach(() => {
    store = new Store(temp.file("store.sqlite"));
    store.acceptDelivery({
        deliveryId: GUID,
        eventName: "issues",
        payload: FIXTURE,
        receivedAt: BASE.toISOString(),
    });
});
afterEach(() => {
    store.close();
});

function processor(capability: EngineCapability, firstTickMs = 1_000) {
    let tick = 0;
    return createProcessor({
        store,
        capabilities: [capability],
        configSource,
        externals: () => stubbedExternals(),
        repository: { owner: "owner-sandbox", repo: "automation-sandbox" },
        worker: "test-worker",
        clock: () => new Date(BASE.getTime() + firstTickMs + 1000 * tick++),
    });
}

function records(): Record<string, unknown>[] {
    return store
        .deliveryReports()
        .map((report) => JSON.parse(report.reportJson) as Record<string, unknown>);
}

describe("a config source that cannot answer", () => {
    const withSource = (load: ConfigSource["load"], atMs = 1000) =>
        createProcessor({
            store,
            capabilities: [toEngine(intake)],
            configSource: { load },
            externals: () => stubbedExternals(),
            repository: { owner: "owner-sandbox", repo: "automation-sandbox" },
            worker: "test-worker",
            clock: () => new Date(BASE.getTime() + atMs),
        });

    it("completes a permanent defect as configRejected — retrying cannot fix a file", async () => {
        const wedged = withSource(async () => ({
            ok: false,
            permanent: true,
            detail: "the config file is not valid UTF-8",
            revision: "deadbeef",
        }));

        expect(await wedged.processOnce()).toBe(true);
        expect(records()).toEqual([
            expect.objectContaining({
                kind: "configRejected",
                configRevision: "deadbeef",
                errors: [expect.objectContaining({ code: "documentUnparseable" })],
            }),
        ]);
    });

    it("spends an attempt on a transient failure instead of retrying at once", async () => {
        const failing = withSource(async () => ({
            ok: false,
            permanent: false,
            detail: "config read failed: transient",
        }));

        await expect(failing.processOnce()).rejects.toThrow("configuration unavailable");
        expect(records()).toEqual([]);

        // The deliberate change: transient config failures are counted, so a
        // config that is unreachable for good cannot spin the queue forever.
        expect(await withSource(configSource.load, 30_999).processOnce()).toBe(false);
        expect(await withSource(configSource.load, 31_000).processOnce()).toBe(true);
        expect(records()).toHaveLength(1);
    });
});

describe("a crash counts an attempt", () => {
    it("the delivery survives its processor and is retried once its wait is up", async () => {
        const failing = createProcessor({
            store,
            capabilities: [toEngine(intake)],
            configSource,
            externals: () => {
                throw new Error("live externals unavailable");
            },
            repository: { owner: "owner-sandbox", repo: "automation-sandbox" },
            worker: "test-worker",
            clock: () => new Date(BASE.getTime() + 1000),
        });
        await expect(failing.processOnce()).rejects.toThrow("live externals unavailable");
        expect(records()).toEqual([]);

        // Durable but waiting: the attempt bought thirty seconds, and the
        // millisecond before them claims nothing.
        expect(await processor(toEngine(intake), 30_999).processOnce()).toBe(false);
        expect(await processor(toEngine(intake), 31_000).processOnce()).toBe(true);
        expect(records()).toEqual([
            expect.objectContaining({
                kind: "decision",
                deliveryId: GUID as string,
                configRevision: "rev-test-1",
            }),
        ]);
    });

    it("hands the externals factory the delivery's parsed payload", async () => {
        // The live path derives its cause fingerprint from this argument;
        // a processor that stopped passing it would break exclusion quietly.
        const seen: unknown[] = [];
        const observing = createProcessor({
            store,
            capabilities: [toEngine(intake)],
            configSource,
            externals: (delivery) => {
                seen.push(delivery.payload);
                return stubbedExternals();
            },
            repository: { owner: "owner-sandbox", repo: "automation-sandbox" },
            worker: "test-worker",
            clock: () => new Date(BASE.getTime() + 1000),
        });

        expect(await observing.processOnce()).toBe(true);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ action: expect.any(String) });
    });

    it("an empty queue reports itself instead of pretending to work", async () => {
        const healthy = processor(toEngine(intake));
        expect(await healthy.processOnce()).toBe(true);
        expect(await healthy.processOnce()).toBe(false);
        expect(records()).toHaveLength(1);
    });

    it("does not steal a fresh claim but takes over after the 15-minute lease", async () => {
        expect(
            store.claimNextDelivery(
                "stalled-worker",
                new Date(BASE.getTime() + 60_000).toISOString(),
                new Date(BASE.getTime() - 60_000).toISOString(),
            ),
        ).toBeDefined();

        const fresh = processor(toEngine(intake), 10 * 60_000);
        expect(await fresh.processOnce()).toBe(false);
        expect(records()).toEqual([]);

        const stale = processor(toEngine(intake), 16 * 60_000);
        expect(await stale.processOnce()).toBe(true);
        expect(records()).toHaveLength(1);
    });

    it("starts a new drain after the previous queue became empty", async () => {
        const healthy = processor(toEngine(intake));
        await healthy.drain();
        expect(records()).toHaveLength(1);

        store.acceptDelivery({
            deliveryId: SECOND_GUID,
            eventName: "issues",
            payload: FIXTURE,
            receivedAt: new Date(BASE.getTime() + 10_000).toISOString(),
        });
        await healthy.drain();
        expect(records()).toHaveLength(2);
    });

    it("does not persist or complete after its delivery claim is released", async () => {
        const lostClaim: EngineCapability = {
            declaration: intakeDeclaration,
            evaluate: async () => {
                expect(store.requeueStuckDeliveries("2026-08-07T10:00:01.000Z")).toEqual([GUID]);
                return [];
            },
        };
        const candidate = processor(lostClaim);

        await expect(candidate.processOnce()).rejects.toThrow(
            "delivery report was not committed: notOwned",
        );
        expect(records()).toEqual([]);
        expect(
            store.claimNextDelivery(
                "next-worker",
                "2026-08-07T10:01:00.000Z",
                "2026-08-07T09:00:00.000Z",
            ),
        ).toBeDefined();
    });

    it("ends the drain on a lost claim rather than spinning on the same delivery", async () => {
        // Requeued mid-decision, the delivery is claimable again at once and
        // the failed attempt cannot be counted against it. A drain that kept
        // going would re-claim it forever, so this test hangs if it does.
        const lostClaim: EngineCapability = {
            declaration: intakeDeclaration,
            evaluate: async () => {
                store.requeueStuckDeliveries("2026-08-07T10:30:00.000Z");
                return [];
            },
        };
        await processor(lostClaim).drain();

        expect(records()).toEqual([]);
        expect(
            store.claimNextDelivery(
                "next-worker",
                "2026-08-07T10:01:00.000Z",
                "2026-08-07T09:00:00.000Z",
            ),
        ).toMatchObject({ attempts: 0 });
    });
});

describe("a poison delivery", () => {
    /** A payload the externals seam below is willing to answer for. */
    const HEALTHY = Buffer.from(JSON.stringify({ action: "healthy" }));
    let consulted = 0;

    /** One whole drain at one instant, failing everything but HEALTHY. */
    async function drainAt(offsetMs: number): Promise<void> {
        await createProcessor({
            store,
            capabilities: [toEngine(intake)],
            configSource,
            externals: ({ payload }) => {
                consulted++;
                if ((payload as { action?: unknown }).action === "healthy") {
                    return stubbedExternals();
                }
                throw new Error("live externals unavailable");
            },
            repository: { owner: "owner-sandbox", repo: "automation-sandbox" },
            worker: "test-worker",
            clock: () => new Date(BASE.getTime() + offsetMs),
        }).drain();
    }

    beforeEach(() => {
        consulted = 0;
        store.acceptDelivery({
            deliveryId: SECOND_GUID,
            eventName: "issues",
            payload: HEALTHY,
            receivedAt: new Date(BASE.getTime() + 1000).toISOString(),
        });
    });

    it("backs off, lets the queue behind it through, and dead-letters at five attempts", async () => {
        // The poison delivery is the OLDEST, so the queue behind it only
        // moves if a failed drain steps over it instead of unwinding.
        await drainAt(10_000);
        expect(consulted).toBe(2);
        expect(records()).toEqual([expect.objectContaining({ deliveryId: SECOND_GUID as string })]);

        // Thirty seconds, then sixty: the wait doubles per spent attempt,
        // and neither is served a millisecond early.
        consulted = 0;
        await drainAt(39_999);
        expect(consulted).toBe(0);
        await drainAt(40_000);
        await drainAt(99_999);
        expect(consulted).toBe(1);

        // Attempts three, four and five, at 100s, 220s and 460s.
        await drainAt(100_000);
        await drainAt(220_000);
        await drainAt(460_000);
        expect(consulted).toBe(4);

        expect(store.deadLetteredDeliveries()).toEqual([
            expect.objectContaining({
                deliveryId: GUID,
                eventName: "issues",
                receivedAt: BASE.toISOString(),
                attempts: 5,
                failedAt: new Date(BASE.getTime() + 460_000).toISOString(),
            }),
        ]);

        // Inspectable, and claimed by nothing however long it waits.
        consulted = 0;
        await drainAt(24 * 60 * 60_000);
        expect(consulted).toBe(0);
        expect(records()).toHaveLength(1);
    });
});
