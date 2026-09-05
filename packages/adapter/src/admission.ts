/**
 * The endpoint-permission matrix as code: may this request be sent?
 *
 * Every request passes this gate before a token is acquired, so a refusal
 * never costs a mint, and the URL leaves normalised so everything downstream
 * sees one spelling. What it judges is structural — the pinned origin, the one
 * GraphQL query this package may POST, and the four write endpoints
 * `design/findings/endpoint-permission-matrix.md` confirmed, matched by path
 * SHAPE rather than by text. D4 is enforced by that shape rather than by a
 * check; `writeEndpointOf` says how. It answers the permission half of the
 * same question too: the grants a request needs and its token does not carry.
 *
 * A write that passes carries one more answer out — the cache keys its landing
 * makes untrustworthy. Nothing here sends anything, waits, or reads a
 * response: that is `http.ts`, this file's only caller. The vocabulary it
 * refuses in is `contract.ts`.
 *
 * In order below: the write endpoints, the admitted request, the grants.
 */

import type { PermissionGrant } from "@hiero-hackers/automation-core";
import {
    bodyOf,
    GITHUB_API_ORIGIN,
    GITHUB_GRAPHQL_URL,
    isWrite,
    notSentFailure,
    type GitHubFailure,
    type GitHubGraphqlRequest,
    type GitHubRequest,
    type GitHubWriteRequest,
    type NotSentReason,
} from "./contract.js";
import type { InstallationToken } from "./token.js";
import { jsonRecordOf } from "./untrusted.js";

// ─── The write endpoints ─────────────────────────────────────────────

/** The four write operations the endpoint matrix confirmed, by path shape. */
export type WriteEndpoint = "addLabel" | "removeLabel" | "createComment" | "updateComment";

/**
 * One path segment spelled the way `repoPath` spells one: non-empty, and
 * unchanged by a decode-then-encode round trip.
 *
 * Matching a write URL structurally means matching what this package itself
 * builds. A segment that does not round-trip was double-encoded, or carries a
 * character `encodeURIComponent` never emits — either way it is not ours, and
 * a gate that accepted it would be matching a path shape nobody wrote.
 */
function isEncodedSegment(segment: string | undefined): boolean {
    if (segment === undefined || segment.length === 0) return false;
    try {
        return encodeURIComponent(decodeURIComponent(segment)) === segment;
    } catch {
        return false;
    }
}

/** A positive decimal item id, in the one spelling GitHub's paths use. */
function isNumberSegment(segment: string | undefined): boolean {
    return segment !== undefined && /^[1-9][0-9]*$/.test(segment);
}

/**
 * The write endpoint this method and path ARE, or `null` for anything else.
 *
 * Structural, not textual: the path is split into segments, the literals must
 * be literal, and every variable segment must be a number or a
 * `repoPath`-encoded name. A query string or fragment disqualifies a write
 * outright — none of the four takes one, and a parameter is how an admitted
 * shape would grow a second meaning.
 *
 * D4 is enforced by this shape rather than by a check: the only removal
 * admitted is `DELETE …/labels/{name}`, which names one label. GitHub's
 * remove-every-label endpoint (the same path without `{name}`) matches nothing
 * here, so "remove by prefix" cannot be expressed through this client.
 */
function writeEndpointOf(method: string, url: URL): WriteEndpoint | null {
    if (url.search !== "" || url.hash !== "") return null;
    const [repos, owner, repo, issues, ...rest] = url.pathname.split("/").slice(1);
    if (repos !== "repos" || issues !== "issues") return null;
    if (!isEncodedSegment(owner) || !isEncodedSegment(repo)) return null;

    // `PATCH …/issues/comments/{id}` is the one shape that does not name an
    // item number; it is checked first so the number check below can be shared.
    if (method === "PATCH") {
        return rest[0] === "comments" && isNumberSegment(rest[1]) && rest.length === 2
            ? "updateComment"
            : null;
    }
    if (!isNumberSegment(rest[0])) return null;
    if (method === "POST" && rest.length === 2) {
        if (rest[1] === "labels") return "addLabel";
        return rest[1] === "comments" ? "createComment" : null;
    }
    if (method === "DELETE") {
        return rest[1] === "labels" && isEncodedSegment(rest[2]) && rest.length === 3
            ? "removeLabel"
            : null;
    }
    return null;
}

/**
 * Cache keys a landed write makes untrustworthy.
 *
 * Keys are whole hrefs, so this returns RESOURCE prefixes and the cache drops
 * each one's query-string variants too (`…/comments` and
 * `…/comments?per_page=100&page=1` are one resource read two ways).
 *
 * What it cannot reach, and neither can any honest version of it. A list page
 * that merely CONTAINS the item — `…/issues?labels=…` — is a different
 * resource under a filter this cannot enumerate. `PATCH …/issues/comments/{id}`
 * does not name its parent issue, so the issue's comment list survives an
 * edit. And the cache is per client instance: another process holds its own.
 */
function invalidatedBy(endpoint: WriteEndpoint, url: URL): readonly string[] {
    if (endpoint === "updateComment") return [`${GITHUB_API_ORIGIN}${url.pathname}`];
    // The other three all hang off `/repos/{o}/{r}/issues/{n}`, which is the
    // first five segments of a path the matcher has already proved.
    const item = `${GITHUB_API_ORIGIN}${url.pathname.split("/").slice(0, 6).join("/")}`;
    const list = endpoint === "createComment" ? "comments" : "labels";
    // The timeline carries both a label event and a comment event, so every
    // one of the three stales it.
    return [item, `${item}/${list}`, `${item}/timeline`];
}

// ─── The admitted request ────────────────────────────────────────────

type GitHubApiUrl =
    | { readonly ok: true; readonly url: URL }
    | { readonly ok: false; readonly refused: "malformedUrl" | "disallowedOrigin" };

function githubApiUrl(rawUrl: string): GitHubApiUrl {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return { ok: false, refused: "malformedUrl" };
    }
    return url.origin === GITHUB_API_ORIGIN
        ? { ok: true, url }
        : { ok: false, refused: "disallowedOrigin" };
}

/** What admitting a write learned, for the client's retry policy and its cache. */
export interface AdmittedWrite {
    readonly endpoint: WriteEndpoint;
    readonly invalidates: readonly string[];
}

/** A request as it may be sent, or the refusal that stops it here. */
export type AdmittedRequest =
    | {
          readonly ok: true;
          readonly request: GitHubRequest;
          readonly write: AdmittedWrite | null;
      }
    | { readonly ok: false; readonly refusal: GitHubFailure };

const refused = (reason: Exclude<NotSentReason, "brokenSeam">): AdmittedRequest => ({
    ok: false,
    refusal: notSentFailure(reason),
});

/**
 * The one GraphQL query this package may POST, checked before it is sent.
 * Nothing else may reach `/graphql`, and this operation may reach nothing else.
 */
function admitGraphql(request: GitHubGraphqlRequest, url: URL): AdmittedRequest {
    if (url.href !== GITHUB_GRAPHQL_URL) return refused("disallowedMethod");
    if (typeof request.body !== "string") return refused("invalidBody");
    try {
        const body = JSON.parse(request.body) as Record<string, unknown>;
        if (
            body.operationName !== "LinkedIssues" ||
            typeof body.query !== "string" ||
            !/^\s*query\s+LinkedIssues(?:\s|\()/.test(body.query)
        ) {
            return refused("invalidBody");
        }
    } catch {
        return refused("invalidBody");
    }
    return { ok: true, request: { ...request, url: url.href }, write: null };
}

/**
 * A write against the per-endpoint allowlist.
 *
 * The body rule is per endpoint rather than per method, because the four
 * endpoints disagree: three carry a JSON object and the label removal carries
 * nothing. A body where none belongs is refused rather than dropped — sending
 * a request the caller did not write is worse than not sending it.
 */
function admitWrite(request: GitHubWriteRequest, url: URL): AdmittedRequest {
    const endpoint = writeEndpointOf(request.method, url);
    if (endpoint === null) return refused("disallowedMethod");
    // Unreachable through the type, and the retry policy reads this field.
    // A declaration that is neither word is a malformed request, not a write.
    if (request.idempotency !== "idempotent" && request.idempotency !== "nonIdempotent") {
        return refused("invalidBody");
    }
    const body = bodyOf(request);
    if (endpoint === "removeLabel") {
        if (body !== undefined) return refused("invalidBody");
    } else {
        if (body === undefined || jsonRecordOf(body) === null) return refused("invalidBody");
    }
    return {
        ok: true,
        request: { ...request, url: url.href },
        write: { endpoint, invalidates: invalidatedBy(endpoint, url) },
    };
}

/**
 * The gate every request passes before a token is acquired: the admitted
 * methods, the pinned origin, the one GraphQL query this package may POST, and
 * the four write endpoints the matrix confirmed.
 *
 * It runs first so a refusal never costs a mint, and it normalises the URL so
 * everything downstream — the cache key included — sees one spelling.
 */
export function admit(request: GitHubRequest): AdmittedRequest {
    const write = isWrite(request);
    if (!write && request.method !== "GET" && request.method !== "POST") {
        return refused("disallowedMethod");
    }
    const parsed = githubApiUrl(request.url);
    if (!parsed.ok) return refused(parsed.refused);
    if (write) return admitWrite(request, parsed.url);
    if (request.method === "POST") return admitGraphql(request, parsed.url);
    return { ok: true, request: { ...request, url: parsed.url.href }, write: null };
}

// ─── The grants ──────────────────────────────────────────────────────

const LINKED_ISSUES_GRANTS: readonly PermissionGrant[] = ["issues:read", "pull_requests:read"];

/** Every admitted write is an issue-surface write; nothing weaker allows one. */
const WRITE_GRANT: PermissionGrant = "issues:write";

function hasReadGrant(token: InstallationToken, required: PermissionGrant): boolean {
    const write = `${required.slice(0, -4)}write`;
    return token.grants.some((grant) => grant === required || grant === write);
}

/**
 * Grants this request needs and the token does not carry.
 *
 * The read-side precheck (D123) is the pattern; what differs is what counts as
 * enough. A read is satisfied by the matching write grant, because write
 * implies read. A write is satisfied by nothing weaker than itself, so the
 * check is equality and the accepted permission it reports is the exact grant
 * an installation would have to add.
 */
export function missingGrants(
    request: GitHubRequest,
    token: InstallationToken,
): readonly PermissionGrant[] {
    if (isWrite(request)) {
        return token.grants.some((grant) => grant === WRITE_GRANT) ? [] : [WRITE_GRANT];
    }
    if (request.method !== "POST") return [];
    return LINKED_ISSUES_GRANTS.filter((grant) => !hasReadGrant(token, grant));
}
