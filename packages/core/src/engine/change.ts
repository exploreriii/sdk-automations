/**
 * What change does one intent make — spelled for the safety gate, and for the
 * rehearsal record?
 *
 * One recipe, two readers. `writeRequestFor` builds the request an intent is
 * judged by here at decision time AND in the shell's applier at apply time, so
 * a re-gate can never judge a differently-shaped request than the decision did.
 * `decide.ts` composes; this file only says what a change IS.
 *
 * The switches here are exhaustive on purpose. They are the compile-checked
 * half of the "adding an operation" checklist `capability/catalogue.ts` names:
 * a new operation fails to build until someone states what it changes.
 */

import { INTENT_OPERATIONS, type AnyIntent } from "../capability/index.js";
import type { WriteRequest } from "../safety/index.js";
import { finding, type Finding, type Subject } from "../report/index.js";

/**
 * contracts/safety.md requires the exact item and value an adapter may change.
 * The exhaustive switch means a new catalogue operation fails to compile
 * until someone states what it changes.
 */
export function describeChange(intent: AnyIntent): string {
    switch (intent.operation) {
        case "postManagedComment":
            // Capability and purpose, never the marker: the marker is derived
            // identity, and a safety record naming it would read as a value
            // someone chose rather than the change being made (D125).
            return `managed ${intent.desired.kind} comment from ${intent.capability}`;
        case "applyMappedLabel":
            // "set", not "add": the adapter swaps the previous position
            // label as part of realising this (D4, D80).
            return `set mapped position ${intent.desired.meaning}`;
        case "unassign":
            return `unassign ${intent.desired.login}`;
    }
}

/**
 * The one recipe for the safety request an intent is judged by — used here
 * at decision time and by the shell's applier at apply time, so a re-gate
 * can never judge a differently-shaped request than the decision did. The
 * capability comes from the intent; the screen has already proved it names
 * its declaration. Core's slice parity test pins this builder as the
 * specification.
 */
export function writeRequestFor(intent: AnyIntent): WriteRequest {
    const facts = INTENT_OPERATIONS[intent.operation];
    return {
        capability: intent.capability,
        actionClass: facts.actionClassFloor,
        requiredPermissions: [facts.permission],
        cause: intent.cause.cause,
        causeObservedAt: intent.cause.observedAt,
        target: {
            item: `${intent.repository.owner}/${intent.repository.repo}#${String(intent.item.number)}`,
            change: describeChange(intent),
        },
    };
}

/**
 * What dry-run would have done, said once per intent that got that far.
 *
 * This is the whole difference between the two record-only modes. `observe`
 * reports that a repository in a recording mode recorded; `dry-run` also names
 * the change, so the ladder's middle rung is a rehearsal an operator can read
 * before promoting the repository to `active` (safety rule 10's rollout half).
 *
 * It DESCRIBES rather than prepares. No managed identity is minted here and
 * none is minted anywhere else in this mode: a marker is the name a landed
 * write is found again under, and a write that will not happen has nothing to
 * find (D125). The change is spelled in `describeChange`'s words, so the
 * rehearsal and the active-mode safety record name the same change identically.
 */
export function wouldApplyFinding(intent: AnyIntent, subject: Subject): Finding {
    return finding(
        "info",
        "wouldApply",
        `dry-run: ${intent.capability} would ${intent.operation} on ` +
            `${intent.repository.owner}/${intent.repository.repo}#${String(intent.item.number)} — ` +
            `${describeChange(intent)}. Nothing was written.`,
        subject,
    );
}
