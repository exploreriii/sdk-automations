/**
 * The grants half of the live externals: real answers ride the token, and
 * a failure is never laundered into an empty grant list.
 */

import { describe, expect, it } from "vitest";
import { installationGrants } from "../src/externals.js";
import { installationToken as token, scriptedTokenSource as tokenSource } from "./harness.js";

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
