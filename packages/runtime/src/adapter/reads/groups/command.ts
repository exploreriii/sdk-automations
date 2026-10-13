/** The command a comment issued: a sweep reads no comment, so it has none to answer. */

import { unreadable } from "../items.js";
import type { SweepGroup } from "./module.js";

export const command = {
    reads: [],
    read: {
        issue: () => Promise.resolve(unreadable("a sweep carries no comment")),
    },
} satisfies SweepGroup<"command">;
