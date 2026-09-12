/** The release-assignment operation's transport: the assignees endpoint and its one verb. */

import {
    isNumberSegment,
    issuePath,
    itemViewsStaledBy,
    type EndpointShape,
    type OperationTransport,
    type VerbContext,
    type WriteVerbs,
} from "./transport.js";

/**
 * `DELETE …/issues/{n}/assignees` — one named login off the list.
 * The one admitted DELETE that carries a body, and D63 is enforced by that body: the logins it names are the only ones removed.
 */
const RELEASE_ASSIGNMENT_ENDPOINT: EndpointShape = {
    endpoint: "releaseAssignment",
    resource: "issues",
    grant: "issues:write",
    matches: (method, rest) =>
        method === "DELETE" &&
        rest.length === 2 &&
        isNumberSegment(rest[0]) &&
        rest[1] === "assignees",
    invalidates: itemViewsStaledBy,
};

export const RELEASE_ASSIGNMENT = {
    endpoints: [RELEASE_ASSIGNMENT_ENDPOINT],
    verbs: (context: VerbContext): Pick<WriteVerbs, "releaseAssignment"> => ({
        releaseAssignment: (item, login) =>
            context.apply(
                {
                    url: `${issuePath(context.repository, item)}/assignees`,
                    method: "DELETE",
                    body: JSON.stringify({ assignees: [login] }),
                    idempotency: "idempotent",
                },
                "invisible",
            ),
    }),
} satisfies OperationTransport;
