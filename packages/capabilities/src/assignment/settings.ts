/** The settings assignment reads beside its `enabled`: one block per command. */

import { block, count, meanings, spec } from "@hiero-hackers/automation-core/author";

export const ASSIGNMENT_SETTINGS = spec({
    autoAssign: block(
        {
            claimableOnlyWhen: meanings({
                doc: "An issue is claimable only while it carries one of these meanings; empty means any open issue",
            }),
            notClaimableWhen: meanings({
                doc: "An issue carrying any of these meanings is not claimable, whatever claimableOnlyWhen says",
            }),
            capIgnores: meanings({
                doc: "An open assignment carrying any of these meanings does not count toward maxOpen",
            }),
            maxOpen: count({
                default: 2,
                doc: "How many open assignments in this repository a person may hold before a claim is refused; 0 means uncapped",
            }),
        },
        {
            doc: "Assign a commenter who uses this repository's assign command — needs mappings.commands.assign",
        },
    ),
    unassign: block(
        {},
        {
            doc: "Release the commenter's own assignment when they use this repository's unassign command — needs mappings.commands.unassign",
        },
    ),
});
