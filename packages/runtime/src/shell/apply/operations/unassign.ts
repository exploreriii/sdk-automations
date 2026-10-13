/** Taking one person off an item at their own request: the plan, its row, and the assignee read that proves it. */

import { planWithNotice, type OperationHandler } from "./handler.js";
import { text } from "./row.js";

export const unassign: OperationHandler<"unassign"> = {
    verbs: ["unassign"],
    traits: { recordsWarning: false, activityRead: false },

    /** The act, then the notice it carries — so the notice never announces a release that did not land. */
    plan: (effect) =>
        planWithNotice(
            effect,
            { verb: "unassign", login: effect.intent.desired.login },
            effect.intent.desired.notice?.body ?? null,
        ),

    serialize: (call) => ({ verb: call.verb, login: call.login }),

    parse(row) {
        const login = text(row, "login");
        return login === null ? null : { verb: "unassign", login };
    },

    /** The release endpoint, one named login, so the other assignees stay where they are (D63, 6.10, 6.16). */
    send: async (call, pass) =>
        await pass.writer.releaseAssignment(pass.item, call.login, pass.allowance),

    /** This login, gone from the list the item carries. */
    async confirm(call, pass) {
        const seen = await pass.reader.assignees(pass.item);
        if (!seen.ok) return "unknown";
        return seen.value.includes(call.login) ? "notHeld" : "held";
    },
};
