/**
 * The line itself: one JSON object per event, `at` from the injected clock,
 * and the stream chosen by the event's name. The rest of the suite injects
 * a log and reads events; this file is the only place the bytes matter.
 */

import { describe, expect, it, vi } from "vitest";
import { contained, createLogger, detailOf, type ShellEvent } from "../src/log.js";

const AT = new Date("2026-08-07T10:00:00.000Z");

/** One logger, and the two streams it wrote to. */
function collecting(): { out: string[]; err: string[]; log: (event: ShellEvent) => void } {
    const out: string[] = [];
    const err: string[] = [];
    return {
        out,
        err,
        log: createLogger({
            clock: () => AT,
            out: (line) => out.push(line),
            err: (line) => err.push(line),
        }),
    };
}

describe("one line per event", () => {
    it("carries the instant, the name and the event's own fields", () => {
        const { out, err, log } = collecting();

        log({ event: "deliveryAccepted", deliveryId: "guid-1", eventName: "issues" });

        expect(err).toEqual([]);
        expect(out).toEqual([
            '{"at":"2026-08-07T10:00:00.000Z","event":"deliveryAccepted",' +
                '"deliveryId":"guid-1","eventName":"issues"}\n',
        ]);
    });

    /**
     * One line per event, whatever the event carries. A stack trace is the
     * usual `detail`, and it is only one line because JSON escaped it.
     */
    it("ends every line, and starts no second one", () => {
        const { out, err, log } = collecting();

        log({ event: "shutdown", signal: "SIGTERM" });
        log({ event: "deliveryDuplicate", deliveryId: "guid-1", eventName: "issues" });
        log({ event: "sweepFailed", detail: "Error: nope\n    at somewhere" });

        expect(out).toHaveLength(2);
        for (const line of [...out, ...err]) {
            expect(line.endsWith("\n")).toBe(true);
            expect(line.trimEnd()).not.toContain("\n");
        }
        expect((JSON.parse(err[0]!) as { detail: string }).detail).toContain("\n    at somewhere");
    });

    it("sends what an operator should notice to stderr, and the rest to stdout", () => {
        const { out, err, log } = collecting();

        log({ event: "sweepFailed", detail: "the store is closed" });
        log({ event: "sweepRequeued", requeued: 1, deliveryIds: ["guid-1"] });
        log({ event: "deliveryConflict", deliveryId: "guid-1", eventName: "issues" });
        log({ event: "deliveryDuplicate", deliveryId: "guid-1", eventName: "issues" });

        expect(err.map((line) => (JSON.parse(line) as ShellEvent).event)).toEqual([
            "sweepFailed",
            "sweepRequeued",
            "deliveryConflict",
        ]);
        expect(out.map((line) => (JSON.parse(line) as ShellEvent).event)).toEqual([
            "deliveryDuplicate",
        ]);
    });
});

/**
 * The default sinks are the process's own streams, so a shell that took no
 * options still says what it did — and says the problems where a container
 * collecting only stderr will see them.
 */
describe("with no sinks injected", () => {
    it("writes to the process's own streams", () => {
        const out: string[] = [];
        const err: string[] = [];
        const stdout = vi
            .spyOn(process.stdout, "write")
            .mockImplementation((chunk: string | Uint8Array) => {
                out.push(String(chunk));
                return true;
            });
        const stderr = vi
            .spyOn(process.stderr, "write")
            .mockImplementation((chunk: string | Uint8Array) => {
                err.push(String(chunk));
                return true;
            });
        try {
            const log = createLogger();
            log({ event: "shutdown", signal: "SIGTERM" });
            log({ event: "sweepFailed", detail: "the store is closed" });
        } finally {
            stdout.mockRestore();
            stderr.mockRestore();
        }

        expect(out.map((line) => (JSON.parse(line) as ShellEvent).event)).toEqual(["shutdown"]);
        expect(err.map((line) => (JSON.parse(line) as ShellEvent).event)).toEqual(["sweepFailed"]);
        // The instant comes from the real clock when none was injected.
        expect(Date.parse((JSON.parse(out[0]!) as { at: string }).at)).toBeLessThanOrEqual(
            Date.now(),
        );
    });
});

describe("what a caught unknown says", () => {
    it("keeps an Error's stack, which is the half worth having", () => {
        const detail = detailOf(new Error("live externals unavailable"));

        expect(detail).toContain("live externals unavailable");
        expect(detail).toContain("log.test.ts");
    });

    it("names a stackless Error by name and message", () => {
        const stackless = new RangeError("out of range");
        delete stackless.stack;

        expect(detailOf(stackless)).toBe("RangeError: out of range");
    });

    it.each([
        ["a thrown string", "just a string", "just a string"],
        ["an object", { why: "no" }, "[object Object]"],
        ["undefined", undefined, "[object Undefined]"],
    ])("reads %s without asking it to describe itself", (_what, thrown, expected) => {
        expect(detailOf(thrown)).toBe(expected);
    });

    /** The fallback must not run code the thrower wrote. */
    it("does not call toString on what it was handed", () => {
        const hostile = {
            toString: () => {
                throw new Error("gotcha");
            },
        };

        expect(() => detailOf(hostile)).not.toThrow();
    });
});

describe("a diagnostic that cannot change what it observes", () => {
    it("swallows a throwing log, and lets a working one through", () => {
        const seen: ShellEvent[] = [];
        const broken = contained(() => {
            throw new Error("the log itself is broken");
        });
        const working = contained((event) => seen.push(event));
        const event: ShellEvent = { event: "shutdown", signal: "SIGINT" };

        expect(() => broken(event)).not.toThrow();
        working(event);
        expect(seen).toEqual([event]);
    });
});
