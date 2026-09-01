/**
 * The worker half: claim a durable delivery, prepare, reject an unsupported
 * mode or call the one verb, then commit the outcome with completion. The
 * receiver acknowledged long ago; GitHub never observes retries here.
 *
 * The reading key: a claimed delivery always ends as exactly ONE of three
 * records — `configRejected`, `modeUnsupported`, or a decision — and there
 * is no fourth exit. The try/catch in `attemptNext` is routing, not
 * handling: any throw becomes a counted failed attempt, and the retry
 * policy above IS the recovery logic — a bounded, spaced reclaim, ending
 * in the store's dead letter when the budget runs out.
 *
 * `recordFor` below is stations ③ to ⑤ of this package's README table,
 * one named step per station.
 */

import {
    decide,
    parseConfigDocument,
    UNREADABLE_CONFIG_REVISION,
    type ConfigResult,
    type ConfigError,
    type Decision,
    type EngineCapability,
    type Report,
    type RepositoryConfig,
    type RepositoryRef,
} from "@hiero-hackers/automation-core";
import type {
    ClaimedDelivery,
    ReleaseDeliveryAfterFailureResult,
    Store,
} from "@hiero-hackers/automation-store";
import type { ConfigSource } from "./config.js";
import type { ExternalsForDelivery } from "./externals.js";

/**
 * A processing claim older than this is presumed dead and taken over.
 * Exported for the sweep in `shell.ts`, which requeues on the same clock.
 */
export const STALE_CLAIM_MINUTES = 15;

/**
 * The retry bounds. A delivery that keeps failing gets five attempts in
 * all, waiting 30s, 60s, 120s and 240s between them.
 *
 * Thirty seconds is longer than the blips this worker actually meets — a
 * config read that lost its token, externals answering unavailable — and
 * five attempts spread over about eight minutes outlast most of them
 * without holding a delivery for an afternoon. The hourly ceiling is a
 * bound on the doubling rather than a number this schedule reaches; it
 * only binds if the attempt budget is raised.
 */
const MAX_DELIVERY_ATTEMPTS = 5;
const RETRY_BASE_MS = 30_000;
const RETRY_CEILING_MS = 60 * 60_000;

/** The wait a delivery earns after `attempts` failures, doubling each time. */
function retryDelayMs(attempts: number): number {
    return Math.min(RETRY_BASE_MS * 2 ** attempts, RETRY_CEILING_MS);
}

/** Dependencies and operator hooks for one durable delivery worker. */
export interface ProcessorOptions {
    readonly store: Store;
    readonly capabilities: readonly EngineCapability[];
    readonly configSource: ConfigSource;
    readonly externals: ExternalsForDelivery;
    /**
     * The shell's routing knowledge (`DecideInput` asks for it): the one
     * repository this endpoint serves. When a payload is readable the
     * engine names the repository from the observation instead; this is
     * the name an unreadable delivery's report carries.
     */
    readonly repository: RepositoryRef;
    readonly worker: string;
    readonly clock: () => Date;
}

/** What every persisted record says about which delivery it answers. */
interface RecordIdentity {
    readonly deliveryId: string;
    readonly event: string;
    readonly receivedAt: string;
    readonly decidedAt: string;
    readonly configRevision: string;
}

/** The canonical shell record persisted for one delivery. */
type ShellRecord =
    | (RecordIdentity & {
          readonly kind: "decision";
          readonly report: Report;
      })
    | (RecordIdentity & {
          /** The config failed to parse. Fail-closed: nothing was decided. */
          readonly kind: "configRejected";
          readonly errors: readonly ConfigError[];
      })
    | (RecordIdentity & {
          /** The runnable shell has no external effect path. */
          readonly kind: "modeUnsupported";
          readonly reason: string;
      });

/**
 * Invalid JSON flows onward as an unreadable payload — the normalizer's
 * `payloadNotObject` names it in the report; the shell has no opinion.
 */
function parsePayload(bytes: Uint8Array): unknown {
    try {
        return JSON.parse(Buffer.from(bytes).toString("utf8"));
        // Stryker disable next-line BlockStatement: an emptied catch falls
        // through to the same implicit undefined — the mutant is equivalent.
    } catch {
        return undefined;
    }
}

/** What the worker exposes: one pass, or pump until the queue is empty. */
export interface Processor {
    processOnce(): Promise<boolean>;
    drain(): Promise<void>;
}

/**
 * What one claimed-and-carried delivery came to. The failure case is a
 * VALUE because the drain has to keep going after it, and needs to know
 * what the store made of the failure to decide whether it can.
 */
type PassOutcome =
    | { readonly kind: "idle" }
    | { readonly kind: "completed" }
    | {
          readonly kind: "failed";
          readonly deliveryId: string;
          readonly error: unknown;
          readonly release: ReleaseDeliveryAfterFailureResult;
      };

/** What the failure did to the delivery, for the line an operator reads. */
function dispositionOf(release: ReleaseDeliveryAfterFailureResult): string {
    switch (release.outcome) {
        case "retryScheduled":
            return `attempt ${String(release.attempts)} of ${String(MAX_DELIVERY_ATTEMPTS)}, retrying after ${release.retryNotBefore}`;
        case "deadLettered":
            return `attempt ${String(release.attempts)} of ${String(MAX_DELIVERY_ATTEMPTS)}, dead-lettered for inspection`;
        case "notOwned":
            return "the claim was already lost, so this attempt was not counted";
    }
}

export function createProcessor(options: ProcessorOptions): Processor {
    const { store, capabilities, configSource, externals, repository, worker, clock } = options;
    let draining: Promise<void> | null = null;

    const claimNext = (): ClaimedDelivery | undefined => {
        const now = clock();
        const staleBefore = new Date(now.getTime() - STALE_CLAIM_MINUTES * 60_000);
        return store.claimNextDelivery(worker, now.toISOString(), staleBefore.toISOString());
    };

    /** Station 4: fetch the text, parse it. Every rejection is a value —
     * nothing downstream ever sees a half-read configuration. */
    const loadConfig = async (): Promise<{
        readonly revision: string;
        readonly result: ConfigResult;
    }> => {
        const loaded = await configSource.load();
        if (!loaded.ok) {
            if (loaded.permanent) {
                // Fail closed and COMPLETE, exactly like a config that
                // parses wrong: redelivering cannot fix a defective file.
                return {
                    revision: loaded.revision ?? UNREADABLE_CONFIG_REVISION,
                    result: {
                        ok: false,
                        // documentUnparseable, not a new code: the error
                        // catalogue only admits codes a DOCUMENT can reach
                        // (D76's demonstration rule), and an unreadable file
                        // is the parse failure's upstream twin. The message
                        // carries which one it was.
                        errors: [
                            {
                                code: "documentUnparseable",
                                message: `unreadable before parsing: ${loaded.detail}`,
                                path: null,
                            },
                        ],
                    },
                };
            }
            // Transient: the throw costs the delivery one attempt and
            // schedules the next. A config that is unreachable for good
            // therefore dead-letters instead of retrying without end.
            throw new Error(`configuration unavailable: ${loaded.detail}`);
        }
        const { document } = loaded;
        return {
            revision: document.revision,
            result: parseConfigDocument(document.text, {
                revision: document.revision,
                knownCapabilities: capabilities.map((c) => c.declaration.name),
            }),
        };
    };

    const identityFor = (
        claimed: ClaimedDelivery,
        configRevision: string,
        decidedAt: Date,
    ): RecordIdentity => ({
        // The branded GUID becomes plain text here: records are JSON.
        deliveryId: String(claimed.deliveryId),
        event: claimed.eventName,
        receivedAt: claimed.receivedAt,
        decidedAt: decidedAt.toISOString(),
        configRevision,
    });

    /** Stations 5–10 live behind this one call: normalize, evaluate,
     * screen, derive the world, gate. The shell's contribution ends at
     * the parenthesis. */
    const decideOn = async (
        claimed: ClaimedDelivery,
        config: RepositoryConfig,
    ): Promise<Decision> => {
        const payload = parsePayload(claimed.payload);
        // Built per delivery: the live path binds its ordering-evidence
        // memo to exactly this delivery. A rejection here is a counted
        // failed attempt, like any other failure before completion.
        return decide(
            { kind: "delivery", repository, event: claimed.eventName, payload },
            config,
            capabilities,
            await externals({ payload }),
        );
    };

    /** Build one delivery's canonical record, stations ③ to ⑤ in reading order. */
    const recordFor = async (claimed: ClaimedDelivery): Promise<ShellRecord> => {
        const config = await loadConfig();
        // One instant serves as the record's `decidedAt` AND the gates'
        // clock, so the journal never disagrees with the decision it holds.
        const identity = identityFor(claimed, config.revision, clock());

        if (!config.result.ok) {
            // Fail closed and COMPLETE: redelivering cannot fix a broken
            // config — the fixed file arrives as its own future delivery.
            return { kind: "configRejected", ...identity, errors: config.result.errors };
        }
        if (config.result.config.mode === "active") {
            return {
                kind: "modeUnsupported",
                ...identity,
                reason: "active mode is unsupported by the runnable shell",
            };
        }
        const decision = await decideOn(claimed, config.result.config);
        return { kind: "decision", ...identity, report: decision.report };
    };

    /**
     * Count one failed attempt against this claim, which either spaces the
     * next one or ends the delivery as a dead letter. The wait is derived
     * from the attempts the claim arrived with, so a delivery that keeps
     * failing backs off instead of being re-claimed on every drain.
     */
    const recordFailure = (claimed: ClaimedDelivery): ReleaseDeliveryAfterFailureResult => {
        const failedAt = clock();
        return store.releaseDeliveryAfterFailure({
            deliveryId: claimed.deliveryId,
            claimToken: claimed.claimToken,
            failedAt: failedAt.toISOString(),
            retryNotBefore: new Date(
                failedAt.getTime() + retryDelayMs(claimed.attempts),
            ).toISOString(),
            maxAttempts: MAX_DELIVERY_ATTEMPTS,
        });
    };

    /**
     * Station 3 onward: claim, decide, then atomically persist-and-complete.
     * A failure before canonical completion is counted, not just released:
     * a delivery nothing can process spends its budget and dead-letters
     * rather than being retried forever.
     */
    const attemptNext = async (): Promise<PassOutcome> => {
        const claimed = claimNext();
        if (claimed === undefined) return { kind: "idle" };
        try {
            const record = await recordFor(claimed);
            const completion = store.completeDeliveryWithReport({
                deliveryId: claimed.deliveryId,
                eventName: claimed.eventName,
                payloadDigest: claimed.payloadDigest,
                claimToken: claimed.claimToken,
                reportJson: JSON.stringify(record),
                completedAt: clock().toISOString(),
            });
            if (completion.outcome !== "completed") {
                throw new Error(`delivery report was not committed: ${completion.outcome}`);
            }
            return { kind: "completed" };
        } catch (error) {
            return {
                kind: "failed",
                deliveryId: String(claimed.deliveryId),
                error,
                release: recordFailure(claimed),
            };
        }
    };

    return {
        /** One pass. A failed delivery still throws: the caller asked for it. */
        async processOnce(): Promise<boolean> {
            const outcome = await attemptNext();
            if (outcome.kind === "failed") throw outcome.error;
            return outcome.kind === "completed";
        },
        /**
         * Process until the queue is empty, stepping OVER a delivery that
         * failed: it is backed off or dead-lettered by then, so the queue
         * behind it moves. Overlapping calls share one loop.
         *
         * The one failure that ends the pass early is a lost claim. The
         * attempt went uncounted, so the same delivery can be handed back
         * immediately, and a loop that cannot prove progress should stop
         * rather than spin — the next drain starts from a fresh claim.
         */
        drain(): Promise<void> {
            draining ??= (async () => {
                try {
                    for (;;) {
                        const outcome = await attemptNext();
                        if (outcome.kind === "idle") return;
                        if (outcome.kind !== "failed") continue;
                        console.error(
                            `shell: delivery ${outcome.deliveryId} failed to process (${dispositionOf(outcome.release)})`,
                            outcome.error,
                        );
                        if (outcome.release.outcome === "notOwned") return;
                    }
                } finally {
                    draining = null;
                }
            })();
            return draining;
        },
    };
}
