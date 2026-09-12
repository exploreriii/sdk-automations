/**
 * The sweep driver: a due schedule row becomes one fact record per open item, and
 * each becomes one decision (sweep.md §2). This lane exists because nobody told us.
 * A firing is also the only thing that prunes: the three retention windows (D166).
 */

import type {
    EngineCapability,
    IssueFacts,
    ItemRef,
    PullRequestFacts,
    RepositoryConfig,
    Unread,
} from "@hiero-hackers/automation-core";
import type { ClaimedScheduleRow, Store } from "../store/index.js";
import type { WriteBudget } from "./apply.js";
import { detailOf, type Log } from "./log.js";
import type { FactRecordInput, ShellRecord } from "./processor.js";
import { SWEEP_EFFECT, sweptItemId, wantsSweeping } from "./schedule.js";

// ─── The seams ───────────────────────────────────────────────────────

/**
 * One open item as the list carries it — the adapter's `OpenItem`, restated.
 * Restated rather than imported: only `main.ts` may name the adapter, and that is where the two shapes are checked against each other.
 */
export interface SweptItem {
    readonly item: ItemRef;
    readonly author: string;
    readonly labels: readonly string[];
    readonly assignees: readonly string[];
    readonly closedBy: string | null;
    readonly updatedAt: Date;
}

/** Every open item, or the reason the list is unusable. */
export type SweptItems =
    | { readonly ok: true; readonly items: readonly SweptItem[] }
    | { readonly ok: false; readonly detail: string };

/** What the driver reads its records through — the adapter's `FactsReader`. */
export interface SweepFacts {
    openItems(): Promise<SweptItems>;
    issueFacts(listed: SweptItem, links: readonly ItemRef[] | Unread): Promise<IssueFacts>;
    pullRequestFacts(
        listed: SweptItem,
        openIssues: readonly SweptItem[],
    ): Promise<PullRequestFacts>;
}

/**
 * A reader built FRESH for each firing.
 * Never one for the process: it memoises each item's clocks for one sweep only.
 */
export type SweepFactsSource = (config: RepositoryConfig) => SweepFacts;

/** The half of the processor this lane drives; see `processFacts`. */
export interface SweepProcessor {
    configuration(): Promise<RepositoryConfig | null>;
    processFacts(input: FactRecordInput): Promise<ShellRecord>;
}

export interface SweepOptions {
    readonly store: Store;
    readonly capabilities: readonly EngineCapability[];
    readonly processor: SweepProcessor;
    readonly facts: SweepFactsSource;
    readonly clock: () => Date;
    /** How long until the next firing. sweep.md §2 step 4; the default is hourly. */
    readonly cadenceMs: number;
    /** How many writes one firing may send; the default is `SWEEP_WRITE_CAP`. */
    readonly writeCap: number;
    /** How many items' facts one firing may read; the default is `SWEEP_READ_BUDGET`. */
    readonly readBudget: number;
    /** The installation switch (D171): a firing reads nothing, and still prunes and re-arms. */
    readonly suspended?: boolean;
    readonly log: Log;
}

/**
 * How often a repository is read when nothing says otherwise — every hour.
 * A clock the sweep cannot see is a promise the App cannot keep: the smallest reap a `duration` may state is two hours.
 */
export const DEFAULT_SWEEP_CADENCE_MS = 60 * 60_000;

/** How many writes one firing may send before it carries the rest to the next (D167). */
export const SWEEP_WRITE_CAP = 20;

/**
 * How many items' facts one firing may read before it carries the rest to the next (D170).
 * The open-item list itself is not budgeted: it is paged, and one page is one cheap read.
 */
export const SWEEP_READ_BUDGET = 500;

const DAY_MS = 24 * 60 * 60_000;

/** How long a done delivery and its report are kept — the deliveries API's own window (D166). */
export const DONE_DELIVERY_RETENTION_DAYS = 30;

/** How long a decision row is kept (D166). */
export const DECISION_RETENTION_DAYS = 30;

/** How long a settled effect's facts are kept (D166). */
export const SETTLED_EFFECT_RETENTION_DAYS = 90;

/** What the composition root holds: one tick, run whenever the clock says. */
export interface Sweep {
    /** Fire every due sweep row; overlapping calls share the pass already running. */
    runDue(): Promise<void>;
    /** The pass in flight, if any. What a shutdown joins, to free the schedule claim. */
    settled(): Promise<void>;
}

// ─── The driver ──────────────────────────────────────────────────────

/**
 * What one firing produced, for the line it ends with.
 * `unread` separates "nothing is stale" from "this sweep could not tell".
 * `writes` is what the cap spent and `heldBack` what it turned away (D167).
 */
interface Swept {
    readonly items: number;
    readonly decided: number;
    readonly unread: number;
    readonly writes: number;
    readonly heldBack: number;
    /** Items past the read budget, left for the next firing (D170). */
    readonly remaining: number;
    /** Where the next firing starts reading; null reads the list again from the beginning. */
    readonly resumeAfter: number | null;
}

/**
 * A firing that read nothing — an unusable list, a suspension, or a repository that wants none.
 * The cursor is handed back as it stood: nothing was read, so nothing moved it.
 */
const nothingRead = (row: ClaimedScheduleRow): Swept => ({
    items: 0,
    decided: 0,
    unread: 0,
    writes: 0,
    heldBack: 0,
    remaining: 0,
    resumeAfter: row.resumeAfter,
});

/** How many of one record's effects the write cap turned away. */
const heldBackIn = (record: ShellRecord): number =>
    record.kind === "decision"
        ? record.effects.filter((effect) => effect.code === "sweepWriteCap").length
        : 0;

/** The items one firing reads, and where it stopped — `withinBudget`'s answer. */
interface Reading {
    readonly taken: readonly SweptItem[];
    readonly remaining: number;
    /** The last number read when items remain; null when the list was finished. */
    readonly resumeAfter: number | null;
}

/**
 * Sorted by number ascending, skipped past the cursor, stopped at the budget (D170).
 * A judgement: the list is the only thing read before it, and it decides what else is.
 */
function withinBudget(items: readonly SweptItem[], after: number | null, budget: number): Reading {
    const eligible = items
        .filter(({ item }) => after === null || item.number > after)
        .sort((left, right) => left.item.number - right.item.number);
    const taken = eligible.slice(0, budget);
    // In number order, so the last item read IS the cursor the next firing resumes after.

    const stopped = taken.length < eligible.length ? taken.at(-1) : undefined;
    return {
        taken,
        remaining: eligible.length - taken.length,
        resumeAfter: stopped === undefined ? null : stopped.item.number,
    };
}

export function createSweep(options: SweepOptions): Sweep {
    const {
        store,
        capabilities,
        processor,
        facts,
        clock,
        cadenceMs,
        writeCap,
        readBudget,
        suspended = false,
        log,
    } = options;

    const nextDue = (): string => new Date(clock().getTime() + cadenceMs).toISOString();

    /**
     * Every open item the budget reaches, read once, split by kind.
     * One list call covers both kinds because GitHub's issue list carries pull requests too.
     */
    const readRecords = async (
        row: ClaimedScheduleRow,
        config: RepositoryConfig,
    ): Promise<Swept> => {
        const reader = facts(config);
        const listed = await reader.openItems();
        if (!listed.ok) {
            log({ event: "sweepUnreadable", scheduleId: row.scheduleId, detail: listed.detail });
            return nothingRead(row);
        }
        const reading = withinBudget(listed.items, row.resumeAfter, readBudget);
        // Split from what the budget took, never from the whole list: a link to an item
        // outside this window is one more facts read, which is what the budget spends.

        const issues = reading.taken.filter(({ item }) => item.kind === "issue");
        const pulls = reading.taken.filter(({ item }) => item.kind === "pullRequest");

        // Pull requests first: their `links` are the only read that says which pull
        // requests an issue has, and the driver reverses them below.

        const inverse = new Map<number, ItemRef[]>();
        let everyLinkRead = true;
        const records: (IssueFacts | PullRequestFacts)[] = [];
        for (const listedPull of pulls) {
            const record = await reader.pullRequestFacts(listedPull, issues);
            records.push(record);
            if (record.links === "unread") {
                everyLinkRead = false;
                continue;
            }
            for (const linked of record.links.issues) {
                const held = inverse.get(linked.item.number) ?? [];
                held.push(record.item);
                inverse.set(linked.item.number, held);
            }
        }
        for (const listedIssue of issues) {
            // A partial inverse is a shorter list, so one unread link read makes every
            // issue's links unread.

            const links: readonly ItemRef[] | Unread = everyLinkRead
                ? (inverse.get(listedIssue.item.number) ?? [])
                : "unread";
            records.push(await reader.issueFacts(listedIssue, links));
        }

        // One budget for the firing: what it holds back is decided again next time.

        const budget: WriteBudget = { remaining: writeCap };
        let decided = 0;
        let unread = 0;
        let heldBack = 0;
        for (const record of records) {
            if (record.links === "unread") unread += 1;
            const shellRecord = await processor.processFacts({
                facts: record,
                deliveryId: sweptItemId(row.scheduleId, record.item),
                receivedAt: row.dueAt,
                config,
                budget,
            });
            heldBack += heldBackIn(shellRecord);
            decided += 1;
        }
        if (reading.resumeAfter !== null) {
            log({
                event: "sweepPartial",
                scheduleId: row.scheduleId,
                read: reading.taken.length,
                remaining: reading.remaining,
                resumeAfter: reading.resumeAfter,
            });
        }
        return {
            items: listed.items.length,
            decided,
            unread,
            writes: writeCap - budget.remaining,
            heldBack,
            remaining: reading.remaining,
            resumeAfter: reading.resumeAfter,
        };
    };

    /** The three retention windows, run once per firing and contained on their own (D166). */
    const pruneRetained = (): void => {
        try {
            const now = clock().getTime();
            const before = (days: number): string => new Date(now - days * DAY_MS).toISOString();
            const deliveries = store.inbox.pruneCompletedDeliveries(
                before(DONE_DELIVERY_RETENTION_DAYS),
            );
            const effects = store.ledger.prune(before(SETTLED_EFFECT_RETENTION_DAYS));
            const decisions = store.ledger.pruneDecisions(before(DECISION_RETENTION_DAYS));
            if (deliveries > 0 || effects > 0 || decisions > 0) {
                log({ event: "sweepPruned", deliveries, effects, decisions });
            }
        } catch (error) {
            log({ event: "sweepFailed", detail: detailOf(error) });
        }
    };

    /**
     * What this firing read — nothing, where a suspension or the file says so (D171).
     * Contained: the reading is the only half of a firing that may fail, and the re-arm below has to happen anyway.
     */
    const readingOf = async (row: ClaimedScheduleRow): Promise<Swept> => {
        if (suspended) {
            log({ event: "sweepSuspended", scheduleId: row.scheduleId });
            return nothingRead(row);
        }
        try {
            const config = await processor.configuration();
            // Neither an unreadable file nor a repository that wants no sweeping is a
            // reason to read twenty items: re-arm and ask again.

            if (config !== null && wantsSweeping(config, capabilities)) {
                return await readRecords(row, config);
            }
        } catch (error) {
            log({ event: "sweepFailed", detail: detailOf(error) });
        }
        return nothingRead(row);
    };

    /**
     * One firing, from claim to re-arm.
     * The re-arm happens whatever the reading came to: a row left `running` is one only a stale-claim redrive could free.
     */
    const fire = async (row: ClaimedScheduleRow): Promise<void> => {
        log({ event: "sweepClaimed", scheduleId: row.scheduleId, dueAt: row.dueAt });
        const swept = await readingOf(row);
        pruneRetained();
        const nextDueAt = nextDue();
        if (
            !store.ledger.scheduleAgain(
                row.scheduleId,
                row.claimToken,
                nextDueAt,
                swept.resumeAfter,
            )
        ) {
            // A redrive took the claim over while this firing ran; whoever holds it now
            // owns the next due date, and the reading just done was thrown away.

            log({ event: "sweepFailed", detail: `the claim on "${row.scheduleId}" was lost` });
            return;
        }
        log({ event: "sweepFinished", scheduleId: row.scheduleId, ...swept, nextDueAt });
    };

    /**
     * Every row this tick claimed, fired or handed back.
     * Nothing here may reject: a rejection would reach `settled()`, where a shutdown awaiting it has nowhere to put it.
     */
    const fireDue = async (): Promise<void> => {
        try {
            const due: readonly ClaimedScheduleRow[] = store.ledger.claimDue(clock().toISOString());
            for (const row of due) {
                if (row.effect === SWEEP_EFFECT) {
                    await fire(row);
                    continue;
                }
                // `claimDue` claims every due row and `schedule.ts` is the only declarer, so
                // this is a future effect's row with no driver here. Hand the claim back.

                log({
                    event: "sweepFailed",
                    detail: `schedule "${row.scheduleId}" carries the unknown effect "${row.effect}"`,
                });
                store.ledger.scheduleAgain(
                    row.scheduleId,
                    row.claimToken,
                    nextDue(),
                    row.resumeAfter,
                );
            }
        } catch (error) {
            log({ event: "sweepFailed", detail: detailOf(error) });
        }
    };

    let firing: Promise<void> | null = null;
    return {
        runDue(): Promise<void> {
            firing ??= (async () => {
                try {
                    await fireDue();
                } finally {
                    firing = null;
                }
            })();
            return firing;
        },
        settled: () => firing ?? Promise.resolve(),
    };
}
