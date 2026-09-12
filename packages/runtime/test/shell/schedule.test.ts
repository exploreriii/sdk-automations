import { describe, expect, it } from "vitest";
import { scheduleOfSweptId, sweptItemId } from "../../src/shell/schedule.js";

describe("a swept item's id", () => {
    it("names the schedule it was minted from, and a bare id names itself", () => {
        const swept = sweptItemId("sweep:o/r", { kind: "issue", number: 40 });
        expect(scheduleOfSweptId(swept)).toBe("sweep:o/r");
        expect(scheduleOfSweptId("bare")).toBe("bare");
    });
});
