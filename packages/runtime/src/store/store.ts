/**
 * The owned operational store — `design/findings/storage-decision.md` made real,
 * with the exact crash semantics protocol 6.5 demonstrated. Ratification pending.
 * This file owns the state transitions. Tables have no foreign keys, and delivery
 * acceptance and report completion use explicit synchronous transactions, so a
 * returned outcome always describes committed rows.
 */

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { asDeliveryGuid, type DeliveryGuid } from "@hiero-hackers/automation-core";
import { assertUtcInstant } from "./instants.js";
import {
    assertSupportedStorageSchemaVersion,
    migrateStorageSchema,
    readStorageSchemaVersion,
    type MigrationFaultPoint,
} from "./schema.js";
import type {
    AcceptDeliveryInput,
    AcceptDeliveryResult,
    CanonicalDeliveryReport,
    ClaimedDelivery,
    CompleteDeliveryWithReportInput,
    CompleteDeliveryWithReportResult,
    DeadLetteredDelivery,
    DeliveryState,
    ReleaseDeliveryAfterFailureInput,
    ReleaseDeliveryAfterFailureResult,
    ReleaseDeliveryResult,
} from "./deliveries.js";
import { Ledger } from "./ledger.js";
import type { ClaimedScheduleRow, ScheduleRow } from "./schedules.js";

/** A deliberate interruption point in schema or delivery durability work. */
export type StoreFaultPoint =
    | MigrationFaultPoint
    | "finalize:reportPersisted"
    | "finalize:deliveryCompleted"
    | "finalize:committed";

/** Optional dependencies for deterministic durability fault injection. */
export interface StoreOptions {
    readonly injectFault?: (point: StoreFaultPoint) => void;
}

function assertDeliveryGuid(value: DeliveryGuid): void {
    if (asDeliveryGuid(value) === undefined) {
        throw new TypeError("deliveryId must be a valid GitHub delivery GUID");
    }
}

function assertNonEmpty(value: string, param: string): void {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new TypeError(`${param} must be a non-empty string`);
    }
}

function assertPayload(value: Uint8Array): void {
    if (!(value instanceof Uint8Array)) {
        throw new TypeError("payload must be bytes");
    }
}

function assertPayloadDigest(value: string): void {
    if (value.length !== 64 || !/^[a-f0-9]+$/.test(value)) {
        throw new TypeError("payloadDigest must be a lowercase SHA-256 digest");
    }
}

function assertAttemptCap(value: number): void {
    if (!Number.isInteger(value) || value < 1) {
        throw new TypeError("maxAttempts must be a positive integer");
    }
}

function assertReportJson(value: string): void {
    let parsed: unknown = null;
    try {
        parsed = JSON.parse(value);
    } catch {}
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new TypeError("reportJson must be a JSON object");
    }
}

function payloadDigest(payload: Uint8Array): string {
    return createHash("sha256").update(payload).digest("hex");
}

interface StoredDeliveryIdentity {
    readonly event_name: string;
    readonly payload_digest: string;
    readonly state: DeliveryState;
}

interface ClaimedDeliveryRow {
    readonly delivery_id: string;
    readonly event_name: string;
    readonly payload: Uint8Array;
    readonly payload_digest: string;
    readonly received_at: string;
    readonly claim_token: string;
    readonly attempts: number;
}

interface FailedAttemptRow {
    readonly state: DeliveryState;
    readonly attempts: number;
    readonly retry_not_before: string | null;
}

interface DeadLetteredDeliveryRow {
    readonly delivery_id: string;
    readonly event_name: string;
    readonly payload_digest: string;
    readonly received_at: string;
    readonly attempts: number;
    readonly completed_at: string;
}

interface DeliveryFinalizationRow {
    readonly event_name: string;
    readonly payload_digest: string;
    readonly state: DeliveryState;
    readonly claim_token: string | null;
}

interface StoredReportRow {
    readonly claim_token: string;
    readonly report_json: string;
}

interface CanonicalDeliveryReportRow {
    readonly delivery_id: string;
    readonly report_json: string;
    readonly completed_at: string;
}

/** The synchronous durable operational-state boundary. */
export class Store {
    private readonly db: DatabaseSync;
    private readonly injectFault: (point: StoreFaultPoint) => void;
    /** The append-only half of the same file, over the same connection (D164). */
    readonly ledger: Ledger;

    constructor(path: string, options: StoreOptions = {}) {
        this.db = new DatabaseSync(path);
        this.injectFault = options.injectFault ?? (() => {});
        try {
            const schemaVersion = readStorageSchemaVersion(this.db);
            assertSupportedStorageSchemaVersion(schemaVersion);
            // These two pragmas ARE the crash model, set explicitly rather than
            // inherited: DELETE-mode journal plus synchronous FULL is what makes
            // "everything before the last returned call survives kill -9" true.

            this.db.exec(`
                PRAGMA busy_timeout = 2000;
                PRAGMA journal_mode = DELETE;
                PRAGMA synchronous = FULL;
            `);
            migrateStorageSchema(this.db, this.injectFault);
        } catch (error) {
            // Stryker disable next-line BlockStatement,CallExpression: an unclosed handle on the failure path leaks a file descriptor, which no black-box assertion can observe from outside the class — the close is resource hygiene, not visible behavior.
            try {
                this.db.close();
            } catch {
                // Preserve the initialization error.
            }
            throw error;
        }
        this.ledger = new Ledger(this.db);
    }

    // ── Durable webhook intake ─────────────────────────────────────

    /**
     * Atomically persist a verified delivery's identity and exact bytes before a
     * receiver acknowledges it. Neither a duplicate nor a conflict mutates the first.
     */
    acceptDelivery(input: AcceptDeliveryInput): AcceptDeliveryResult {
        assertDeliveryGuid(input.deliveryId);
        assertNonEmpty(input.eventName, "eventName");
        assertPayload(input.payload);
        assertUtcInstant(input.receivedAt, "receivedAt");

        const digest = payloadDigest(input.payload);
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const inserted = this.db
                .prepare(
                    `
                    INSERT INTO seen_delivery (
                        delivery_id, event_name, payload, payload_digest,
                        received_at, state, claim_worker, claim_token,
                        claimed_at, completed_at, attempts, retry_not_before
                    ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, 0, NULL)
                    ON CONFLICT(delivery_id) DO NOTHING
                `,
                )
                .run(input.deliveryId, input.eventName, input.payload, digest, input.receivedAt);

            let result: AcceptDeliveryResult;
            if (inserted.changes === 1) {
                result = {
                    outcome: "accepted",
                    state: "pending",
                    payloadDigest: digest,
                };
            } else {
                const existing = this.db
                    .prepare(
                        `
                        SELECT event_name, payload_digest, state
                        FROM seen_delivery
                        WHERE delivery_id = ?
                    `,
                    )
                    .get(input.deliveryId) as unknown as StoredDeliveryIdentity;

                const eventNameMismatch = existing.event_name !== input.eventName;
                const payloadMismatch = existing.payload_digest !== digest;
                result =
                    eventNameMismatch || payloadMismatch
                        ? {
                              outcome: "conflict",
                              state: existing.state,
                              eventNameMismatch,
                              payloadMismatch,
                          }
                        : {
                              outcome: "duplicate",
                              state: existing.state,
                              payloadDigest: existing.payload_digest,
                          };
            }

            this.db.exec("COMMIT");
            return result;
        } catch (error) {
            try {
                this.db.exec("ROLLBACK");
            } catch {
                // Preserve the operation's original error.
            }
            throw error;
        }
    }

    /**
     * Claim the oldest ELIGIBLE delivery, or atomically take over one stale claim.
     * The generated token, not the worker name, proves ownership. Eligibility skips a row waiting out a backoff and a dead-lettered one, inside the claiming statement.
     */
    claimNextDelivery(
        worker: string,
        now: string,
        staleBefore: string,
    ): ClaimedDelivery | undefined {
        assertNonEmpty(worker, "worker");
        assertUtcInstant(now, "now");
        assertUtcInstant(staleBefore, "staleBefore");
        const row = this.db
            .prepare(
                `
                UPDATE seen_delivery
                SET state = 'processing',
                    claim_worker = ?,
                    claim_token = lower(hex(randomblob(32))),
                    claimed_at = ?,
                    retry_not_before = NULL
                WHERE delivery_id = (
                    SELECT delivery_id
                    FROM seen_delivery
                    WHERE (state = 'pending'
                            AND (retry_not_before IS NULL OR retry_not_before <= ?))
                       OR (state = 'processing' AND claimed_at <= ?)
                    ORDER BY received_at, delivery_id
                    LIMIT 1
                )
                RETURNING delivery_id, event_name, payload, payload_digest,
                          received_at, claim_token, attempts
            `,
            )
            .get(worker, now, now, staleBefore) as ClaimedDeliveryRow | undefined;
        if (row === undefined) return undefined;
        return {
            deliveryId: row.delivery_id as DeliveryGuid,
            eventName: row.event_name,
            payload: Buffer.from(row.payload),
            payloadDigest: row.payload_digest,
            receivedAt: row.received_at,
            worker,
            claimedAt: now,
            claimToken: row.claim_token,
            attempts: row.attempts,
        };
    }

    /** Persist one canonical report and complete only its current delivery claim. */
    completeDeliveryWithReport(
        input: CompleteDeliveryWithReportInput,
    ): CompleteDeliveryWithReportResult {
        assertDeliveryGuid(input.deliveryId);
        assertNonEmpty(input.eventName, "eventName");
        assertPayloadDigest(input.payloadDigest);
        assertNonEmpty(input.claimToken, "claimToken");
        assertReportJson(input.reportJson);
        assertUtcInstant(input.completedAt, "completedAt");

        this.db.exec("BEGIN IMMEDIATE");
        try {
            const delivery = this.db
                .prepare(
                    `
                SELECT event_name, payload_digest, state, claim_token
                FROM seen_delivery
                WHERE delivery_id = ?
            `,
                )
                .get(input.deliveryId) as DeliveryFinalizationRow | undefined;

            if (
                delivery === undefined ||
                delivery.event_name !== input.eventName ||
                delivery.payload_digest !== input.payloadDigest
            ) {
                this.db.exec("ROLLBACK");
                return { outcome: "identityMismatch" };
            }

            const storedReport = this.db
                .prepare(
                    `
                SELECT claim_token, report_json
                FROM delivery_report
                WHERE delivery_id = ?
            `,
                )
                .get(input.deliveryId) as StoredReportRow | undefined;

            if (delivery.state === "done") {
                this.db.exec("ROLLBACK");
                if (storedReport === undefined || storedReport.claim_token !== input.claimToken) {
                    return { outcome: "notOwned" };
                }
                return storedReport.report_json === input.reportJson
                    ? { outcome: "alreadyCompleted" }
                    : { outcome: "reportConflict" };
            }

            if (delivery.claim_token !== input.claimToken) {
                this.db.exec("ROLLBACK");
                return { outcome: "notOwned" };
            }
            if (storedReport !== undefined) {
                this.db.exec("ROLLBACK");
                return { outcome: "reportConflict" };
            }

            this.db
                .prepare(
                    `
                INSERT INTO delivery_report (
                    delivery_id, claim_token, report_json, completed_at
                ) VALUES (?, ?, ?, ?)
            `,
                )
                .run(input.deliveryId, input.claimToken, input.reportJson, input.completedAt);
            this.injectFault("finalize:reportPersisted");

            const completed = this.db
                .prepare(
                    `
                UPDATE seen_delivery
                SET state = 'done', payload = NULL, claim_worker = NULL,
                    claim_token = NULL, claimed_at = NULL, completed_at = ?
                WHERE delivery_id = ? AND event_name = ? AND payload_digest = ?
                  AND state = 'processing' AND claim_token = ?
            `,
                )
                .run(
                    input.completedAt,
                    input.deliveryId,
                    input.eventName,
                    input.payloadDigest,
                    input.claimToken,
                );
            if (completed.changes !== 1) {
                throw new Error("delivery ownership changed under its write transaction");
            }
            this.injectFault("finalize:deliveryCompleted");

            this.db.exec("COMMIT");
            this.injectFault("finalize:committed");
            return { outcome: "completed" };
        } catch (error) {
            try {
                this.db.exec("ROLLBACK");
            } catch {
                // Preserve the operation's original failure.
            }
            throw error;
        }
    }

    /** Return only this token's in-flight work to the pending queue. */
    releaseDelivery(deliveryId: DeliveryGuid, claimToken: string): ReleaseDeliveryResult {
        assertDeliveryGuid(deliveryId);
        assertNonEmpty(claimToken, "claimToken");
        const result = this.db
            .prepare(
                `
                UPDATE seen_delivery
                SET state = 'pending', claim_worker = NULL,
                    claim_token = NULL, claimed_at = NULL
                WHERE delivery_id = ? AND state = 'processing' AND claim_token = ?
            `,
            )
            .run(deliveryId, claimToken);
        return result.changes === 1 ? { outcome: "released" } : { outcome: "notOwned" };
    }

    /**
     * Count one failed attempt, then either schedule the retry or dead-letter it — one
     * statement, so the count and the state it decides can never disagree. The cap is compared against the INCREMENTED count, and is a parameter: the store owns no policy.
     */
    releaseDeliveryAfterFailure(
        input: ReleaseDeliveryAfterFailureInput,
    ): ReleaseDeliveryAfterFailureResult {
        assertDeliveryGuid(input.deliveryId);
        assertNonEmpty(input.claimToken, "claimToken");
        assertUtcInstant(input.failedAt, "failedAt");
        assertUtcInstant(input.retryNotBefore, "retryNotBefore");
        assertAttemptCap(input.maxAttempts);

        const row = this.db
            .prepare(
                `
                UPDATE seen_delivery
                SET attempts = attempts + 1,
                    claim_worker = NULL,
                    claim_token = NULL,
                    claimed_at = NULL,
                    state = CASE WHEN attempts + 1 >= $cap THEN 'failed' ELSE 'pending' END,
                    completed_at = CASE WHEN attempts + 1 >= $cap THEN $failedAt ELSE NULL END,
                    retry_not_before =
                        CASE WHEN attempts + 1 >= $cap THEN NULL ELSE $retryNotBefore END
                WHERE delivery_id = $deliveryId
                  AND state = 'processing'
                  AND claim_token = $claimToken
                RETURNING state, attempts, retry_not_before
            `,
            )
            .get({
                $cap: input.maxAttempts,
                $failedAt: input.failedAt,
                $retryNotBefore: input.retryNotBefore,
                $deliveryId: input.deliveryId,
                $claimToken: input.claimToken,
            }) as FailedAttemptRow | undefined;

        if (row === undefined) return { outcome: "notOwned" };
        if (row.state === "failed") {
            return { outcome: "deadLettered", attempts: row.attempts };
        }
        return {
            outcome: "retryScheduled",
            attempts: row.attempts,
            retryNotBefore: input.retryNotBefore,
        };
    }

    /**
     * Every dead-lettered delivery, in stable dead-letter then GUID order.
     * Identity and attempt count only; the payload leaves the store through a claim.
     */
    deadLetteredDeliveries(): DeadLetteredDelivery[] {
        const rows = this.db
            .prepare(
                `
                SELECT delivery_id, event_name, payload_digest, received_at,
                       attempts, completed_at
                FROM seen_delivery
                WHERE state = 'failed'
                ORDER BY completed_at, delivery_id
            `,
            )
            .all() as unknown as DeadLetteredDeliveryRow[];
        return rows.map((row) => ({
            deliveryId: row.delivery_id as DeliveryGuid,
            eventName: row.event_name,
            payloadDigest: row.payload_digest,
            receivedAt: row.received_at,
            attempts: row.attempts,
            failedAt: row.completed_at,
        }));
    }

    redriveDelivery(deliveryId: DeliveryGuid): boolean {
        assertDeliveryGuid(deliveryId);
        return (
            this.db
                .prepare(
                    `
                    UPDATE seen_delivery
                    SET state = 'pending', claim_worker = NULL, claim_token = NULL,
                        claimed_at = NULL, completed_at = NULL, attempts = 0,
                        retry_not_before = NULL
                    WHERE delivery_id = ? AND state = 'failed'
                `,
                )
                .run(deliveryId).changes === 1
        );
    }

    /** Requeue stale processing rows without exposing their payloads. */
    requeueStuckDeliveries(claimedBefore: string): DeliveryGuid[] {
        assertUtcInstant(claimedBefore, "claimedBefore");
        const rows = this.db
            .prepare(
                `
                UPDATE seen_delivery
                SET state = 'pending', claim_worker = NULL,
                    claim_token = NULL, claimed_at = NULL
                WHERE state = 'processing' AND claimed_at <= ?
                RETURNING delivery_id
            `,
            )
            .all(claimedBefore) as { delivery_id: string }[];
        return (
            rows
                .map((row) => row.delivery_id as DeliveryGuid)
                // Default sort is UTF-16 code-unit order, which for these lowercase-hex
                // GUIDs IS SQLite's BINARY collation; a locale comparator can disagree.

                .sort()
        );
    }

    /** Read canonical reports in deterministic completion and delivery order. */
    deliveryReports(): CanonicalDeliveryReport[] {
        const rows = this.db
            .prepare(
                `
                SELECT delivery_id, report_json, completed_at
                FROM delivery_report
                ORDER BY completed_at, delivery_id
            `,
            )
            .all() as unknown as CanonicalDeliveryReportRow[];
        return rows.map((row) => ({
            deliveryId: row.delivery_id as DeliveryGuid,
            reportJson: row.report_json,
            completedAt: row.completed_at,
        }));
    }

    // ── Claims (lock) ───────────────────────────────────────────────

    /**
     * One-winner LEASE on an effect, with atomic stale takeover so a crashed holder
     * cannot deadlock it. Non-contention failures throw, so `false` strictly means a live worker holds it. A lease can still be stolen from a live worker (D41).
     */
    claim(effectId: string, worker: string, now: string, staleBefore: string): boolean {
        assertUtcInstant(now, "now");
        assertUtcInstant(staleBefore, "staleBefore");
        const result = this.db
            .prepare(
                `
                INSERT INTO effect_claim VALUES (?, ?, ?)
                ON CONFLICT(effect_id) DO UPDATE SET worker = excluded.worker, at = excluded.at
                WHERE effect_claim.at <= ?
            `,
            )
            .run(effectId, worker, now, staleBefore);
        return result.changes === 1;
    }

    /**
     * Release a claim on clean completion — deletes only the caller's OWN row, so
     * releasing after your lease was stolen is a safe no-op.
     */
    release(effectId: string, worker: string): boolean {
        const result = this.db
            .prepare("DELETE FROM effect_claim WHERE effect_id = ? AND worker = ?")
            .run(effectId, worker);
        return result.changes === 1;
    }

    // ── Schedules ───────────────────────────────────────────────────

    /** Idempotent: re-declaring an existing schedule id is a no-op. */
    schedule(scheduleId: string, dueAt: string, effect: string): void {
        assertUtcInstant(dueAt, "dueAt");
        this.db
            .prepare("INSERT OR IGNORE INTO schedule VALUES (?, ?, ?, 'pending', NULL, NULL)")
            .run(scheduleId, dueAt, effect);
    }

    /**
     * Atomically claim every due pending schedule and return the claimed rows.
     * A restart mid-processing does NOT re-fire a running schedule; redriving stuck `running` rows is `requeueStuck`, deliberately not this method.
     */
    claimDue(now: string): ClaimedScheduleRow[] {
        assertUtcInstant(now, "now");
        const rows = this.db
            .prepare(
                `
                UPDATE schedule
                SET status = 'running',
                    claimed_at = ?,
                    claim_token = lower(hex(randomblob(16)))
                WHERE status = 'pending' AND due_at <= ?
                RETURNING schedule_id, due_at, effect, claim_token
            `,
            )
            .all(now, now) as {
            schedule_id: string;
            due_at: string;
            effect: string;
            claim_token: string;
        }[];
        return rows.map((r) => ({
            scheduleId: r.schedule_id,
            dueAt: r.due_at,
            effect: r.effect,
            claimToken: r.claim_token,
        }));
    }

    /** Complete a firing, and only for the token that claimed it. */
    scheduleDone(scheduleId: string, claimToken: string): boolean {
        const result = this.db
            .prepare(
                `
                UPDATE schedule
                SET status = 'done', claimed_at = NULL, claim_token = NULL
                WHERE schedule_id = ? AND status = 'running' AND claim_token = ?
            `,
            )
            .run(scheduleId, claimToken);
        return result.changes === 1;
    }

    /**
     * Complete this firing and arm the next one, in one statement: `schedule()` is
     * `INSERT OR IGNORE`, so a completed sweep could never come round again, and a crash between two statements would lose the schedule or strand the claim.
     */
    scheduleAgain(scheduleId: string, claimToken: string, dueAt: string): boolean {
        assertUtcInstant(dueAt, "dueAt");
        const result = this.db
            .prepare(
                `
                UPDATE schedule
                SET status = 'pending', due_at = ?, claimed_at = NULL, claim_token = NULL
                WHERE schedule_id = ? AND status = 'running' AND claim_token = ?
            `,
            )
            .run(dueAt, scheduleId, claimToken);
        return result.changes === 1;
    }

    /**
     * The sweep's redrive: atomically return stuck `running` schedules to `pending`.
     * Stuckness is claim age, never due time, so a backlog catch-up is not stolen from. A slow-but-alive handler can fire twice, so effects still need D41's contract (D43).
     */
    requeueStuck(claimedBefore: string): ScheduleRow[] {
        assertUtcInstant(claimedBefore, "claimedBefore");
        const rows = this.db
            .prepare(
                `
                UPDATE schedule
                SET status = 'pending', claimed_at = NULL, claim_token = NULL
                WHERE status = 'running' AND claimed_at <= ?
                RETURNING schedule_id, due_at, effect
            `,
            )
            .all(claimedBefore) as {
            schedule_id: string;
            due_at: string;
            effect: string;
        }[];
        return rows.map((r) => ({
            scheduleId: r.schedule_id,
            dueAt: r.due_at,
            effect: r.effect,
        }));
    }

    // ── Retention (the sweep's pruning half — D43's adopted windows) ─

    /**
     * Delete only completed delivery identities past the retention boundary.
     * Pending and processing payloads are never eligible, regardless of age.
     */
    pruneCompletedDeliveries(before: string): number {
        assertUtcInstant(before, "before");
        this.db.exec("BEGIN IMMEDIATE");
        try {
            this.db
                .prepare(
                    `
                DELETE FROM delivery_report
                WHERE delivery_id IN (
                    SELECT delivery_id FROM seen_delivery
                    WHERE state = 'done' AND completed_at <= ?
                )
            `,
                )
                .run(before);
            const removed = this.db
                .prepare(
                    `
                DELETE FROM seen_delivery
                WHERE state = 'done' AND completed_at <= ?
            `,
                )
                .run(before).changes as number;
            this.db.exec("COMMIT");
            return removed;
        } catch (error) {
            try {
                this.db.exec("ROLLBACK");
            } catch {
                // Preserve the pruning failure.
            }
            throw error;
        }
    }

    close(): void {
        this.db.close();
    }
}
