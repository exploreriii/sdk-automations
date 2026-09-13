/**
 * The facts core cannot know, and how the shared box obtains them for one item.
 * The live fill is composed only at `main.ts`; the stub below is credential-free.
 */

import {
    createDestructiveWarning,
    isAutomationLogin,
    type ActionClass,
    type DestructiveWarning,
    type Externals,
    type RepositoryConfig,
    type ResolverAnswer,
    type ResolverSource,
} from "@hiero-hackers/automation-core";
import type { Ledger } from "../store/index.js";

/**
 * The recorded-warning seam, over the effect ledger (grace.md §2).
 * Nothing here validates; the destructive door matches the snapshot to the request.
 */
export function recordedWarningsIn(
    ledger: Ledger,
): (effectId: string) => DestructiveWarning | null {
    return (effectId) => {
        const row = ledger.warningFor(effectId);
        if (row === null) return null;
        return createDestructiveWarning({
            request: {
                capability: row.capability,
                actionClass: row.actionClass as ActionClass,
                requiredPermissions: [],
                cause: row.cause,
                causeObservedAt: new Date(row.causeObservedAt),
                target: { item: row.item, change: row.change },
            },
            warnedAt: new Date(row.warnedAt),
            gracePeriodHours: row.gracePeriodHours,
            earliestActionAt: new Date(row.earliestActionAt),
            cancelledBy: row.cancelledBy,
            reversesWith: row.reversesWith,
        });
    };
}

/**
 * One delivery's externals, built from its raw payload.
 * A rejection releases the delivery lane's claim, so the delivery retries later.
 */
export type ExternalsForDelivery = (delivery: {
    readonly payload: unknown;
    readonly deliveryId: string;
    /** The configuration this delivery was decided under, at the revision it was read at. */
    readonly config: RepositoryConfig;
}) => Externals | Promise<Externals>;

/**
 * The resolvers that need no credential, answered on the credential-free path.
 * One the platform can answer without talking to anybody is one it must answer (D51, D3).
 */
export function credentialFreeResolvers(): ResolverSource {
    const resolve = async (query: string, input: unknown): Promise<ResolverAnswer<unknown>> => {
        if (query !== "isAutomationActor") {
            return {
                ok: false,
                reason: "unavailable",
                detail: `"${query}" needs App credentials, which this path has none of`,
            };
        }
        const login = (input as { readonly login?: unknown }).login;
        return typeof login === "string" && login.length > 0
            ? { ok: true, value: isAutomationLogin(login) }
            : { ok: false, reason: "unavailable", detail: "isAutomationActor requires a login" };
    };
    return resolve as ResolverSource;
}

export function stubbedExternals(overrides: Partial<Externals> = {}): Externals {
    return {
        killSwitchActive: false,
        installationGrants: ["issues:write"],
        resolve: credentialFreeResolvers(),
        /** `null`, NOT `"unknown"`: dry-run here OVERSTATES what would apply (D93, D119). */
        latestHumanChangeAt: () => null,
        ...overrides,
    };
}
