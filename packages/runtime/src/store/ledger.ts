/**
 * The half of the file that is appended and folded: an effect's facts, its lease,
 * and the schedule rows a clock claims (D164).
 * The file and its pragmas belong to `Store`; this class is handed the connection.
 */

import type { DatabaseSync } from "node:sqlite";
import type { ItemRef } from "@hiero-hackers/automation-core";
import type { Decision, Fact, LandedWrite, LedgerState, OpenSend, StoredWarning } from "./facts.js";
import { fold } from "./fold.js";
import { assertNonEmpty, assertUtcInstant } from "./guards.js";
import type { ClaimedScheduleRow, ScheduleRow } from "./schedules.js";

/** The kinds that close an open send; `unsent` closes one without spending an attempt. */
const CLOSING = "('landed','refused','abandoned','unsent')";

/** An open send is a `sent` fact with no later closing fact at the same seq. */
const STILL_OPEN = `
    NOT EXISTS (
        SELECT 1 FROM effect_fact closing
        WHERE closing.effect_id = sent.effect_id AND closing.seq = sent.seq
          AND closing.kind IN ${CLOSING} AND closing.fact_id > sent.fact_id
    )`;

/** The newest send at its seq: a resend supersedes the send it retries, as one attempt of one call. */
const LATEST_SEND = `
    NOT EXISTS (
        SELECT 1 FROM effect_fact newer
        WHERE newer.effect_id = sent.effect_id AND newer.seq = sent.seq
          AND newer.kind = 'sent' AND newer.fact_id > sent.fact_id
    )`;

const ATTEMPTS_AT = `
    (SELECT COUNT(CASE WHEN spent.kind = 'sent' THEN 1 END)
          - COUNT(CASE WHEN spent.kind = 'unsent' THEN 1 END)
     FROM effect_fact spent
     WHERE spent.effect_id = sent.effect_id AND spent.seq = sent.seq)`;

/** One `effect_fact` row, as SQLite hands it back. */
interface FactRow {
    readonly effect_id: string;
    readonly seq: number;
    readonly kind: Fact["kind"];
    readonly at: string;
    readonly revision: string;
    readonly capability: string;
    readonly item_kind: ItemRef["kind"];
    readonly item_number: number;
    readonly verb: string | null;
    readonly login: string | null;
    readonly code: string | null;
    readonly detail: string | null;
    readonly payload: string | null;
}

interface DecisionRow {
    readonly pass_id: string;
    readonly source: Decision["source"];
    readonly source_id: string;
    readonly at: string;
    readonly item_kind: ItemRef["kind"];
    readonly item_number: number;
    readonly capability: string;
    readonly verdict: string;
    readonly code: string | null;
    readonly detail: string | null;
    readonly effect_id: string | null;
}

function factOf(row: FactRow): Fact {
    return {
        effectId: row.effect_id,
        seq: row.seq,
        kind: row.kind,
        at: row.at,
        revision: row.revision,
        capability: row.capability,
        item: { kind: row.item_kind, number: row.item_number },
        verb: row.verb,
        login: row.login,
        code: row.code,
        detail: row.detail,
        payload: row.payload,
    };
}

/** A `warned` fact's payload read back as the snapshot it stored, or `null`. */
function warningOf(effectId: string, payload: string | null): StoredWarning | null {
    let snapshot: unknown = null;
    try {
        snapshot = JSON.parse(payload ?? "");
    } catch {
        return null;
    }
    if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return null;
    return { ...(snapshot as Omit<StoredWarning, "effectId">), effectId };
}

/** An effect's history appended one fact at a time, with its lease and its clock (D164). */
export class Ledger {
    private readonly db: DatabaseSync;

    constructor(db: DatabaseSync) {
        this.db = db;
    }

    // ── Facts ───────────────────────────────────────────────────────

    /**
     * Append one fact. A second `warned` for the same effect appends nothing (D162).
     * One statement, so the first warning binds even against a concurrent writer.
     */
    record(fact: Fact): void {
        assertUtcInstant(fact.at, "at");
        assertNonEmpty(fact.effectId, "effectId");
        this.db
            .prepare(
                `
                INSERT INTO effect_fact (
                    effect_id, seq, kind, at, revision, capability,
                    item_kind, item_number, verb, login, code, detail, payload
                )
                SELECT $effectId, $seq, $kind, $at, $revision, $capability,
                       $itemKind, $itemNumber, $verb, $login, $code, $detail, $payload
                WHERE $kind != 'warned'
                   OR NOT EXISTS (
                        SELECT 1 FROM effect_fact
                        WHERE effect_id = $effectId AND kind = 'warned'
                   )
            `,
            )
            .run({
                $effectId: fact.effectId,
                $seq: fact.seq,
                $kind: fact.kind,
                $at: fact.at,
                $revision: fact.revision,
                $capability: fact.capability,
                $itemKind: fact.item.kind,
                $itemNumber: fact.item.number,
                $verb: fact.verb,
                $login: fact.login,
                $code: fact.code,
                $detail: fact.detail,
                $payload: fact.payload,
            });
    }

    /** One effect's facts in ledger order — the fold's input, and the operator's. */
    factsOf(effectId: string): Fact[] {
        const rows = this.db
            .prepare("SELECT * FROM effect_fact WHERE effect_id = ? ORDER BY fact_id")
            .all(effectId) as unknown as FactRow[];
        return rows.map(factOf);
    }

    stateOf(effectId: string, planLength: number): LedgerState {
        return fold(this.factsOf(effectId), planLength);
    }

    /** The sweep's worklist — every open send at or before `before`, oldest first. */
    open(before: string): OpenSend[] {
        assertUtcInstant(before, "before");
        const rows = this.db
            .prepare(
                `
                SELECT sent.effect_id, sent.seq, sent.payload, sent.at, sent.revision,
                       ${ATTEMPTS_AT} AS attempts
                FROM effect_fact sent
                WHERE sent.kind = 'sent' AND sent.at <= ?
                  AND ${STILL_OPEN} AND ${LATEST_SEND}
                ORDER BY sent.at, sent.fact_id
            `,
            )
            .all(before) as unknown as {
            effect_id: string;
            seq: number;
            payload: string | null;
            at: string;
            revision: string;
            attempts: number;
        }[];
        return rows.map((row) => ({
            effectId: row.effect_id,
            seq: row.seq,
            payload: row.payload,
            attempts: row.attempts,
            at: row.at,
            revision: row.revision,
        }));
    }

    /** Every effect with a fact on one item, oldest first — where an explanation starts (D163). */
    effectsOn(item: ItemRef): string[] {
        const rows = this.db
            .prepare(
                `
                SELECT effect_id FROM effect_fact
                WHERE item_kind = ? AND item_number = ?
                GROUP BY effect_id
                ORDER BY MIN(fact_id)
            `,
            )
            .all(item.kind, item.number) as unknown as { effect_id: string }[];
        return rows.map((row) => row.effect_id);
    }

    /** Every completed call the platform made on one item — what GitHub's actor cannot say (D159). */
    landedOn(item: ItemRef): LandedWrite[] {
        const rows = this.db
            .prepare(
                `
                SELECT verb, login, at FROM effect_fact
                WHERE kind = 'landed' AND item_kind = ? AND item_number = ?
                ORDER BY at, fact_id
            `,
            )
            .all(item.kind, item.number) as unknown as LandedWrite[];
        return rows.map((row) => ({ verb: row.verb, login: row.login, at: row.at }));
    }

    /** The warning standing for one effect: the earliest, because the first binds (D162). */
    warningFor(effectId: string): StoredWarning | null {
        const row = this.db
            .prepare(
                `
                SELECT payload FROM effect_fact
                WHERE effect_id = ? AND kind = 'warned'
                ORDER BY fact_id LIMIT 1
            `,
            )
            .get(effectId) as { payload: string | null } | undefined;
        return row === undefined ? null : warningOf(effectId, row.payload);
    }

    /** Append one pass's verdict on one item (D163). */
    decide(decision: Decision): void {
        assertUtcInstant(decision.at, "at");
        assertNonEmpty(decision.passId, "passId");
        this.db
            .prepare(
                `
                INSERT INTO decision (
                    pass_id, source, source_id, at, item_kind, item_number,
                    capability, verdict, code, detail, effect_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            )
            .run(
                decision.passId,
                decision.source,
                decision.sourceId,
                decision.at,
                decision.item.kind,
                decision.item.number,
                decision.capability,
                decision.verdict,
                decision.code,
                decision.detail,
                decision.effectId,
            );
    }

    decisionsOn(item: ItemRef): Decision[] {
        const rows = this.db
            .prepare(
                `
                SELECT * FROM decision
                WHERE item_kind = ? AND item_number = ?
                ORDER BY at, rowid
            `,
            )
            .all(item.kind, item.number) as unknown as DecisionRow[];
        return rows.map((row) => ({
            passId: row.pass_id,
            source: row.source,
            sourceId: row.source_id,
            at: row.at,
            item: { kind: row.item_kind, number: row.item_number },
            capability: row.capability,
            verdict: row.verdict,
            code: row.code,
            detail: row.detail,
            effectId: row.effect_id,
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

    // ── Retention ───────────────────────────────────────────────────

    /**
     * Delete whole effects settled at or before `before` — never single facts (D161).
     * An effect with an open send is kept however old, as an open journal row is.
     */
    prune(before: string): number {
        assertUtcInstant(before, "before");
        return this.db
            .prepare(
                `
                DELETE FROM effect_fact
                WHERE effect_id IN (
                        SELECT effect_id FROM effect_fact
                        GROUP BY effect_id HAVING MAX(at) <= ?
                    )
                  AND effect_id NOT IN (
                        SELECT sent.effect_id FROM effect_fact sent
                        WHERE sent.kind = 'sent' AND ${STILL_OPEN}
                    )
            `,
            )
            .run(before).changes as number;
    }

    /** Delete decision rows taken at or before `before`, on the deliveries window (D163). */
    pruneDecisions(before: string): number {
        assertUtcInstant(before, "before");
        return this.db.prepare("DELETE FROM decision WHERE at <= ?").run(before).changes as number;
    }
}
