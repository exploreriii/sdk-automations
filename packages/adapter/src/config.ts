/** Fetch repository configuration from the default branch. */

import { Buffer } from "node:buffer";
import {
    ABSENT_CONFIG_REVISION,
    CONFIG_PATH,
    type ConfigDocument,
    type RepositoryRef,
} from "@hiero-hackers/automation-core";
import { GITHUB_API_ORIGIN, type GitHubHttpClient, type GitHubHttpFailureClass } from "./http.js";
import { field, jsonRecordOf } from "./untrusted.js";

export interface GitHubConfigSource {
    load(): Promise<ConfigDocument>;
}

export interface GitHubConfigSourceOptions {
    readonly client: GitHubHttpClient;
    readonly repository: RepositoryRef;
}

export type GitHubConfigUnavailableReason =
    | { readonly kind: "requestFailed"; readonly failure: GitHubHttpFailureClass }
    | { readonly kind: "invalidResponse" }
    | { readonly kind: "unsafeRef" };

export class GitHubConfigUnavailableError extends Error {
    constructor(readonly reason: GitHubConfigUnavailableReason) {
        super(`GitHub configuration unavailable: ${reason.kind}`);
        this.name = "GitHubConfigUnavailableError";
    }
}

const BLOB_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function configDocumentOf(body: string): ConfigDocument | null {
    const response = jsonRecordOf(body);
    const sha = field(response, "sha");
    const content = field(response, "content");
    if (
        field(response, "type") !== "file" ||
        field(response, "encoding") !== "base64" ||
        typeof sha !== "string" ||
        !BLOB_SHA.test(sha) ||
        typeof content !== "string"
    ) {
        return null;
    }

    const encoded = content.replace(/[\r\n]/g, "");
    try {
        const bytes = Buffer.from(encoded, "base64");
        if (bytes.toString("base64") !== encoded) return null;
        return { revision: sha, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    } catch {
        return null;
    }
}

function configUrl({ owner, repo }: RepositoryRef): string {
    return (
        `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
        `/contents/${CONFIG_PATH}`
    );
}

export function githubConfigSource(options: GitHubConfigSourceOptions): GitHubConfigSource {
    if ("ref" in (options as GitHubConfigSourceOptions & { readonly ref?: unknown })) {
        throw new GitHubConfigUnavailableError({ kind: "unsafeRef" });
    }

    const url = configUrl(options.repository);
    return {
        async load(): Promise<ConfigDocument> {
            let outcome;
            try {
                outcome = await options.client.request({ method: "GET", url });
            } catch {
                throw new GitHubConfigUnavailableError({
                    kind: "requestFailed",
                    failure: { kind: "notSent", reason: "brokenSeam", seam: "response" },
                });
            }

            if (!outcome.ok) {
                if (outcome.status === 404) {
                    return { revision: ABSENT_CONFIG_REVISION, text: "" };
                }
                throw new GitHubConfigUnavailableError({
                    kind: "requestFailed",
                    failure: outcome.failure,
                });
            }

            const document = configDocumentOf(outcome.body);
            if ((outcome.status !== 200 && outcome.status !== 304) || document === null) {
                throw new GitHubConfigUnavailableError({ kind: "invalidResponse" });
            }
            return document;
        },
    };
}
