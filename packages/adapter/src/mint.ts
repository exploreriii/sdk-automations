/**
 * The one call that cannot travel through the HTTP client: minting
 * authenticates with the App assertion, and the client authenticates with
 * the token minting produces. So this file owns its own narrow POST — the
 * same origin pin, refused redirects, timeout, and no-throw outcome — for
 * exactly one endpoint, and nothing else may reuse it.
 */

import { classifyFailure } from "@hiero-hackers/automation-core";
import {
    GITHUB_API_ORIGIN,
    headersToRecord,
    DEFAULT_REQUEST_TIMEOUT_MS,
    USER_AGENT,
    GITHUB_API_VERSION,
    type FetchLike,
} from "./http.js";
import { grantsFromPermissions, type MintInstallationToken, type TokenOutcome } from "./token.js";

/** Seams the composition root may override; production needs none of them. */
export interface GitHubMintOptions {
    readonly fetch?: FetchLike;
    readonly timeoutMs?: number;
    readonly timeoutSignal?: (milliseconds: number) => AbortSignal;
}

/** A response that promised a token but did not carry one readable. */
const unreadableMint: TokenOutcome = { ok: false, failure: { kind: "transient" } };

/**
 * The live mint `createTokenSource` injects: one POST to
 * `/app/installations/{id}/access_tokens`, authenticated with the caller's
 * assertion. Never throws — every failure is a classified `TokenOutcome`,
 * which is the contract `MintInstallationToken` states.
 */
export function githubMintInstallationToken(
    options: GitHubMintOptions = {},
): MintInstallationToken {
    const {
        fetch: send = fetch,
        timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
        timeoutSignal = AbortSignal.timeout,
    } = options;

    return async (assertion, credentials) => {
        const url =
            `${GITHUB_API_ORIGIN}/app/installations/` +
            `${credentials.installationId}/access_tokens`;
        let response: Response;
        try {
            response = await send(url, {
                method: "POST",
                headers: {
                    accept: "application/vnd.github+json",
                    authorization: `Bearer ${assertion}`,
                    "user-agent": USER_AGENT,
                    "x-github-api-version": GITHUB_API_VERSION,
                },
                redirect: "manual",
                signal: timeoutSignal(timeoutMs),
            });
        } catch {
            return { ok: false, failure: { kind: "transient" } };
        }

        let body: string;
        try {
            body = await response.text();
        } catch {
            return unreadableMint;
        }
        if (!response.ok) {
            return {
                ok: false,
                failure: classifyFailure({
                    status: response.status,
                    body,
                    headers: headersToRecord(response.headers),
                    // A mint carries no token whose age could explain a 401.
                    tokenPastExpiry: false,
                }),
            };
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(body);
        } catch {
            return unreadableMint;
        }
        if (typeof parsed !== "object" || parsed === null) return unreadableMint;
        const record = parsed as Record<string, unknown>;
        const value = record["token"];
        const expiresAtRaw = record["expires_at"];
        if (typeof value !== "string" || typeof expiresAtRaw !== "string") return unreadableMint;
        const expiresAt = new Date(expiresAtRaw);
        if (!Number.isFinite(expiresAt.getTime())) return unreadableMint;
        const permissions = record["permissions"];
        return {
            ok: true,
            token: {
                value,
                expiresAt,
                grants: grantsFromPermissions(
                    typeof permissions === "object" && permissions !== null
                        ? (permissions as Record<string, string>)
                        : {},
                ),
            },
        };
    };
}
