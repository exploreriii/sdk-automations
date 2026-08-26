/**
 * The live fill for core's external facts — what GitHub actually answers,
 * where the shell's stubs assume.
 *
 * Two facts live here. Grants ride the mint response: the token source
 * already holds them, so asking costs nothing. Ordering evidence is the
 * expensive one — a timeline read per item, memoized for exactly one
 * delivery — and its answer is a `Date`, a confident `null`, or
 * `"unknown"`; a failed or incomplete read is always `"unknown"`, never
 * either of the others (D51, D119).
 */

import type {
    FailureClass,
    HumanChangeOrdering,
    ItemRef,
    PermissionGrant,
    RepositoryRef,
} from "@hiero-hackers/automation-core";
import {
    GITHUB_API_ORIGIN,
    lastPageFromLink,
    type GitHubHttpClient,
    type GitHubOutcome,
} from "./http.js";
import type { TokenSource } from "./token.js";
import { field, jsonArrayOf } from "./untrusted.js";

/** The installation's grants, or the classified reason they are unknown. */
export type GrantsOutcome =
    | { readonly ok: true; readonly grants: readonly PermissionGrant[] }
    | { readonly ok: false; readonly failure: FailureClass };

/**
 * What GitHub granted this installation, right now.
 *
 * A failed mint returns as its classified failure, never as an empty grant
 * list: an empty list reads as "granted nothing", and a capability would
 * refuse citing a permission the installation may actually hold. Answers
 * move when the token refreshes — nothing is memoized here.
 */
export async function installationGrants(source: TokenSource): Promise<GrantsOutcome> {
    const outcome = await source.current();
    return outcome.ok
        ? { ok: true, grants: outcome.token.grants }
        : { ok: false, failure: outcome.failure };
}

/**
 * The timeline event kinds that count as a human change (D119): the
 * surfaces the App writes — mapped labels, assignment — plus the
 * open/closed state its decisions read. The list grows when the intent
 * catalogue grows, not before.
 */
const HUMAN_CHANGE_EVENTS: ReadonlySet<string> = new Set([
    "labeled",
    "unlabeled",
    "assigned",
    "unassigned",
    "closed",
    "reopened",
]);

/** Timeline calls per item per delivery; past this the answer is `"unknown"`. */
const TIMELINE_READ_CAP = 3;

const TIMELINE_PAGE_SIZE = 100;

/** The delivery's causing human action, so it cannot conflict with itself. */
export interface CauseFingerprint {
    readonly actorLogin: string;
    readonly observedAt: Date;
}

/** What one delivery's ordering reads need; built fresh per delivery. */
export interface OrderingEvidenceOptions {
    readonly http: GitHubHttpClient;
    readonly repository: RepositoryRef;
    /** Absent for sweeps and bot-caused deliveries — nothing to exclude. */
    readonly cause?: CauseFingerprint;
}

/** GitHub timestamps have second granularity; compare at that granularity. */
const sameSecond = (a: Date, b: Date): boolean =>
    Math.floor(a.getTime() / 1000) === Math.floor(b.getTime() / 1000);

/**
 * When this timeline entry counts as a human change: a `Date`; `null` for
 * an entry that does not count — an ignored kind, a non-User actor, or the
 * causing event itself (same actor, same second; a DIFFERENT actor in the
 * cause's second still counts, which is D33's tie going to the human).
 * `"unparsable"` for an entry that counts but cannot be ordered.
 */
function humanChangeAt(entry: unknown, cause?: CauseFingerprint): Date | null | "unparsable" {
    const kind = field(entry, "event");
    // Stryker disable next-line ConditionalExpression: Set.has answers false for any non-string already; the typeof arm is for readers.
    if (typeof kind !== "string" || !HUMAN_CHANGE_EVENTS.has(kind)) return null;
    const actor = field(entry, "actor");
    if (field(actor, "type") !== "User") return null;
    const createdAt = field(entry, "created_at");
    if (typeof createdAt !== "string") return "unparsable";
    const at = new Date(createdAt);
    if (!Number.isFinite(at.getTime())) return "unparsable";
    if (
        cause !== undefined &&
        field(actor, "login") === cause.actorLogin &&
        sameSecond(at, cause.observedAt)
    ) {
        return null;
    }
    return at;
}

/** The newest human change among these entries, `null` for none. */
function newestIn(events: readonly unknown[], cause?: CauseFingerprint): HumanChangeOrdering {
    let newest: Date | null = null;
    for (const entry of events) {
        const at = humanChangeAt(entry, cause);
        if (at === "unparsable") return "unknown";
        // Stryker disable next-line EqualityOperator: at an exact tie the kept and the replacing Date are equal values — the mutant is equivalent.
        if (at !== null && (newest === null || at.getTime() > newest.getTime())) newest = at;
    }
    return newest;
}

interface TimelinePage {
    readonly events: readonly unknown[];
    /** The page `rel="last"` names, or `null` when this page is the whole timeline. */
    readonly lastPage: number | null;
}

function parsePage(outcome: GitHubOutcome): TimelinePage | "unknown" {
    if (!outcome.ok) return "unknown";
    const events = jsonArrayOf(outcome.body);
    if (events === null) return "unknown";
    return { events, lastPage: lastPageFromLink(outcome.headers.link) };
}

/**
 * Walk the timeline newest-first under the call cap.
 *
 * Pages ascend, so the newest change lives in the highest pages: read page
 * one (which names the last page), then descend from the last page. A find
 * in the descending block is the newest overall and later pages need no
 * call. A `Date` found ONLY on page one while middle pages went unvisited
 * would understate the newest change — the unsafe direction — so partial
 * coverage without a find in the block answers `"unknown"`.
 */
async function readOrdering(
    { http, repository, cause }: OrderingEvidenceOptions,
    item: ItemRef,
): Promise<HumanChangeOrdering> {
    const pageUrl = (page: number): string =>
        `${GITHUB_API_ORIGIN}/repos/${repository.owner}/${repository.repo}` +
        `/issues/${String(item.number)}/timeline` +
        `?per_page=${String(TIMELINE_PAGE_SIZE)}&page=${String(page)}`;
    const read = async (page: number): Promise<TimelinePage | "unknown"> =>
        parsePage(await http.request({ url: pageUrl(page), method: "GET" }));

    const first = await read(1);
    if (first === "unknown") return "unknown";
    const lastPage = first.lastPage ?? 1;
    // Stryker disable next-line ConditionalExpression: the general path below answers a one-page timeline identically; the early return is for readers.
    if (lastPage === 1) return newestIn(first.events, cause);

    const descending: number[] = [];
    for (let page = lastPage; page > 1 && descending.length < TIMELINE_READ_CAP - 1; page -= 1) {
        descending.push(page);
    }
    for (const page of descending) {
        const outcome = await read(page);
        if (outcome === "unknown") return "unknown";
        const newest = newestIn(outcome.events, cause);
        // "unknown" flows out through the same return as a Date.
        if (newest !== null) return newest;
    }
    // Nothing in the newest block; only complete coverage may answer null.
    return lastPage <= 1 + descending.length ? newestIn(first.events, cause) : "unknown";
}

/**
 * The causing action as the timeline will record it, read from the raw
 * payload.
 *
 * `observedAt` reads the item's `updated_at` — the SAME field core's
 * normalizer stamps on the cause — so the same-second exclusion here and
 * safety's `causeObservedAt` describe one instant; a different field would
 * quietly miss the exclusion and self-conflict every reaction. `undefined`
 * when the payload names no sender or no dated item: nothing to exclude,
 * which only ever errs toward refusing a write.
 */
export function causeFingerprintOf(payload: unknown): CauseFingerprint | undefined {
    const login = field(field(payload, "sender"), "login");
    const item = field(payload, "issue") ?? field(payload, "pull_request");
    const updatedAt = field(item, "updated_at");
    if (typeof login !== "string" || typeof updatedAt !== "string") return undefined;
    const observedAt = new Date(updatedAt);
    if (!Number.isFinite(observedAt.getTime())) return undefined;
    return { actorLogin: login, observedAt };
}

/**
 * Ordering evidence for one delivery: each item read once, concurrent
 * intents sharing the in-flight read, nothing kept across deliveries — the
 * object's lifetime IS the freshness rule. The ETag cache below this makes
 * the next delivery's re-read cheap; it never makes it stale, because a
 * conditional read revalidates with GitHub every time.
 */
export function orderingEvidenceSource(
    options: OrderingEvidenceOptions,
): (item: ItemRef) => Promise<HumanChangeOrdering> {
    const memo = new Map<string, Promise<HumanChangeOrdering>>();
    return (item) => {
        const key = `${item.kind}#${String(item.number)}`;
        let pending = memo.get(key);
        if (pending === undefined) {
            pending = readOrdering(options, item);
            memo.set(key, pending);
        }
        return pending;
    };
}

/** The two facts the live fill supplies; the shell adds its own. */
export interface LiveExternalFacts {
    readonly installationGrants: readonly PermissionGrant[];
    readonly latestHumanChangeAt: (item: ItemRef) => Promise<HumanChangeOrdering>;
}

/** One delivery's live facts, or the classified reason there are none. */
export type LiveExternalsOutcome =
    | { readonly ok: true; readonly facts: LiveExternalFacts }
    | { readonly ok: false; readonly failure: FailureClass };

/** Everything the live fill composes over; built once at the composition root. */
export interface LiveExternalsOptions {
    readonly tokenSource: TokenSource;
    readonly http: GitHubHttpClient;
    readonly repository: RepositoryRef;
}

/**
 * One delivery's live externals: grants resolved now — they gate every
 * intent — and ordering evidence read per item on demand. Call once per
 * delivery: the ordering memo inside must not outlive it.
 */
export async function liveExternalsForDelivery(
    { tokenSource, http, repository }: LiveExternalsOptions,
    payload: unknown,
): Promise<LiveExternalsOutcome> {
    const grants = await installationGrants(tokenSource);
    if (!grants.ok) return grants;
    const cause = causeFingerprintOf(payload);
    return {
        ok: true,
        facts: {
            installationGrants: grants.grants,
            latestHumanChangeAt: orderingEvidenceSource({
                http,
                repository,
                // Stryker disable next-line ConditionalExpression: spreading { cause: undefined } is runtime-identical; the guard serves exactOptionalPropertyTypes.
                ...(cause === undefined ? {} : { cause }),
            }),
        },
    };
}
