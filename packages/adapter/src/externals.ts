/**
 * The live fill for core's external facts — what GitHub actually answers,
 * where the shell's stubs assume.
 *
 * This file owns the grants half today; the ordering-evidence half (the
 * timeline read) joins it. Grants ride the mint response: the token source
 * already holds them, so asking costs no HTTP call of its own.
 */

import type { FailureClass, PermissionGrant } from "@hiero-hackers/automation-core";
import type { TokenSource } from "./token.js";

/** The installation's grants, or the classified reason they are unknown. */
export type GrantsOutcome =
    | { readonly ok: true; readonly grants: readonly PermissionGrant[] }
    | { readonly ok: false; readonly failure: FailureClass };

/**
 * What GitHub granted this installation, right now.
 *
 * A failed mint returns as its classified failure, never as an empty grant
 * list: an empty list reads as "granted nothing", and a capability would
 * refuse citing a permission the installation may actually hold. Answers
 * move when the token refreshes — nothing is memoized here.
 */
export async function installationGrants(source: TokenSource): Promise<GrantsOutcome> {
    const outcome = await source.current();
    return outcome.ok
        ? { ok: true, grants: outcome.token.grants }
        : { ok: false, failure: outcome.failure };
}
