/** The close-pull-request operation's transport: one endpoint on the pull surface, one verb. */

import {
    isNumberSegment,
    itemViewsStaledBy,
    pullPath,
    type EndpointShape,
    type OperationTransport,
    type VerbContext,
    type WriteVerbs,
} from "./transport.js";

/**
 * `PATCH …/pulls/{n}` — the pull request itself, set closed.
 * The only admitted write whose path names no sub-resource, so the number is the whole tail.
 */
const CLOSE_PULL_REQUEST_ENDPOINT: EndpointShape = {
    endpoint: "closePullRequest",
    resource: "pulls",
    grant: "pull_requests:write",
    matches: (method, rest) => method === "PATCH" && rest.length === 1 && isNumberSegment(rest[0]),
    invalidates: itemViewsStaledBy,
};

export const CLOSE_PULL_REQUEST = {
    endpoints: [CLOSE_PULL_REQUEST_ENDPOINT],
    verbs: (context: VerbContext): Pick<WriteVerbs, "closePullRequest"> => ({
        closePullRequest: (item) =>
            context.apply(
                {
                    url: pullPath(context.repository, item),
                    method: "PATCH",
                    body: JSON.stringify({ state: "closed" }),
                    idempotency: "idempotent",
                },
                "invisible",
            ),
    }),
} satisfies OperationTransport;
