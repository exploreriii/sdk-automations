/** What one write operation's transport is: the endpoints it may reach and the verbs it contributes. */

import type { ItemRef, PermissionGrant, RepositoryRef } from "@hiero-hackers/automation-core";
import { GITHUB_API_ORIGIN, repoPath, type GitHubWriteRequest } from "../contract.js";

// ─── The endpoints ───────────────────────────────────────────────────

/** The six write operations the endpoint matrix confirmed, by path shape. */
export type WriteEndpoint =
    | "addLabel"
    | "removeLabel"
    | "createComment"
    | "updateComment"
    | "closePullRequest"
    | "releaseAssignment";

/** Non-empty, and unchanged by a decode-then-encode round trip. */
export function isEncodedSegment(segment: string | undefined): boolean {
    if (segment === undefined || segment.length === 0) return false;
    try {
        return encodeURIComponent(decodeURIComponent(segment)) === segment;
    } catch {
        return false;
    }
}

export function isNumberSegment(segment: string | undefined): boolean {
    return segment !== undefined && /^[1-9][0-9]*$/.test(segment);
}

export interface EndpointShape {
    readonly endpoint: WriteEndpoint;
    readonly resource: "issues" | "pulls";
    /** The grant a 403 on this endpoint names; a write takes nothing weaker (D123). */
    readonly grant: PermissionGrant;
    /** Structural match on method and the path's tail — never derived from the builder (D129). */
    matches(method: string, rest: readonly string[]): boolean;
    /** Cache keys a landed write makes untrustworthy. */
    invalidates(url: URL): readonly string[];
}

/** Whole-href resource prefixes: the item, one of its two lists, its timeline. */
export function itemStaledBy(url: URL, list: "comments" | "labels"): readonly string[] {
    const item = `${GITHUB_API_ORIGIN}${url.pathname.split("/").slice(0, 6).join("/")}`;
    return [item, `${item}/${list}`, `${item}/timeline`];
}

/** The three hrefs one item's state is read from: both its views, and its timeline. */
export function itemViewsStaledBy(url: URL): readonly string[] {
    const [, , owner, repo, , number] = url.pathname.split("/");
    const repository = `${GITHUB_API_ORIGIN}/repos/${String(owner)}/${String(repo)}`;
    const issue = `${repository}/issues/${String(number)}`;
    return [issue, `${issue}/timeline`, `${repository}/pulls/${String(number)}`];
}

// ─── The verbs ───────────────────────────────────────────────────────

/** `applied` is the postcondition holding because we made it hold; `already` is it holding without us. */
export type WriteResult =
    | { readonly outcome: "applied" }
    | { readonly outcome: "already" }
    | { readonly outcome: "conflict"; readonly detail: string }
    | { readonly outcome: "forbidden"; readonly detail: string }
    | { readonly outcome: "retryLater"; readonly detail: string }
    | { readonly outcome: "unknown"; readonly detail: string }
    | { readonly outcome: "unsupported"; readonly detail: string };

export interface WriteVerbs {
    /** Idempotent: adding a label already there is a no-op. */
    addLabel(item: ItemRef, label: string): Promise<WriteResult>;
    /** ONE named label. There is no remove-by-prefix here or below (D4). */
    removeLabel(item: ItemRef, label: string): Promise<WriteResult>;
    /** The one non-idempotent verb. */
    createComment(item: ItemRef, body: string): Promise<WriteResult>;
    updateComment(commentId: number, body: string): Promise<WriteResult>;
    /** Closed unmerged; the reason is the notice's, never GitHub's. */
    closePullRequest(item: ItemRef): Promise<WriteResult>;
    /** ONE named login off the item's assignees, never the list whole (D63). */
    releaseAssignment(item: ItemRef, login: string): Promise<WriteResult>;
}

/** The one status the endpoints disagree about; the fallback is `invisible`, never `already` (D46). */
export type NotFoundMeaning = "invisible" | "labelMayBeAbsent";

/** Nothing a builder receives is validated; the admission gate refuses a bad URL structurally. */
export interface VerbContext {
    readonly repository: RepositoryRef;
    apply(request: GitHubWriteRequest, notFound: NotFoundMeaning): Promise<WriteResult>;
}

export function issuePath(repository: RepositoryRef, item: ItemRef): string {
    return `${repoPath(repository)}/issues/${String(item.number)}`;
}

/** The pull-request view of the same number — a different row, and a different grant. */
export function pullPath(repository: RepositoryRef, item: ItemRef): string {
    return `${repoPath(repository)}/pulls/${String(item.number)}`;
}

// ─── The transport ───────────────────────────────────────────────────

export interface OperationTransport {
    /** Empty is a legal, refusing transport. */
    readonly endpoints: readonly EndpointShape[];
    verbs(context: VerbContext): Partial<WriteVerbs>;
}
