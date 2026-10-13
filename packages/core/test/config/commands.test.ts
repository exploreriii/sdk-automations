/**
 * A command is a whole LINE, not a substring: quoting someone else's `/assign`
 * must not execute it, and a repository whose word is `/take` must not be
 * defeated by "/take please". Code, fenced or indented, issues nothing.
 */

import { describe, expect, it } from "vitest";
import { commandInComment } from "../../src/config/index.js";
import { configWith } from "./builders.js";

describe("commandInComment", () => {
    const commanding = configWith({ commands: { assign: "/take", working: "/working" } });

    it("reads the repository's word as the platform's meaning, never the reverse", () => {
        expect(commandInComment(commanding, "/take")).toBe("assign");
        expect(commandInComment(commanding, "/assign")).toBeNull();
    });

    it("takes the first token of any line, ignoring case and trailing words", () => {
        expect(commandInComment(commanding, "hello\n  /TAKE please  \nthanks")).toBe("assign");
    });

    it("refuses a command that is not a line's first token", () => {
        expect(commandInComment(commanding, "> /take")).toBeNull();
        expect(commandInComment(commanding, "you could try /take here")).toBeNull();
    });

    it("skips blank lines rather than reading one as a word", () => {
        expect(commandInComment(commanding, "\n\n   \n/working")).toBe("working");
    });

    it.each([
        ["a backtick fence", "To claim one, type:\n```\n/take\n```"],
        ["a tilde fence", "To claim one, type:\n~~~\n/take\n~~~"],
        ["an indented fence with an info string", "  ```text\n/take\n  ```"],
    ])("reads nothing inside %s", (_fence, body) => {
        expect(commandInComment(commanding, body)).toBeNull();
    });

    it.each([
        ["four spaces", "To claim one, type:\n\n    /take"],
        ["more than four spaces", "      /take"],
        ["a tab", "\t/take"],
        ["spaces and then a tab", "   \t/take"],
    ])("reads nothing on a line indented by %s, which is code", (_indent, body) => {
        expect(commandInComment(commanding, body)).toBeNull();
    });

    it("reads a line indented by three spaces, which is not code", () => {
        expect(commandInComment(commanding, "   /take")).toBe("assign");
        expect(commandInComment(commanding, "    /working\n   /take")).toBe("assign");
    });

    it("reads a command after the fence closes", () => {
        expect(commandInComment(commanding, "```\n/working\n```\n/take")).toBe("assign");
        expect(commandInComment(commanding, "~~~\n/working\n~~~\n/take")).toBe("assign");
    });

    it("closes a fence only on its own marker", () => {
        expect(commandInComment(commanding, "```\n~~~\n/take\n```")).toBeNull();
        expect(commandInComment(commanding, "```\n~~~\n```\n/take")).toBe("assign");
    });

    it("reads nothing after a fence that never closes", () => {
        expect(commandInComment(commanding, "```\nsome code\n\n/take")).toBeNull();
    });

    it("finds nothing at all in a repository that mapped no command", () => {
        expect(commandInComment(configWith({}), "/take")).toBeNull();
    });
});
