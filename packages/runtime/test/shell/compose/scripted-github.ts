/**
 * GitHub as a script behind `fetch`, answering from the testkit's one route table, so the composed
 * client, reader and engine run without a credential. `calls` is what was charged.
 */

import { vi } from "vitest";
import { githubScript, HOUR, POOL_LIMIT, UPDATED } from "@hiero-hackers/automation-testkit";

export { HOUR, POOL_LIMIT, UPDATED };

export function scriptedGitHub(script: {
    readonly now: () => Date;
    readonly config: () => string;
    /** While true, every read is refused as GitHub refuses one past a secondary limit. */
    readonly secondaryLimited?: (route: string) => boolean;
}) {
    const { calls, answer } = githubScript(script);
    vi.stubGlobal("fetch", (input: string | URL, init: RequestInit) => {
        const reply = answer({
            method: init.method ?? "GET",
            path: new URL(String(input)).pathname,
            ifNoneMatch: new Headers(init.headers).get("if-none-match"),
            body: typeof init.body === "string" ? init.body : "",
        });
        return Promise.resolve(
            new Response(reply.body, { status: reply.status, headers: reply.headers }),
        );
    });
    return {
        calls,
        cost: (from = 0) => ({
            requests: calls.length - from,
            core: calls.slice(from).filter(({ pool, status }) => pool === "core" && status === 200)
                .length,
            graphql: calls.slice(from).filter(({ pool }) => pool === "graphql").length,
        }),
    };
}
