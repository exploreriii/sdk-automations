import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { ABSENT_CONFIG_REVISION, CONFIG_PATH } from "@hiero-hackers/automation-core";
import {
    githubConfigSource,
    type GitHubHttpClient,
    type GitHubOutcome,
    type GitHubRequest,
} from "../src/index.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function fileBody(text: string, overrides: Readonly<Record<string, unknown>> = {}): string {
    return JSON.stringify({
        type: "file",
        encoding: "base64",
        content: Buffer.from(text).toString("base64"),
        sha: SHA,
        ...overrides,
    });
}

function success(body: string, status = 200): GitHubOutcome {
    return { ok: true, status, body, headers: {}, fromCache: status === 304 };
}

function clientFor(...outcomes: readonly (GitHubOutcome | Error)[]): {
    readonly client: GitHubHttpClient;
    readonly calls: GitHubRequest[];
} {
    const calls: GitHubRequest[] = [];
    let index = 0;
    return {
        calls,
        client: {
            async request(request): Promise<GitHubOutcome> {
                calls.push(request);
                const outcome = outcomes[index++];
                if (outcome === undefined) throw new Error("unexpected request");
                if (outcome instanceof Error) throw outcome;
                return outcome;
            },
            latestRateLimit: () => null,
        },
    };
}

function sourceFor(client: GitHubHttpClient) {
    return githubConfigSource({
        client,
        repository: { owner: "hiero-hackers", repo: "sdk-automations" },
    });
}

describe("the live configuration source", () => {
    it.each([200, 304])("reads a file at status %i and records its blob sha", async (status) => {
        const scripted = clientFor(success(fileBody("mode: observe\n"), status));

        await expect(sourceFor(scripted.client).load()).resolves.toEqual({
            revision: SHA,
            text: "mode: observe\n",
        });
        expect(scripted.calls).toEqual([
            {
                method: "GET",
                url: `https://api.github.com/repos/hiero-hackers/sdk-automations/contents/${CONFIG_PATH}`,
            },
        ]);
        expect(new URL(scripted.calls[0]!.url).search).toBe("");
    });

    it("preserves UTF-8 text from GitHub's line-wrapped base64", async () => {
        const text = "mode: observe\n# café ☕\n";
        const encoded = Buffer.from(text).toString("base64");
        const body = fileBody("", { content: `${encoded.slice(0, 8)}\n${encoded.slice(8)}\r\n` });

        await expect(sourceFor(clientFor(success(body)).client).load()).resolves.toEqual({
            revision: SHA,
            text,
        });
    });

    it("maps only a received 404 to the shared absent document", async () => {
        const missing: GitHubOutcome = {
            ok: false,
            status: 404,
            body: "Not Found",
            headers: {},
            failure: { kind: "notFoundOrNotInstalled" },
        };
        await expect(sourceFor(clientFor(missing).client).load()).resolves.toEqual({
            revision: ABSENT_CONFIG_REVISION,
            text: "",
        });
    });

    it.each([
        ["transport failure", { ok: false, failure: { kind: "transient" } }],
        [
            "403 response",
            {
                ok: false,
                status: 403,
                body: "forbidden",
                headers: {},
                failure: { kind: "forbiddenUnrecognized", bodySnippet: "forbidden" },
            },
        ],
    ] as const)("does not turn a %s into an absent config", async (_label, outcome) => {
        await expect(sourceFor(clientFor(outcome).client).load()).rejects.toMatchObject({
            name: "GitHubConfigUnavailableError",
            message: "GitHub configuration unavailable: requestFailed",
            reason: { kind: "requestFailed", failure: outcome.failure },
        });
    });

    it("contains a client that breaks its no-throw contract", async () => {
        await expect(
            sourceFor(clientFor(new Error("broken client")).client).load(),
        ).rejects.toMatchObject({
            reason: {
                kind: "requestFailed",
                failure: { kind: "notSent", reason: "brokenSeam", seam: "response" },
            },
        });
    });

    it.each([
        ["invalid JSON", "{"],
        ["a non-object", "[]"],
        ["a directory", fileBody("", { type: "dir" })],
        ["a different encoding", fileBody("", { encoding: "utf-8" })],
        ["a missing content", fileBody("", { content: undefined })],
        ["a malformed sha", fileBody("", { sha: "not-a-sha" })],
        ["a numeric sha", fileBody("", { sha: 123 })],
        ["an array sha", fileBody("", { sha: [SHA] })],
        ["invalid base64", fileBody("", { content: "%%%=" })],
        ["non-canonical base64", fileBody("", { content: "AB==" })],
        ["invalid UTF-8", fileBody("", { content: "/w==" })],
    ])("rejects a successful response containing %s", async (_label, body) => {
        await expect(sourceFor(clientFor(success(body)).client).load()).rejects.toMatchObject({
            reason: { kind: "invalidResponse" },
        });
    });

    it("rejects an unexpected successful status", async () => {
        await expect(
            sourceFor(clientFor(success(fileBody("mode: observe\n"), 206)).client).load(),
        ).rejects.toMatchObject({ reason: { kind: "invalidResponse" } });
    });

    it("encodes repository names as path components", async () => {
        const scripted = clientFor(success(fileBody("")));
        await githubConfigSource({
            client: scripted.client,
            repository: { owner: "owner/name", repo: "repo?ref=attacker" },
        }).load();

        expect(scripted.calls[0]!.url).toBe(
            `https://api.github.com/repos/owner%2Fname/repo%3Fref%3Dattacker/contents/${CONFIG_PATH}`,
        );
    });

    it("rejects a caller-provided ref before making a request", () => {
        const scripted = clientFor(success(fileBody("")));
        expect(() =>
            githubConfigSource({
                client: scripted.client,
                repository: { owner: "owner", repo: "repo" },
                // @ts-expect-error Config always follows the repository's default branch.
                ref: "refs/pull/42/head",
            }),
        ).toThrowError(expect.objectContaining({ reason: { kind: "unsafeRef" } }));
        expect(scripted.calls).toHaveLength(0);
    });
});
