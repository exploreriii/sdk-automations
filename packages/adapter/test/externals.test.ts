/**
 * The live externals: grants ride the token, and ordering evidence answers
 * a Date, a confident null, or "unknown" — with a failure never laundered
 * into either of the others. Timeline bodies here are SYNTHETIC, shaped
 * from GitHub's documented timeline format, not recorded traffic.
 */

import { describe, expect, it } from "vitest";
import type { ItemRef } from "@hiero-hackers/automation-core";
import {
    causeFingerprintOf,
    installationGrants,
    liveExternalsForDelivery,
    orderingEvidenceSource,
} from "../src/externals.js";
import {
    failure,
    httpHarness as harness,
    installationToken as token,
    scriptedTokenSource as tokenSource,
    success,
} from "./harness.js";

const ITEM: ItemRef = { kind: "issue", number: 7 };
const REPOSITORY = { owner: "hiero-hackers", repo: "sdk-automations" };
const TIMELINE_URL = "https://api.github.com/repos/hiero-hackers/sdk-automations/issues/7/timeline";

function entry(
    event: string,
    login: string,
    createdAt: string,
    type: "User" | "Bot" = "User",
): unknown {
    return { event, actor: { login, type }, created_at: createdAt };
}

function page(events: readonly unknown[], headers?: Record<string, string>): Response {
    return success(JSON.stringify(events), headers);
}

/** A `link` header naming `rel="last"`, the shape GitHub paginates with. */
function linkTo(lastPage: number): Record<string, string> {
    return {
        link:
            `<${TIMELINE_URL}?per_page=100&page=2>; rel="next", ` +
            `<${TIMELINE_URL}?per_page=100&page=${String(lastPage)}>; rel="last"`,
    };
}

function source(
    steps: Parameters<typeof harness>[0],
    cause?: { actorLogin: string; observedAt: Date },
) {
    const built = harness(steps);
    const lookup = orderingEvidenceSource({
        http: built.client,
        repository: REPOSITORY,
        ...(cause === undefined ? {} : { cause }),
    });
    return { lookup, scripted: built.scripted };
}

describe("installation grants", () => {
    it("answers with the live token's grants", async () => {
        const { source } = tokenSource([{ ok: true, token: token("t") }]);

        expect(await installationGrants(source)).toEqual({
            ok: true,
            grants: ["issues:write"],
        });
    });

    it("propagates a classified mint failure, never an empty grant list", async () => {
        const { source } = tokenSource([{ ok: false, failure: { kind: "transient" } }]);

        expect(await installationGrants(source)).toEqual({
            ok: false,
            failure: { kind: "transient" },
        });
    });

    it("moves with the token when a refresh changes the grants", async () => {
        const widened = { ...token("t2"), grants: ["issues:write", "contents:read"] } as const;
        const { source } = tokenSource([
            { ok: true, token: token("t1") },
            { ok: true, token: widened },
        ]);

        expect(await installationGrants(source)).toEqual({
            ok: true,
            grants: ["issues:write"],
        });
        expect(await installationGrants(source)).toEqual({
            ok: true,
            grants: ["issues:write", "contents:read"],
        });
    });
});

describe("ordering evidence", () => {
    it("answers the newest human change on a single page", async () => {
        const { lookup, scripted } = source([
            page([
                entry("labeled", "maintainer", "2026-08-20T10:00:00Z"),
                entry("closed", "maintainer", "2026-08-20T12:00:00Z"),
                entry("labeled", "app[bot]", "2026-08-21T09:00:00Z", "Bot"),
            ]),
        ]);

        expect(await lookup(ITEM)).toEqual(new Date("2026-08-20T12:00:00Z"));
        expect(scripted.calls).toHaveLength(1);
        expect(scripted.calls[0]!.url).toBe(`${TIMELINE_URL}?per_page=100&page=1`);
    });

    it("answers null when only bots and uncounted kinds acted", async () => {
        const { lookup } = source([
            page([
                entry("labeled", "app[bot]", "2026-08-20T10:00:00Z", "Bot"),
                entry("commented", "maintainer", "2026-08-20T11:00:00Z"),
                entry("milestoned", "maintainer", "2026-08-20T12:00:00Z"),
                entry("cross-referenced", "maintainer", "2026-08-20T13:00:00Z"),
            ]),
        ]);

        expect(await lookup(ITEM)).toBeNull();
    });

    it("excludes the causing event: same actor and second only", async () => {
        const cause = { actorLogin: "maintainer", observedAt: new Date("2026-08-20T10:00:00Z") };
        const causeOnly = source(
            [page([entry("labeled", "maintainer", "2026-08-20T10:00:00Z")])],
            cause,
        );
        expect(await causeOnly.lookup(ITEM)).toBeNull();

        // A DIFFERENT actor in the cause's second still counts (D33).
        const tie = source(
            [page([entry("labeled", "other-human", "2026-08-20T10:00:00Z")])],
            cause,
        );
        expect(await tie.lookup(ITEM)).toEqual(new Date("2026-08-20T10:00:00Z"));

        // The same actor a second LATER is genuinely newer intent.
        const later = source(
            [page([entry("labeled", "maintainer", "2026-08-20T10:00:01Z")])],
            cause,
        );
        expect(await later.lookup(ITEM)).toEqual(new Date("2026-08-20T10:00:01Z"));
    });

    it("reads each item once per delivery, sharing the in-flight read", async () => {
        // A function step mints a fresh Response per call — a body reads once.
        const { lookup, scripted } = source([() => page([])]);

        const [a, b] = await Promise.all([lookup(ITEM), lookup(ITEM)]);
        await lookup(ITEM);
        expect(a).toBeNull();
        expect(b).toBeNull();
        expect(scripted.calls).toHaveLength(1);

        await lookup({ kind: "issue", number: 8 });
        expect(scripted.calls).toHaveLength(2);
    });

    it("answers unknown for a failed read, never null", async () => {
        const failing = source([failure(500, "boom"), failure(500, "boom")]);
        expect(await failing.lookup(ITEM)).toBe("unknown");

        const malformed = source([success("not json")]);
        expect(await malformed.lookup(ITEM)).toBe("unknown");

        const nonArray = source([success('{"events": []}')]);
        expect(await nonArray.lookup(ITEM)).toBe("unknown");
    });

    it("answers unknown when a counted event cannot be ordered", async () => {
        const badDate = source([page([entry("labeled", "maintainer", "not a date")])]);
        expect(await badDate.lookup(ITEM)).toBe("unknown");

        const missingDate = source([page([{ event: "labeled", actor: { type: "User" } }])]);
        expect(await missingDate.lookup(ITEM)).toBe("unknown");
    });

    it("does not count a counted kind whose actor is absent", async () => {
        const { lookup } = source([
            page([{ event: "labeled", created_at: "2026-08-20T10:00:00Z" }]),
        ]);
        expect(await lookup(ITEM)).toBeNull();
    });

    it("treats a link header without rel=last as a single page", async () => {
        const { lookup, scripted } = source([
            page([entry("labeled", "maintainer", "2026-08-20T10:00:00Z")], {
                link: `<${TIMELINE_URL}?per_page=100&page=1>; rel="prev"`,
            }),
        ]);

        expect(await lookup(ITEM)).toEqual(new Date("2026-08-20T10:00:00Z"));
        expect(scripted.calls).toHaveLength(1);
    });

    it("answers unknown when a descending page fails or cannot be ordered", async () => {
        const failing = source([page([], linkTo(2)), failure(500, "boom"), failure(500, "boom")]);
        expect(await failing.lookup(ITEM)).toBe("unknown");

        const unparsable = source([
            page([], linkTo(2)),
            page([entry("labeled", "maintainer", "not a date")]),
        ]);
        expect(await unparsable.lookup(ITEM)).toBe("unknown");
    });

    it("finds the newest change on the last page of two", async () => {
        const { lookup, scripted } = source([
            page([entry("labeled", "maintainer", "2026-08-01T00:00:00Z")], linkTo(2)),
            page([entry("reopened", "maintainer", "2026-08-21T00:00:00Z")]),
        ]);

        expect(await lookup(ITEM)).toEqual(new Date("2026-08-21T00:00:00Z"));
        expect(scripted.calls).toHaveLength(2);
        expect(scripted.calls[1]!.url).toBe(`${TIMELINE_URL}?per_page=100&page=2`);
    });

    it("answers null across two fully visited pages with no human change", async () => {
        const { lookup, scripted } = source([
            page([entry("labeled", "app[bot]", "2026-08-01T00:00:00Z", "Bot")], linkTo(2)),
            page([]),
        ]);

        expect(await lookup(ITEM)).toBeNull();
        expect(scripted.calls).toHaveLength(2);
    });

    it("stops paying once the last page answers, even on a long timeline", async () => {
        const { lookup, scripted } = source([
            page([], linkTo(5)),
            page([entry("unassigned", "maintainer", "2026-08-22T00:00:00Z")]),
        ]);

        expect(await lookup(ITEM)).toEqual(new Date("2026-08-22T00:00:00Z"));
        expect(scripted.calls).toHaveLength(2);
        expect(scripted.calls[1]!.url).toBe(`${TIMELINE_URL}?per_page=100&page=5`);
    });

    it("answers unknown at the call cap when coverage stays partial", async () => {
        // A human change sits on page 1, but pages 2-3 were never read: a
        // Date from page 1 could understate the newest change, so refuse.
        const { lookup, scripted } = source([
            page([entry("labeled", "maintainer", "2026-08-01T00:00:00Z")], linkTo(5)),
            page([]),
            page([]),
        ]);

        expect(await lookup(ITEM)).toBe("unknown");
        expect(scripted.calls).toHaveLength(3);
        expect(scripted.calls[1]!.url).toBe(`${TIMELINE_URL}?per_page=100&page=5`);
        expect(scripted.calls[2]!.url).toBe(`${TIMELINE_URL}?per_page=100&page=4`);
    });

    it("answers null for a fully visited three-page timeline with no human change", async () => {
        const { lookup, scripted } = source([page([], linkTo(3)), page([]), page([])]);

        expect(await lookup(ITEM)).toBeNull();
        expect(scripted.calls).toHaveLength(3);
    });
});

describe("the cause fingerprint", () => {
    it("reads the sender and the item's updated_at, the normalizer's field", () => {
        expect(
            causeFingerprintOf({
                sender: { login: "maintainer" },
                issue: { number: 7, updated_at: "2026-08-20T10:00:00Z" },
            }),
        ).toEqual({ actorLogin: "maintainer", observedAt: new Date("2026-08-20T10:00:00Z") });
    });

    it("falls back to the pull request when the payload carries no issue", () => {
        expect(
            causeFingerprintOf({
                sender: { login: "maintainer" },
                pull_request: { number: 8, updated_at: "2026-08-20T11:00:00Z" },
            }),
        ).toEqual({ actorLogin: "maintainer", observedAt: new Date("2026-08-20T11:00:00Z") });
    });

    it.each([
        ["a non-object payload", undefined],
        ["a missing sender", { issue: { updated_at: "2026-08-20T10:00:00Z" } }],
        [
            "a non-string login",
            { sender: { login: 7 }, issue: { updated_at: "2026-08-20T10:00:00Z" } },
        ],
        ["a missing updated_at", { sender: { login: "m" }, issue: {} }],
        ["an unreadable updated_at", { sender: { login: "m" }, issue: { updated_at: "later" } }],
    ])("answers nothing to exclude for %s", (_label, payload) => {
        expect(causeFingerprintOf(payload)).toBeUndefined();
    });
});

describe("live externals for one delivery", () => {
    const PAYLOAD = {
        sender: { login: "maintainer" },
        issue: { number: 7, updated_at: "2026-08-20T10:00:00Z" },
    };

    it("propagates a grants failure instead of deciding without them", async () => {
        const tokens = tokenSource([{ ok: false, failure: { kind: "transient" } }]);
        const built = harness([page([])]);

        expect(
            await liveExternalsForDelivery(
                { tokenSource: tokens.source, http: built.client, repository: REPOSITORY },
                PAYLOAD,
            ),
        ).toEqual({ ok: false, failure: { kind: "transient" } });
        expect(built.scripted.calls).toHaveLength(0);
    });

    it("supplies live grants and ordering that excludes the delivery's cause", async () => {
        const tokens = tokenSource([{ ok: true, token: token("t") }]);
        const built = harness([page([entry("labeled", "maintainer", "2026-08-20T10:00:00Z")])]);

        const outcome = await liveExternalsForDelivery(
            { tokenSource: tokens.source, http: built.client, repository: REPOSITORY },
            PAYLOAD,
        );

        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
            expect(outcome.facts.installationGrants).toEqual(["issues:write"]);
            // The only timeline entry is the causing event: excluded.
            expect(await outcome.facts.latestHumanChangeAt(ITEM)).toBeNull();
        }
        expect(built.scripted.calls[0]!.url).toBe(`${TIMELINE_URL}?per_page=100&page=1`);
    });

    it("applies no exclusion when the payload names no cause", async () => {
        const tokens = tokenSource([{ ok: true, token: token("t") }]);
        const built = harness([page([entry("labeled", "maintainer", "2026-08-20T10:00:00Z")])]);

        const outcome = await liveExternalsForDelivery(
            { tokenSource: tokens.source, http: built.client, repository: REPOSITORY },
            {},
        );

        if (outcome.ok) {
            expect(await outcome.facts.latestHumanChangeAt(ITEM)).toEqual(
                new Date("2026-08-20T10:00:00Z"),
            );
        }
        expect(outcome.ok).toBe(true);
    });

    it("binds a fresh ordering memo to every delivery", async () => {
        const tokens = tokenSource([{ ok: true, token: token("t") }]);
        const built = harness([() => page([])]);
        const options = {
            tokenSource: tokens.source,
            http: built.client,
            repository: REPOSITORY,
        };

        const first = await liveExternalsForDelivery(options, PAYLOAD);
        const second = await liveExternalsForDelivery(options, PAYLOAD);
        if (first.ok) await first.facts.latestHumanChangeAt(ITEM);
        if (second.ok) await second.facts.latestHumanChangeAt(ITEM);

        // Two deliveries, one item: two reads — nothing crosses a delivery.
        expect(built.scripted.calls).toHaveLength(2);
    });
});
