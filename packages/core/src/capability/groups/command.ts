/** The command a comment issued, by whom and when: read off the comment, so no other producer has one. */

import type { GroupModule } from "./module.js";

const AT = new Date("2026-07-01T00:00:00.000Z");

export const command = {
    readBy: { issue: ["issue_comment"] },
    fromDelivery: (delivery) => delivery.command ?? null,
    fixture: { issue: { issued: null, by: "actor", at: AT } },
} satisfies GroupModule<"command">;
