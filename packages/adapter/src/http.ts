/**
 * The one authenticated GitHub call path used by every adapter operation.
 *
 * This file deliberately owns the mechanics that would otherwise drift
 * between operations: request headers, timeouts, the bounded ETag cache, the
 * bounded body read, rate-limit state and the pacing it feeds, refusal of
 * redirects, and how long a failure is waited on before it is handed back.
 * Waiting is this file's job because nothing below it may hold a claimed
 * delivery, and nothing above it can see a `retry-after` (D20).
 *
 * Core owns the vocabulary for GitHub responses and the retry advice for
 * each class; this file adds the two results core cannot have — a request
 * refused locally, and a response too large to read — plus the bounds a
 * process holding a claim needs. Which token to send is `token.ts`. In order
 * below: the chosen bounds, the contract, the local judgements, the retry
 * policy, the representation cache, the client.
 */

import {
    classifyFailure,
    MAX_RATE_LIMIT_ATTEMPTS,
    parseSecondsHeader,
    retryAdvice,
    type FailureClass,
    type PermissionGrant,
} from "@hiero-hackers/automation-core";
import {
    isPastExpiry,
    isWellFormedTokenOutcome,
    type InstallationToken,
    type TokenOutcome,
    type TokenSource,
} from "./token.js";

// ─── The chosen bounds ───────────────────────────────────────────────

/** The REST version this client has been checked against. */
export const GITHUB_API_VERSION = "2026-03-10";

/** Installation credentials never leave GitHub's public API origin. */
export const GITHUB_API_ORIGIN = "https://api.github.com";

/** The only POST target: GitHub's read-only GraphQL query endpoint. */
export const GITHUB_GRAPHQL_URL = `${GITHUB_API_ORIGIN}/graphql`;

/** A request gets this long per attempt unless the composition root chooses less. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Full representations retained for conditional reads, least-recently-used. */
export const DEFAULT_ETAG_CACHE_ENTRIES = 1_000;

/** Retained bodies across all entries, in UTF-16 code units — close enough for a bound. */
export const DEFAULT_ETAG_CACHE_BYTES = 20 * 1024 * 1024;

/** A body larger than this is not worth retaining for a conditional re-read. */
export const DEFAULT_ETAG_CACHE_ENTRY_BYTES = 512 * 1024;

/**
 * The largest response body this client will read.
 *
 * Eight times the per-entry cache bound above: a body too large to retain is
 * still read whole and classified, and anything past this is abandoned
 * mid-stream rather than buffered. The largest response any operation here
 * asks for is a hundred-entry timeline page.
 */
export const MAX_RESPONSE_BODY_BYTES = 8 * DEFAULT_ETAG_CACHE_ENTRY_BYTES;

/** Sent on every request this package makes, the mint's POST included. */
export const USER_AGENT = "hiero-hackers-sdk-automations";

const DEFAULT_ACCEPT = "application/vnd.github+json";

/** Attempts per request on a rejected token: the first, then one fresh mint. */
const TOKEN_REFRESH_ATTEMPTS = 2;

/**
 * Attempts per request on weather, where core's backoff list would allow four.
 *
 * The shell already re-runs the whole delivery up to five times with its own
 * doubling backoff, so an in-request retry only has to clear a blip a second
 * send clears. Further attempts duplicate that machinery while holding a claim.
 */
const TRANSIENT_ATTEMPTS = 2;

/**
 * Everything one `request()` may spend asleep, across all of its retries.
 *
 * The caller sits inside a claimed delivery, and a claim older than the
 * shell's `STALE_CLAIM_MINUTES` (15) is presumed dead and taken over. Thirty
 * seconds is three percent of that window: long enough for the one wait worth
 * taking in process — a primary budget whose reset is already seconds away —
 * and far too short for a secondary limit's sixty-second floor or a distant
 * reset. Those return at once, into the shell's counted-attempt retry and
 * dead-letter machinery, rather than camping on the claim.
 *
 * Per request rather than per delivery, because a wait long enough to matter
 * ends the delivery's reading anyway: every caller in this package returns on
 * its first failed request.
 */
export const MAX_RETRY_WAIT_MS = 30_000;

/**
 * How much of a backoff this package CHOSE is spent spreading it out.
 *
 * Jitter is added only where the advice carries no wait signal of its own. An
 * instant GitHub dictated is the same for every worker and waiting past it is
 * already required; a chosen constant fires every worker that failed together
 * back in lockstep. The spread comes from the clock rather than a random
 * source, so a wait stays reproducible in a report and is still decorrelated:
 * two workers that fail on different milliseconds wait different amounts.
 */
const BACKOFF_JITTER_FRACTION = 0.25;

/**
 * Primary-budget requests held back rather than spent.
 *
 * The shared rate budget is a protected asset, and one repository must not be
 * able to make every installation unavailable (threat model §2). One percent
 * of GitHub's hourly five thousand. Under it this client stops as if already
 * exhausted, so work ends countably in the shell's retry machinery instead of
 * at the hard wall, halfway through a delivery.
 */
export const PRIMARY_BUDGET_RESERVE = 50;

const LINKED_ISSUES_GRANTS: readonly PermissionGrant[] = ["issues:read", "pull_requests:read"];

// ─── The contract ────────────────────────────────────────────────────

/** The operation-specific part of a GitHub request. */
interface GitHubGetRequest {
    readonly url: string;
    readonly method: "GET";
    readonly headers?: Readonly<Record<string, string>>;
}

interface GitHubGraphqlRequest {
    readonly url: string;
    readonly method: "POST";
    readonly body: string;
    readonly headers?: Readonly<Record<string, string>>;
}

/** REST reads, or a GraphQL query at the one admitted POST endpoint. */
export type GitHubRequest = GitHubGetRequest | GitHubGraphqlRequest;

/** A usable response, whether GitHub sent the body or the cache held it. */
export interface GitHubSuccess {
    readonly ok: true;
    readonly status: number;
    readonly body: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly fromCache: boolean;
}

/** A classified failure; response fields are absent when nothing was sent. */
export interface GitHubFailure {
    readonly ok: false;
    readonly failure: GitHubHttpFailureClass;
    readonly status?: number;
    readonly body?: string;
    readonly headers?: Readonly<Record<string, string>>;
}

/** Why the adapter refused or could not construct a request locally. */
export type NotSentReason =
    | "disallowedMethod"
    | "disallowedOrigin"
    | "malformedUrl"
    | "invalidHeaders"
    | "invalidBody"
    | "brokenSeam";

/**
 * The injected seam a `brokenSeam` refusal names as the one that failed.
 *
 * A seam failure is rare and hard to reproduce, so the one report an
 * operator gets must say which piece of wiring broke.
 */
export type BrokenSeam =
    "tokenSource" | "clock" | "timeoutSignal" | "tokenValue" | "invalidate" | "response" | "sleep";

/**
 * Core owns the response classes; the adapter adds the two it cannot have.
 *
 * `notSent` is a request refused before it left the process.
 * `responseTooLarge` is the opposite end: a response that arrived and was
 * abandoned at `MAX_RESPONSE_BODY_BYTES`. Neither is ever retried — the
 * refusal is deterministic, and a re-read returns the same bytes.
 */
export type GitHubHttpFailureClass =
    | FailureClass
    | { readonly kind: "responseTooLarge"; readonly limitBytes: number }
    | { readonly kind: "notSent"; readonly reason: Exclude<NotSentReason, "brokenSeam"> }
    | { readonly kind: "notSent"; readonly reason: "brokenSeam"; readonly seam: BrokenSeam };

/** What one call to `request()` resolves to — it never throws. */
export type GitHubOutcome = GitHubSuccess | GitHubFailure;

/** The `x-ratelimit-*` headers of the most recent actual response. */
export interface RateLimitSnapshot {
    readonly url: string;
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
}

/** The shape of `fetch`, named so tests can script it. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The production pause between attempts, and the only real timer here. */
export const wait = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Seams the composition root supplies; only the token source is required.
 *
 * `sleep` is injected for the same reason `clock` is: a suite that waited the
 * advised delays would take minutes and prove nothing the recorded pauses do
 * not prove instantly.
 */
export interface GitHubHttpClientOptions {
    readonly tokenSource: TokenSource;
    readonly fetch?: FetchLike;
    readonly clock?: () => Date;
    readonly sleep?: (milliseconds: number) => Promise<void>;
    readonly timeoutMs?: number;
    /** Injection keeps timeout tests deterministic; production uses `AbortSignal.timeout`. */
    readonly timeoutSignal?: (milliseconds: number) => AbortSignal;
}

/** What every operation calls; see the file header for what it owns. */
export interface GitHubHttpClient {
    request(request: GitHubRequest): Promise<GitHubOutcome>;
    /** The last actual response, including a response that was retried. */
    latestRateLimit(): RateLimitSnapshot | null;
}

/** A retained body and the validator plus variant that make it reusable. */
interface CachedRepresentation {
    readonly etag: string;
    readonly variant: string;
    readonly body: string;
    readonly headers: Readonly<Record<string, string>>;
}

// ─── Local judgements ────────────────────────────────────────────────

/** The one spelling of a repository's API path — owner and repo encoded
 * once, identically, for every operation that names one. */
export function repoPath(repository: { readonly owner: string; readonly repo: string }): string {
    return (
        `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(repository.owner)}` +
        `/${encodeURIComponent(repository.repo)}`
    );
}

/** Lower-cased header record, the shape core's classifier reads. */
export function headersToRecord(headers: Headers): Record<string, string> {
    const record: Record<string, string> = {};
    headers.forEach((value, name) => {
        record[name.toLowerCase()] = value;
    });
    return record;
}

/**
 * The page `rel="last"` names in a `link` header, or `null` when absent.
 * That does NOT imply a complete response. Pagination is this client's vocabulary —
 * the cache retains `link` on stored representations for exactly this read.
 */
export function lastPageFromLink(link: string | undefined): number | null {
    // Stryker disable next-line ConditionalExpression: exec stringifies undefined and misses; the guard is for readers.
    if (link === undefined) return null;
    const match = /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link);
    return match === null ? null : Number(match[1]);
}

function rateLimitHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(headers).filter(([name]) => name.startsWith("x-ratelimit-")),
    );
}

function representationHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
    const link = headers.link;
    return link === undefined ? {} : { link };
}

type GitHubApiUrl =
    | { readonly ok: true; readonly url: string }
    | { readonly ok: false; readonly refused: "malformedUrl" | "disallowedOrigin" };

function githubApiUrl(rawUrl: string): GitHubApiUrl {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return { ok: false, refused: "malformedUrl" };
    }
    return url.origin === GITHUB_API_ORIGIN
        ? { ok: true, url: url.href }
        : { ok: false, refused: "disallowedOrigin" };
}

/** Genuine transport weather — the one locally-made class worth a retry. */
function transportFailure(): GitHubFailure {
    return { ok: false, failure: { kind: "transient" } };
}

/** The request never left the process; retrying cannot help. */
function notSentFailure(reason: Exclude<NotSentReason, "brokenSeam">): GitHubFailure {
    return { ok: false, failure: { kind: "notSent", reason } };
}

/** A wiring defect in the named injected seam — never weather, never retried. */
function brokenSeamFailure(seam: BrokenSeam): GitHubFailure {
    return { ok: false, failure: { kind: "notSent", reason: "brokenSeam", seam } };
}

/**
 * One line naming a failure, with the detail the adapter's own classes carry.
 *
 * Every seam this package fills answers in core's vocabulary, and none of
 * those vocabularies has room for a `brokenSeam` name or a byte limit. The
 * kind alone tells an operator a request failed; this tells them what to fix.
 */
export function describeFailure(failure: GitHubHttpFailureClass): string {
    if (failure.kind === "responseTooLarge") {
        return `responseTooLarge (over ${String(failure.limitBytes)} bytes)`;
    }
    if (failure.kind !== "notSent") return failure.kind;
    return failure.reason === "brokenSeam"
        ? `notSent (broken seam: ${failure.seam})`
        : `notSent (${failure.reason})`;
}

/** A request as it may be sent, or the refusal that stops it here. */
type AdmittedRequest =
    | { readonly ok: true; readonly request: GitHubRequest }
    | { readonly ok: false; readonly refusal: GitHubFailure };

/**
 * The gate every request passes before a token is acquired: the two admitted
 * methods, the pinned origin, and the one GraphQL query this package may POST.
 *
 * It runs first so a refusal never costs a mint, and it normalises the URL so
 * everything downstream — the cache key included — sees one spelling.
 */
function admit(request: GitHubRequest): AdmittedRequest {
    if (request.method !== "GET" && request.method !== "POST") {
        return { ok: false, refusal: notSentFailure("disallowedMethod") };
    }
    const parsed = githubApiUrl(request.url);
    if (!parsed.ok) return { ok: false, refusal: notSentFailure(parsed.refused) };
    const admitted = { ok: true, request: { ...request, url: parsed.url } } as const;
    if (request.method === "GET") return admitted;
    if (parsed.url !== GITHUB_GRAPHQL_URL) {
        return { ok: false, refusal: notSentFailure("disallowedMethod") };
    }
    if (typeof request.body !== "string") {
        return { ok: false, refusal: notSentFailure("invalidBody") };
    }
    try {
        const body = JSON.parse(request.body) as Record<string, unknown>;
        if (
            body.operationName !== "LinkedIssues" ||
            typeof body.query !== "string" ||
            !/^\s*query\s+LinkedIssues(?:\s|\()/.test(body.query)
        ) {
            return { ok: false, refusal: notSentFailure("invalidBody") };
        }
    } catch {
        return { ok: false, refusal: notSentFailure("invalidBody") };
    }
    return admitted;
}

/**
 * The response body as text, or `null` when it passed the bound.
 *
 * Read chunk by chunk rather than through `response.text()`: the bound has to
 * stop an oversized body from being buffered, and a length checked after the
 * fact has already cost the memory it was meant to refuse. The decoder is
 * driven in streaming mode so a multi-byte character split across two chunks
 * survives.
 */
async function boundedText(response: Response): Promise<string | null> {
    const stream = response.body;
    if (stream === null) return "";
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return text + decoder.decode();
        bytes += chunk.value.length;
        if (bytes > MAX_RESPONSE_BODY_BYTES) {
            try {
                await reader.cancel();
            } catch {
                // The bound is what matters here, not a tidy close.
            }
            return null;
        }
        text += decoder.decode(chunk.value, { stream: true });
    }
}

function hasReadGrant(token: InstallationToken, required: PermissionGrant): boolean {
    const write = `${required.slice(0, -4)}write`;
    return token.grants.some((grant) => grant === required || grant === write);
}

/** Ready-to-send headers and the variant they select, or the refusal. */
type PreparedHeaders =
    | { readonly ok: true; readonly headers: Headers; readonly variant: string }
    | { readonly ok: false; readonly refusal: GitHubFailure };

/**
 * The operation's headers with the controlled fields installed.
 *
 * Controlled fields never select a representation: caller values for them
 * are deleted before the variant is derived, then ours are installed.
 */
function prepareHeaders(request: GitHubRequest, token: InstallationToken): PreparedHeaders {
    let headers: Headers;
    try {
        headers = new Headers(request.headers);
    } catch {
        return { ok: false, refusal: notSentFailure("invalidHeaders") };
    }
    headers.set("accept", headers.get("accept") ?? DEFAULT_ACCEPT);
    headers.delete("authorization");
    headers.delete("if-none-match");
    headers.delete("user-agent");
    headers.delete("x-github-api-version");
    if (request.method === "POST") {
        headers.delete("content-length");
        headers.set("content-type", "application/json");
    }
    const variant = JSON.stringify(headersToRecord(headers));
    try {
        headers.set("authorization", `Bearer ${token.value}`);
        headers.set("user-agent", USER_AGENT);
        headers.set("x-github-api-version", GITHUB_API_VERSION);
    } catch {
        // Our two constants are known-good header values; only the token
        // value can make this throw.
        return { ok: false, refusal: brokenSeamFailure("tokenValue") };
    }
    return { ok: true, headers, variant };
}

// ─── The retry policy ────────────────────────────────────────────────

/** What one request does about a failure it has just classified. */
type NextStep =
    | { readonly step: "return" }
    | { readonly step: "refreshToken" }
    | { readonly step: "wait"; readonly ms: number };

/** The class core can advise on; the adapter's own two are never retried. */
function responseClassOf(failure: GitHubHttpFailureClass): FailureClass | null {
    return failure.kind === "notSent" || failure.kind === "responseTooLarge" ? null : failure;
}

/**
 * Sends one request may make on this class, counting the first.
 *
 * The rate classes get core's bound, which was measured: a limit surviving
 * three full waits is a pacing problem for an operator, not a wait problem.
 * The other two are this file's, and both are tighter than core's — see their
 * constants for why a process holding a claim spends less than a caller with
 * no deadline. A class core refuses to retry never reaches its cap.
 */
function attemptCap(kind: FailureClass["kind"]): number {
    if (kind === "tokenExpired") return TOKEN_REFRESH_ATTEMPTS;
    if (kind === "transient") return TRANSIENT_ATTEMPTS;
    return MAX_RATE_LIMIT_ATTEMPTS;
}

/** The spread added to a chosen backoff; see `BACKOFF_JITTER_FRACTION`. */
function jitterMs(kind: FailureClass["kind"], advisedMs: number, now: Date): number {
    if (kind !== "transient") return 0;
    const span = Math.floor(advisedMs * BACKOFF_JITTER_FRACTION);
    return span < 1 ? 0 : now.getTime() % span;
}

/**
 * What to do about `failure` after `attempt` earlier failures of this request,
 * given the `waitedMs` the request has already spent asleep.
 *
 * The delay is core's; what this adds is the two bounds a process holding a
 * claim needs. A wait that would breach the ceiling returns the failure
 * WITHOUT sleeping first: a partial wait spends the claim and still fails.
 */
function nextStep(failure: FailureClass, attempt: number, now: Date, waitedMs: number): NextStep {
    if (attempt + 1 >= attemptCap(failure.kind)) return { step: "return" };
    const advice = retryAdvice(failure, attempt, Math.floor(now.getTime() / 1000));
    if (advice.action === "doNotRetry") return { step: "return" };
    if (advice.action === "refreshTokenAndRetry") return { step: "refreshToken" };
    const ms = advice.ms + jitterMs(failure.kind, advice.ms, now);
    return waitedMs + ms > MAX_RETRY_WAIT_MS ? { step: "return" } : { step: "wait", ms };
}

// ─── The representation cache ────────────────────────────────────────

/** The bounded, least-recently-used store of reusable representations. */
interface RepresentationCache {
    /** The entry for this URL under this variant, made newest by the read. */
    lookup(url: string, variant: string): CachedRepresentation | undefined;
    store(url: string, entry: CachedRepresentation): void;
    remove(url: string): void;
}

function createRepresentationCache(): RepresentationCache {
    const entries = new Map<string, CachedRepresentation>();
    let retainedBytes = 0;

    const remove = (url: string): void => {
        const entry = entries.get(url);
        if (entry !== undefined) {
            retainedBytes -= entry.body.length;
            entries.delete(url);
        }
    };

    return {
        lookup(url: string, variant: string): CachedRepresentation | undefined {
            const entry = entries.get(url);
            if (entry === undefined || entry.variant !== variant) return undefined;
            // Reading an entry makes it newest in the bounded LRU.
            entries.delete(url);
            entries.set(url, entry);
            return entry;
        },
        /** Insert as newest, then evict oldest-first until under both bounds. */
        store(url: string, entry: CachedRepresentation): void {
            remove(url);
            entries.set(url, entry);
            retainedBytes += entry.body.length;
            while (
                entries.size > DEFAULT_ETAG_CACHE_ENTRIES ||
                retainedBytes > DEFAULT_ETAG_CACHE_BYTES
            ) {
                // `size > a non-negative limit` proves an entry exists, and the
                // per-entry byte cap proves a one-entry cache is under the total.
                remove(entries.keys().next().value as string);
            }
        },
        remove,
    };
}

// ─── The client ──────────────────────────────────────────────────────

export function createGitHubHttpClient({
    tokenSource,
    fetch: send = fetch,
    clock = () => new Date(),
    sleep = wait,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    timeoutSignal = AbortSignal.timeout,
}: GitHubHttpClientOptions): GitHubHttpClient {
    const cache = createRepresentationCache();
    let latestRateLimit: RateLimitSnapshot | null = null;

    const rememberRateLimit = (
        url: string,
        status: number,
        headers: Readonly<Record<string, string>>,
    ): void => {
        latestRateLimit = { url, status, headers: rateLimitHeaders(headers) };
    };

    /**
     * The exhaustion the NEXT request should assume, from what the last
     * response said — the one consumer of the rate snapshot.
     *
     * `remaining` is parsed with the seconds parser because GitHub spells it
     * with the same whole-number grammar, and permissive coercion would turn
     * a malformed count into a confident zero. A count with no usable reset is
     * ignored: pacing on it could never expire, and would wedge the client
     * behind a response it has stopped sending.
     */
    const pacingClass = (): FailureClass | null => {
        if (latestRateLimit === null) return null;
        const remaining = parseSecondsHeader(latestRateLimit.headers["x-ratelimit-remaining"]);
        const resetAt = latestRateLimit.headers["x-ratelimit-reset"];
        if (remaining.kind !== "valid" || remaining.seconds >= PRIMARY_BUDGET_RESERVE) return null;
        return parseSecondsHeader(resetAt).kind === "valid"
            ? { kind: "primaryExhausted", resetAt }
            : null;
    };

    const sendOnce = async (
        request: GitHubRequest,
        token: InstallationToken,
    ): Promise<GitHubOutcome> => {
        const prepared = prepareHeaders(request, token);
        if (!prepared.ok) return prepared.refusal;
        const { headers, variant } = prepared;

        const cached = request.method === "GET" ? cache.lookup(request.url, variant) : undefined;
        if (cached !== undefined) headers.set("if-none-match", cached.etag);

        // Capture the local age at send time. A later clock read could turn a
        // live request into a false `tokenExpired` diagnosis.
        let tokenPastExpiry: boolean;
        try {
            tokenPastExpiry = isPastExpiry(token, clock());
        } catch {
            return brokenSeamFailure("clock");
        }
        // A throwing timeout factory is a wiring defect, not retriable weather.
        let signal: AbortSignal;
        try {
            signal = timeoutSignal(timeoutMs);
        } catch {
            return brokenSeamFailure("timeoutSignal");
        }
        const init: RequestInit = {
            method: request.method,
            headers,
            // Following is deliberately not delegated to fetch: hidden 3xx
            // calls would evade origin validation, rate tracking, failure
            // classification, and the two-attempt bound.
            redirect: "manual",
            signal,
            ...(request.method === "POST" ? { body: request.body } : {}),
        };

        let response: Response;
        try {
            response = await send(request.url, init);
        } catch {
            return transportFailure();
        }

        const responseHeaders = headersToRecord(response.headers);
        rememberRateLimit(request.url, response.status, responseHeaders);

        if (response.status === 304) {
            // A 304 with nothing to reuse: the entry was evicted mid-flight,
            // or the server misbehaved. Either way a full re-read fixes it.
            if (cached === undefined) {
                return {
                    ok: false,
                    status: response.status,
                    body: "",
                    headers: responseHeaders,
                    failure: { kind: "transient" },
                };
            }
            return {
                ok: true,
                status: response.status,
                body: cached.body,
                headers: { ...cached.headers, ...responseHeaders },
                fromCache: true,
            };
        }

        let read: string | null;
        try {
            read = await boundedText(response);
        } catch {
            return {
                ok: false,
                status: response.status,
                headers: responseHeaders,
                failure: { kind: "transient" },
            };
        }
        if (read === null) {
            return {
                ok: false,
                status: response.status,
                headers: responseHeaders,
                failure: { kind: "responseTooLarge", limitBytes: MAX_RESPONSE_BODY_BYTES },
            };
        }
        const body = read;

        if (response.ok) {
            // Only a 200 speaks about the representation; a 202 or 204 must
            // not evict a validator that is still good.
            if (response.status === 200 && request.method === "GET") {
                const etag = response.headers.get("etag");
                if (etag !== null && body.length <= DEFAULT_ETAG_CACHE_ENTRY_BYTES) {
                    cache.store(request.url, {
                        etag,
                        variant,
                        body,
                        headers: representationHeaders(responseHeaders),
                    });
                } else {
                    // A 200 with no retainable validator leaves any kept entry stale.
                    cache.remove(request.url);
                }
            }
            return {
                ok: true,
                status: response.status,
                body,
                headers: responseHeaders,
                fromCache: false,
            };
        }

        return {
            ok: false,
            status: response.status,
            body,
            headers: responseHeaders,
            failure: classifyFailure({
                status: response.status,
                body,
                headers: responseHeaders,
                tokenPastExpiry,
            }),
        };
    };

    return {
        async request(request): Promise<GitHubOutcome> {
            const admitted = admit(request);
            if (!admitted.ok) return admitted.refusal;
            const safeRequest = admitted.request;

            let waitedMs = 0;
            /** This request's next move, or the broken clock that ends it. */
            const move = (failure: FailureClass, attempt: number): NextStep | "brokenClock" => {
                let now: Date;
                try {
                    now = clock();
                } catch {
                    return "brokenClock";
                }
                return nextStep(failure, attempt, now, waitedMs);
            };
            /** Pause, spending the wait from this request's own ceiling. */
            const rest = async (ms: number): Promise<GitHubFailure | null> => {
                waitedMs += ms;
                try {
                    await sleep(ms);
                } catch {
                    return brokenSeamFailure("sleep");
                }
                return null;
            };

            // Pacing runs once, before the first send: inside a request the
            // server's own advice already governs, and a retry that paused
            // twice would spend the ceiling on one failure.
            const paced = pacingClass();
            if (paced !== null) {
                const step = move(paced, 0);
                if (step === "brokenClock") return brokenSeamFailure("clock");
                if (step.step !== "wait") return { ok: false, failure: paced };
                const broken = await rest(step.ms);
                if (broken !== null) return broken;
            }

            for (let attempt = 0; ; attempt += 1) {
                let tokenOutcome: TokenOutcome;
                try {
                    tokenOutcome = await tokenSource.current();
                    if (!isWellFormedTokenOutcome(tokenOutcome)) {
                        return brokenSeamFailure("tokenSource");
                    }
                } catch {
                    // `current()` promises not to throw.
                    return brokenSeamFailure("tokenSource");
                }
                if (!tokenOutcome.ok) return tokenOutcome;
                if (request.method === "POST") {
                    const missing = LINKED_ISSUES_GRANTS.filter(
                        (grant) => !hasReadGrant(tokenOutcome.token, grant),
                    );
                    if (missing.length > 0) {
                        return {
                            ok: false,
                            failure: {
                                kind: "permissionMissing",
                                acceptedPermissions: missing.join(", "),
                            },
                        };
                    }
                }

                let outcome: GitHubOutcome;
                try {
                    outcome = await sendOnce(safeRequest, tokenOutcome.token);
                } catch {
                    // `sendOnce()` contains expected transport failures itself;
                    // what escapes it is a response object that broke mid-read.
                    return brokenSeamFailure("response");
                }
                if (outcome.ok) return outcome;
                const responseClass = responseClassOf(outcome.failure);
                if (responseClass === null) return outcome;
                // A rejected token is dropped even on the final attempt, so
                // the next `request()` starts on a fresh mint.
                if (responseClass.kind === "tokenExpired") {
                    try {
                        tokenSource.invalidate(tokenOutcome.token);
                    } catch {
                        return brokenSeamFailure("invalidate");
                    }
                }
                const step = move(responseClass, attempt);
                if (step === "brokenClock") return brokenSeamFailure("clock");
                if (step.step === "return") return outcome;
                if (step.step === "wait") {
                    const broken = await rest(step.ms);
                    if (broken !== null) return broken;
                }
            }
        },
        latestRateLimit(): RateLimitSnapshot | null {
            if (latestRateLimit === null) return null;
            return {
                ...latestRateLimit,
                headers: { ...latestRateLimit.headers },
            };
        },
    };
}
