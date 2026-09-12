/**
 * The registry: one transport per operation, and the two walks over it.
 * `TRANSPORTS` is the only place the operations are listed.
 */

import type { IntentOperation } from "@hiero-hackers/automation-core";
import { APPLY_MAPPED_LABEL } from "./applyMappedLabel.js";
import { ASSIGN } from "./assign.js";
import { CLOSE_PULL_REQUEST } from "./closePullRequest.js";
import { LOCK_ISSUE } from "./lockIssue.js";
import { POST_MANAGED_COMMENT } from "./postManagedComment.js";
import { RELEASE_ASSIGNMENT } from "./releaseAssignment.js";
import {
    isEncodedSegment,
    type EndpointShape,
    type OperationTransport,
    type VerbContext,
    type WriteEndpoint,
    type WriteVerbs,
} from "./transport.js";
import { UNASSIGN } from "./unassign.js";
import { UNLOCK_ISSUE } from "./unlockIssue.js";

/** Every write operation's transport, keyed by the operation core names. */
export const TRANSPORTS: { readonly [K in IntentOperation]: OperationTransport } = {
    postManagedComment: POST_MANAGED_COMMENT,
    applyMappedLabel: APPLY_MAPPED_LABEL,
    assign: ASSIGN,
    unassign: UNASSIGN,
    releaseAssignment: RELEASE_ASSIGNMENT,
    closePullRequest: CLOSE_PULL_REQUEST,
    lockIssue: LOCK_ISSUE,
    unlockIssue: UNLOCK_ISSUE,
};

/** What admitting one write endpoint establishes: its name, its grant, and its staling. */
export interface MatchedEndpoint {
    readonly endpoint: WriteEndpoint;
    readonly grant: EndpointShape["grant"];
    readonly invalidates: readonly string[];
}

/**
 * The write endpoint this method and path ARE, or `null`.
 * The shared preamble is checked here once; each shape judges the surface it sits on, the method and the tail — an unknown surface matches no shape and so is refused.
 */
export function writeEndpointOf(method: string, url: URL): MatchedEndpoint | null {
    if (url.search !== "" || url.hash !== "") return null;
    const [repos, owner, repo, resource, ...rest] = url.pathname.split("/").slice(1);
    if (repos !== "repos") return null;
    if (!isEncodedSegment(owner) || !isEncodedSegment(repo)) return null;

    for (const transport of Object.values(TRANSPORTS)) {
        for (const shape of transport.endpoints) {
            if (shape.resource === resource && shape.matches(method, rest)) {
                return {
                    endpoint: shape.endpoint,
                    grant: shape.grant,
                    invalidates: shape.invalidates(url),
                };
            }
        }
    }
    return null;
}

/**
 * The whole write surface, composed from the verbs the transports contribute.
 * Each transport's `verbs` names the verbs it owns, so one nothing builds fails to compile.
 */
export function writeVerbsOf(context: VerbContext): WriteVerbs {
    return {
        ...APPLY_MAPPED_LABEL.verbs(context),
        ...POST_MANAGED_COMMENT.verbs(context),
        ...ASSIGN.verbs(),
        ...UNASSIGN.verbs(),
        ...RELEASE_ASSIGNMENT.verbs(context),
        ...CLOSE_PULL_REQUEST.verbs(context),
        ...LOCK_ISSUE.verbs(),
        ...UNLOCK_ISSUE.verbs(),
    };
}
