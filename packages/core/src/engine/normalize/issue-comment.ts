/**
 * The issue-comment family: what an `issue_comment` delivery becomes once the
 * shared preamble has read it — an issue record whose `command` is projected
 * through `mappings.commands`, so a capability reads `assign`, never `/assign`.
 */

import { deliveredGroups, type GroupValue, type ProducedFacts } from "../../capability/index.js";
import { commandInComment } from "../../config/index.js";
import { projectIssue, type ClosureReason } from "../../workflow/index.js";
import { isRecord, timestamp, type DeliveryFacts } from "./payload.js";
import { malformed, type NormalizeResult } from "./verdict.js";

/** Issue closure, from what this payload alone can see — `issues.ts`'s reading. */
function issueClosure(item: Record<string, unknown>): ClosureReason | null {
    return item["state"] === "closed" ? "closedByHuman" : null;
}

/** What the comment readably says, or `null` when its shape is not GitHub's. */
function commentOf(
    facts: DeliveryFacts,
): { readonly body: string; readonly by: string; readonly at: Date } | null {
    const comment = facts.payload["comment"];
    if (!isRecord(comment)) return null;
    const user = comment["user"];
    const at = timestamp(comment["created_at"]);
    if (typeof comment["body"] !== "string" || !isRecord(user) || at === null) return null;
    if (typeof user["login"] !== "string" || user["login"] === "") return null;
    return { body: comment["body"], by: user["login"], at };
}

/** The command group; only a `created` comment issues one, so an edit reads `issued: null`. */
function commandOf(
    facts: DeliveryFacts,
    comment: { readonly body: string; readonly by: string; readonly at: Date },
): GroupValue<"issue", "command"> {
    const issued = facts.action === "created" ? commandInComment(facts.config, comment.body) : null;
    return { issued, by: comment.by, at: comment.at };
}

/** The `issue_comment` entry of the registry. */
export const issueCommentNormalizer = {
    event: "issue_comment",
    itemKey: "issue",
    normalize(facts: DeliveryFacts): NormalizeResult {
        if (facts.item["pull_request"] !== undefined) {
            return malformed(
                "commentUnreadable",
                "issue_comment: a comment on a pull request carries no merged state",
            );
        }
        const comment = commentOf(facts);
        if (comment === null) {
            return malformed("commentUnreadable", "issue_comment: comment unreadable");
        }
        const delivered = deliveredGroups("issue_comment", "issue", {
            ...facts,
            command: commandOf(facts, comment),
        });
        if (!delivered.ok) return malformed(delivered.code, delivered.detail);
        return {
            kind: "facts",
            facts: {
                kind: "issue",
                repository: facts.repository,
                item: { kind: "issue", number: facts.number },
                observedAt: facts.observedAt,
                trigger: {
                    kind: "event",
                    event: "issue_comment",
                    ...(facts.deliveryId === undefined ? {} : { deliveryId: facts.deliveryId }),
                },
                author: facts.author,
                actor: facts.actor,
                arrival: null,
                position: projectIssue({
                    closedBy: issueClosure(facts.item),
                    meanings: facts.meanings,
                }),
                ...delivered.groups,
            } satisfies ProducedFacts<"issue_comment", "issue">,
        };
    },
} as const;
