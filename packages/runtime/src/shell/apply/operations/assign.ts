/** Putting one person on an item's assignees at their own request: the plan, its row, and the assignee read that proves it. */

import { planWithNotice, type OperationHandler } from "./handler.js";
import { text } from "./row.js";

export const assign: OperationHandler<"assign"> = {
    verbs: ["assign"],
    traits: { recordsWarning: false, activityRead: false },

    /** The act, then the notice it carries — so the notice never announces an assignment GitHub declined. */
    plan: (effect) =>
        planWithNotice(
            effect,
            { verb: "assign", login: effect.intent.desired.login },
            effect.intent.desired.notice?.body ?? null,
        ),

    serialize: (call) => ({ verb: call.verb, login: call.login }),

    parse(row) {
        const login = text(row, "login");
        return login === null ? null : { verb: "assign", login };
    },

    send: async (call, pass) => await pass.writer.assign(pass.item, call.login, pass.allowance),

    /**
     * This login, on the list the item carries. The read is the only proof: GitHub answers 201
     * for a login it silently declined to assign (6.16).
     */
    async confirm(call, pass) {
        const seen = await pass.reader.assignees(pass.item);
        if (!seen.ok) return "unknown";
        return seen.value.includes(call.login) ? "held" : "notHeld";
    },
};
