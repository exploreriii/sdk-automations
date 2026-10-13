/** The sweep's read of the `command` group: a sweep reads no comment, so it never answers one. */

import { describe, expect, it } from "vitest";
import { command } from "../../../../src/adapter/reads/groups/command.js";
import { SWEEP_GROUPS } from "../../../../src/adapter/reads/groups/index.js";

describe("the sweep's command read", () => {
    it("answers unreadable, never a command", async () => {
        expect(await command.read.issue()).toEqual({
            ok: false,
            detail: "a sweep carries no comment",
        });
    });

    it("is the registry's module, built from no read of its own", () => {
        expect(SWEEP_GROUPS.command).toBe(command);
        expect(command.reads).toEqual([]);
    });
});
