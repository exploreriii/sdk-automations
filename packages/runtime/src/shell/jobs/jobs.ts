/**
 * The four jobs one tick runs, in order: hand back dead claims, resolve unclosed sends,
 * pump the delivery lane, fire any due sweep row (D172). It owns no timer — the
 * composition root's interval is what calls `tick()`.
 */

import type { Store } from "../../store/index.js";
import { EFFECT_LEASE_STALE_MINUTES, type Applier } from "../apply/apply.js";
import { STALE_CLAIM_MINUTES, type Deliveries } from "../inbound/deliveries.js";
import { detailOf, type Log } from "../log.js";
import type { Sweep } from "../sweep/sweep.js";

/** One named thing a tick does. */
export interface Job {
    readonly name: "requeueStale" | "recoverOpenSends" | "drain" | "fireDueSweeps";
    run(): Promise<void>;
}

/** The seams the four run against; the composition root fills every one. */
export interface JobsOptions {
    readonly store: Store;
    readonly deliveries: Deliveries;
    /** The fact sweep, when a composition has something to read GitHub with. */
    readonly sweep: Sweep | null;
    readonly clock: () => Date;
    /** The write path, when one is wired; with none, an open send is not even looked for. */
    readonly applier?: Applier;
    /** The installation switch (D171): the recovery pass does not run at all. */
    readonly suspended: boolean;
    readonly log: Log;
}

export interface Jobs {
    /** One tick: the four in order, contained, because a throw inside a timer callback takes the process down. */
    tick(): void;
    /** BOTH passes, because both hold a claim: the delivery lane's, and the sweep's row. */
    settled(): Promise<void>;
}

export function createJobs(options: JobsOptions): Jobs {
    const { store, deliveries, sweep, clock, suspended, log } = options;

    const requeueStale: Job = {
        name: "requeueStale",
        // Not `async`: the throw is the tick's to catch, before the three below start.
        run: () => {
            const staleBefore = new Date(clock().getTime() - STALE_CLAIM_MINUTES * 60_000);
            const requeued = store.inbox.requeueStuckDeliveries(staleBefore.toISOString());
            // A line every interval forever would bury the sweeps that requeued something.

            if (requeued.length > 0) {
                log({
                    event: "sweepRequeued",
                    requeued: requeued.length,
                    deliveryIds: requeued.map(String),
                });
            }
            return Promise.resolve();
        },
    };

    /**
     * The sends a worker made and never closed.
     * Every one is re-driven through the applier's dispatch, which reads GitHub before it resends, so a sweep can never turn a landed write into a second one.
     * Suspended, none of it runs: an open send stays open until the switch lifts (D171).
     */
    const recoverOpenSends: Job = {
        name: "recoverOpenSends",
        run: async () => {
            const applier = options.applier;
            if (applier === undefined || suspended) return;
            const before = new Date(clock().getTime() - EFFECT_LEASE_STALE_MINUTES * 60_000);
            const open = store.ledger.open(before.toISOString());
            if (open.length === 0) return;
            const config = await deliveries.configuration();
            if (config === null) return;
            for (const row of open) {
                try {
                    await applier.recover(row, config);
                } catch (error) {
                    log({
                        event: "sweepFailed",
                        detail: `effect "${row.effectId}" recovery failed: ${detailOf(error)}`,
                    });
                }
            }
        },
    };

    const drain: Job = { name: "drain", run: () => deliveries.drain() };

    const fireDueSweeps: Job = {
        name: "fireDueSweeps",
        run: () => sweep?.runDue() ?? Promise.resolve(),
    };

    return {
        tick: () => {
            try {
                void requeueStale.run();
            } catch (error) {
                log({ event: "sweepFailed", detail: detailOf(error) });
                return;
            }
            void recoverOpenSends.run().catch((error: unknown) => {
                log({ event: "sweepFailed", detail: detailOf(error) });
            });
            void drain.run().catch((error: unknown) => {
                log({ event: "drainFailed", phase: "sweep", detail: detailOf(error) });
            });
            // No `.catch`: `runDue` contains its own failures, and a rejection would also
            // reach `settled()`, where a shutdown awaiting it has nowhere to put it.

            void fireDueSweeps.run();
        },
        settled: async () => {
            await Promise.all([deliveries.settled(), sweep?.settled()]);
        },
    };
}
