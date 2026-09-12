/**
 * How one approved effect becomes a landed GitHub change, exactly once — stage C.
 * `effects.ts` says what an effect's calls ARE and `operations/` what each one plans
 * and sends; this file is the choreography around them, and it knows no verb. Two
 * rules run through all of it: nothing is sent the ledger did not record first, and
 * nothing is closed that was not read back.
 */

import {
    deriveWorld,
    evaluateDestructive,
    evaluateStandingRules,
    evaluateWrite,
    INTENT_OPERATIONS,
    writeRequestFor,
    matchesManagedComment,
    meaningsOfLabels,
    parseManagedMarker,
    projectIssue,
    projectPullRequest,
    type AnyIntent,
    type Effect,
    type HumanChangeOrdering,
    type IntentOperation,
    type ItemRef,
    type MappableMeaning,
    type ObservedModes,
    type Projection,
    type RepositoryConfig,
    type RepositoryRef,
    type WarningToRecord,
} from "@hiero-hackers/automation-core";
import type { Fact, FactKind, Ledger, OpenSend, StoredWarning } from "../store/index.js";
import type { Call, EffectOutcome, EffectOutcomeCode, EffectOutcomeName } from "./effects.js";
import { recordedWarningsIn, type ShellExternals } from "./externals.js";
import { detailOf, type Log } from "./log.js";
import type {
    CommentSeen,
    Confirmation,
    EffectReader,
    EffectWriter,
    ItemSeen,
    ReadAnswer,
    SendContext,
    WriteResult,
} from "./operations/handler.js";
import {
    confirmCall,
    operationOf,
    parseJournaledCall,
    planFor,
    sendCall,
    serializeCall,
} from "./operations/index.js";

/** The seam vocabulary, re-exported from its new home to keep the barrel's name set. */
export type {
    CommentSeen,
    EffectReader,
    EffectWriter,
    ItemSeen,
    ReadAnswer,
    SeenState,
    WriteResult,
} from "./operations/handler.js";

// ─── The chosen bounds ───────────────────────────────────────────────

/**
 * How long an effect lease is honoured before a later worker may take it over.
 * Not a proof GitHub stopped processing a timed-out request; live takeover stays open (D41).
 */
export const EFFECT_LEASE_STALE_MINUTES = 10;

/**
 * How many times one call may be declared before recovery gives up on it.
 * The ledger counts its sends durably, so this bounds the effect, not a process (D161).
 */
export const EFFECT_ATTEMPT_CAP = 5;

// ─── The seams ───────────────────────────────────────────────────────

/**
 * A FRESH externals set, built per apply pass.
 * Never the delivery's own: its memo would answer the apply-time gate with the instant the DECISION read, which is the one thing a re-gate must not believe.
 */
export type EffectExternalsSource = () => ShellExternals | Promise<ShellExternals>;

/** The writes a caller has left to spend, decremented by the applier (D167). */
export interface WriteBudget {
    remaining: number;
}

export interface ApplierOptions {
    /** The whole store the applier touches: the facts, and the lease beside them (D164). */
    readonly ledger: Ledger;
    readonly writer: EffectWriter;
    readonly reader: EffectReader;
    readonly externals: EffectExternalsSource;
    /** Which worker holds a lease; the ledger releases only this name's own. */
    readonly worker: string;
    readonly clock: () => Date;
    /** Recovery has no delivery to report into, so its lines leave here. */
    readonly log: Log;
}

/** The write path, as the processor and the sweep each use it. */
export interface Applier {
    /**
     * Every approved effect of one decision, in order, each under its own lease.
     * A pass that sent a call and applied, or left the answer unknown or retriable, spends one of `budget`; `already`, every refusal and every gate that sent nothing spend none. No budget is unlimited, which is what a webhook passes (D167).
     */
    applyAll(
        effects: readonly Effect[],
        config: RepositoryConfig,
        budget?: WriteBudget,
    ): Promise<readonly EffectOutcome[]>;
    /** One open send, resolved against GitHub — the sweep's unit of work. */
    recover(open: OpenSend, config: RepositoryConfig): Promise<void>;
}

// ─── What a pass is working on ───────────────────────────────────────

/** Everything one pass over one effect shares. */
interface Pass {
    readonly effectId: string;
    readonly capability: string;
    /** The intent's own, or the open send's on a recovery pass (D169). */
    readonly repository: RepositoryRef;
    readonly item: ItemRef;
    readonly config: RepositoryConfig;
    /** The warning this comment records when it lands; `null` for every recovery pass. */
    readonly records: WarningToRecord | null;
    /** Set where a call goes to GitHub; only such a pass can spend a write. */
    readonly sent: { any: boolean };
}

/** What a pass concluded, before it is dressed as an `EffectOutcome`. */
interface PassResult {
    readonly outcome: EffectOutcomeName;
    readonly code: EffectOutcomeCode | null;
    readonly detail: string | null;
}

/** One call either landed, or ended the pass. */
type CallResult =
    | { readonly kind: "done"; readonly changed: boolean }
    | { readonly kind: "stop"; readonly result: PassResult };

/** A gate passed, or the result its refusal produces. */
type GateVerdict = { readonly ok: true } | { readonly ok: false; readonly result: PassResult };

const stop = (
    outcome: EffectOutcomeName,
    code: EffectOutcomeCode | null,
    detail: string,
): CallResult => ({ kind: "stop", result: { outcome, code, detail } });

const refuse = (code: EffectOutcomeCode, detail: string): GateVerdict => ({
    ok: false,
    result: { outcome: "refused", code, detail },
});

/** What a sent call is charged a write for; `already` and every refusal are free (D167). */
const SPENDS: ReadonlySet<EffectOutcomeName> = new Set(["applied", "retryLater", "unknown"]);

/** An effect a spent budget holds back: nothing claimed, nothing recorded, decided again next firing. */
const heldBack = ({ intent }: Effect): EffectOutcome => ({
    effectId: intent.idempotencyKey,
    capability: intent.capability,
    operation: intent.operation,
    item: intent.item,
    outcome: "refused",
    code: "sweepWriteCap",
    detail: "this firing's write cap is spent; decided again next sweep",
});

/** What a fact says beyond the call it is about. */
interface Said {
    readonly code?: string | null;
    readonly detail?: string | null;
    readonly payload?: string;
}

/** The login a call names; every other verb names none. */
const loginOf = (call: Call): string | null => ("login" in call ? call.login : null);

/** What a settled effect tells the next pass: nothing follows a refusal or an abandonment (D161). */
const settledDetail = (how: "landed" | "refused" | "abandoned"): string =>
    how === "landed"
        ? "the ledger says every call in this effect's plan landed"
        : `this effect settled as ${how}; nothing more is sent`;

/**
 * The live item as a projection.
 * A merged pull request is `merged` and everything else closed is `closedByHuman`; every closure refuses the write by the same rule, so the choice cannot change a verdict.
 */
function projectionFrom(
    seen: ItemSeen,
    kind: ItemRef["kind"],
    config: RepositoryConfig,
): Projection<MappableMeaning> {
    const observation = {
        closedBy: seen.closed
            ? seen.merged
                ? ("merged" as const)
                : ("closedByHuman" as const)
            : null,
        meanings: meaningsOfLabels(config, seen.labels),
    };
    return kind === "issue" ? projectIssue(observation) : projectPullRequest(observation);
}

/**
 * Is this comment the one the call about to be sent would BE? Authorship and identity (D125).
 * The identity comes from the call's own rendered body, which is all a resend has, so a recovery pass and a fresh one ask exactly the same question (D145).
 */
const isMine = (body: string): ((comment: CommentSeen) => boolean) => {
    const published = parseManagedMarker(body);
    const mine = "recognized" in published ? published.recognized : null;
    return (comment: CommentSeen): boolean =>
        mine !== null &&
        matchesManagedComment({ body: comment.body, authoredByApp: comment.authoredByApp }, mine)
            .matches;
};

export function createApplier(options: ApplierOptions): Applier {
    const { ledger, writer, reader, externals, worker, clock, log } = options;

    const now = (): string => clock().toISOString();

    /**
     * The recorded warning, read from the SAME ledger the applier appends to.
     * Not through `externals`: a warning is the platform's own record, so the credential-free path can still gate its own destructive acts (grace.md §2).
     */
    const warningFor = recordedWarningsIn(ledger);

    /**
     * Did the affected person act after they were warned?
     * The instant is the DECISION's reading; this narrows rather than carries the claim.
     */
    const activityCancels = (intent: AnyIntent, live: Date | null): boolean => {
        const decided = intent.grace?.activityAt ?? null;
        const at =
            decided === null || (live !== null && live.getTime() > decided.getTime())
                ? live
                : decided;
        const warning = warningFor(intent.idempotencyKey);
        return at !== null && warning !== null && at.getTime() > warning.warnedAtMs;
    };

    /** Take the lease, or learn that a live worker holds it. */
    const claim = (effectId: string): boolean => {
        const at = clock();
        return ledger.claim(
            effectId,
            worker,
            at.toISOString(),
            new Date(at.getTime() - EFFECT_LEASE_STALE_MINUTES * 60_000).toISOString(),
        );
    };

    /** The externals for this pass, with the seam CONTAINED. */
    const freshExternals = async (): Promise<ReadAnswer<ShellExternals>> => {
        try {
            return { ok: true, value: await externals() };
        } catch (error) {
            return { ok: false, detail: detailOf(error) };
        }
    };

    /**
     * Contained the way `decide()` contains it: a lookup that threw established nothing,
     * and D51 rules an unestablished ordering a conflict, which the rules already refuse.
     * The item's landed writes go with it, because GitHub attributes the App's own release to the assignee (D159).
     */
    const orderingFor = async (
        facts: ShellExternals,
        repository: RepositoryRef,
        item: ItemRef,
    ): Promise<HumanChangeOrdering> => {
        try {
            return await facts.latestHumanChangeAt(item, ledger.landedOn(repository, item));
        } catch {
            return "unknown";
        }
    };

    /**
     * The brakes an operator can still pull between deciding and applying, run by core
     * (`evaluateStandingRules`) and not copied. The shell decides WHICH rules to run. This item-independent subset is the whole gate a RESUME passes: add-then-remove leaves two position labels, so the full ladder could only answer `preconditionStale`.
     */
    const brakes = (pass: Pass, operation: IntentOperation, facts: ShellExternals): GateVerdict => {
        const operationFacts = INTENT_OPERATIONS[operation];
        const verdict = evaluateStandingRules(
            {
                capability: pass.capability,
                actionClass: operationFacts.actionClassFloor,
                requiredPermissions: [operationFacts.permission],
            },
            pass.config,
            {
                killSwitchActive: facts.killSwitchActive,
                installationGrants: facts.installationGrants,
            },
        );
        return verdict.outcome === "apply" ? { ok: true } : refuse(verdict.code, verdict.reason);
    };

    /** The brakes, over externals read fresh for this pass. */
    const resumeGate = async (pass: Pass, operation: IntentOperation): Promise<GateVerdict> => {
        const facts = await freshExternals();
        return facts.ok
            ? brakes(pass, operation, facts.value)
            : {
                  ok: false,
                  result: {
                      outcome: "retryLater",
                      code: "externalsUnavailable",
                      detail: `the apply-time externals could not be built: ${facts.detail}`,
                  },
              };
    };

    /**
     * The live answer to the mode this intent claimed, and to no other.
     * `draft` rides on the item read already made; the reviews list is a second call, spent only where a claim turns on it.
     */
    const modesClaimed = async (
        intent: AnyIntent,
        seen: ItemSeen,
    ): Promise<ReadAnswer<ObservedModes>> => {
        const claimed = intent.claims.pullRequestMode;
        if (claimed === undefined) return { ok: true, value: {} };
        if (claimed === "draft") return { ok: true, value: { draft: seen.draft } };
        const read = await reader.changesRequested(intent.item);
        return read.ok ? { ok: true, value: { changesRequested: read.value } } : read;
    };

    /**
     * The whole ladder again, against a LIVE read of the item.
     * This is what makes an approval a permission to act NOW rather than one banked at decision time. A mode that moved refuses under `preconditionStale`, as a meaning does.
     */
    const freshGate = async (pass: Pass, intent: AnyIntent): Promise<GateVerdict> => {
        const seen = await reader.item(intent.item);
        if (!seen.ok) {
            return {
                ok: false,
                result: {
                    outcome: "retryLater",
                    code: "itemUnreadable",
                    detail: `the item could not be read at apply time: ${seen.detail}`,
                },
            };
        }
        const modes = await modesClaimed(intent, seen.value);
        if (!modes.ok) {
            return {
                ok: false,
                result: {
                    outcome: "retryLater",
                    code: "itemUnreadable",
                    detail: `the pull request's mode could not be read at apply time: ${modes.detail}`,
                },
            };
        }
        const facts = await freshExternals();
        if (!facts.ok) {
            return {
                ok: false,
                result: {
                    outcome: "retryLater",
                    code: "externalsUnavailable",
                    detail: `the apply-time externals could not be built: ${facts.detail}`,
                },
            };
        }
        const request = writeRequestFor(intent);
        const activity =
            intent.grace !== null && intent.operation === "closePullRequest"
                ? await reader.pullRequestActivity(
                      intent.item,
                      pass.config.mappings.commands.working,
                  )
                : { ok: true as const, value: null };
        if (!activity.ok) {
            return {
                ok: false,
                result: {
                    outcome: "retryLater",
                    code: "itemUnreadable",
                    detail: `the pull request's activity could not be read at apply time: ${activity.detail}`,
                },
            };
        }
        const context = {
            killSwitchActive: facts.value.killSwitchActive,
            installationGrants: facts.value.installationGrants,
            latestHumanChangeAt: await orderingFor(facts.value, pass.repository, intent.item),
            world: deriveWorld(
                projectionFrom(seen.value, intent.item.kind, pass.config),
                intent.claims,
                modes.value,
            ),
        };
        // The same two doors the decision used (grace.md §2): the record is re-read
        // here, so a pruned warning or a re-warned repository changes the answer.

        const verdict =
            intent.grace === null
                ? evaluateWrite(request, pass.config, context)
                : evaluateDestructive(
                      {
                          request,
                          warning: warningFor(intent.idempotencyKey),
                          qualifyingActivitySinceWarning: activityCancels(intent, activity.value),
                      },
                      pass.config,
                      context,
                      clock(),
                  );
        return verdict.outcome === "apply" ? { ok: true } : refuse(verdict.code, verdict.reason);
    };

    // ── Sending and proving one call ────────────────────────────────

    /**
     * What one send of this pass's effect may know.
     * `isMine` is handed in: recognising the App's own comment is the choreography's business and not an operation's (D125).
     */
    const contextFor = (pass: Pass): SendContext => ({
        item: pass.item,
        writer,
        reader,
        isMine,
    });

    /** One call, sent by the handler that owns its verb. */
    const send = async (pass: Pass, call: Call): Promise<WriteResult> =>
        await sendCall(call, contextFor(pass));

    /** Does GitHub say this call's postcondition holds? */
    const confirm = async (pass: Pass, call: Call): Promise<Confirmation> =>
        await confirmCall(call, contextFor(pass));

    /** Append one fact about one call: the identity is the pass's, the verb the call's (D161). */
    const appendFact = (
        pass: Pass,
        kind: FactKind,
        seq: number,
        call: Call | null,
        said: Said = {},
    ): void => {
        ledger.record({
            effectId: pass.effectId,
            seq,
            kind,
            at: now(),
            revision: pass.config.revision,
            capability: pass.capability,
            repository: pass.repository,
            item: pass.item,
            verb: call?.verb ?? null,
            login: call === null ? null : loginOf(call),
            code: said.code ?? null,
            detail: said.detail ?? null,
            payload: said.payload ?? null,
        });
    };

    /** A refusal settles the effect, so the fact is appended and the pass stops at it. */
    const refuseCall = (
        pass: Pass,
        seq: number,
        call: Call,
        code: EffectOutcomeCode,
        detail: string,
    ): CallResult => {
        appendFact(pass, "refused", seq, call, { code, detail });
        return stop("refused", code, detail);
    };

    /** The newest send of an effect — the identity and revision a closing fact repeats. */
    const sendOf = (effectId: string): Fact => {
        const sends = ledger.factsOf(effectId).filter((fact) => fact.kind === "sent");
        return sends[sends.length - 1]!;
    };

    const HOUR_MS = 60 * 60 * 1000;

    /**
     * The warning this landed comment promises, written down (grace.md §3).
     * `warnedAt` is NOW, because the promise is made when the comment appears. Keyed by the ACT's effect id, and called only after a call is proved done.
     */
    const record = (pass: Pass, call: Call): void => {
        if (pass.records === null || call.verb !== "postComment") return;
        const warnedAt = clock();
        const { request } = pass.records;
        const snapshot: Omit<StoredWarning, "effectId"> = {
            warnedAt: warnedAt.toISOString(),
            gracePeriodHours: pass.records.gracePeriodHours,
            earliestActionAt: new Date(
                warnedAt.getTime() + pass.records.gracePeriodHours * HOUR_MS,
            ).toISOString(),
            cancelledBy: pass.records.cancelledBy,
            reversesWith: pass.records.reversesWith,
            actionClass: request.actionClass,
            capability: request.capability,
            causeObservedAt: request.causeObservedAt.toISOString(),
            cause: request.cause,
            item: request.target.item,
            change: request.target.change,
        };
        // The ACT's history, not this comment's, and seq 0 because no call of it (D162).

        ledger.record({
            effectId: pass.records.effectId,
            seq: 0,
            kind: "warned",
            at: snapshot.warnedAt,
            revision: pass.config.revision,
            capability: pass.capability,
            repository: pass.repository,
            item: pass.item,
            verb: null,
            login: null,
            code: null,
            detail: null,
            payload: JSON.stringify(snapshot),
        });
    };

    /**
     * Append the send, send it, prove it — in that order, always.
     * A definite refusal — conflict or forbidden — SETTLES the effect: nothing landed and nothing will, so leaving the send open would ask the sweep to re-decide a settled question.
     * A write no endpoint realises is `unsent` instead, spending no attempt: the send closes and the next pass resumes at the same call.
     */
    const journalAndSend = async (pass: Pass, seq: number, call: Call): Promise<CallResult> => {
        appendFact(pass, "sent", seq, call, {
            payload: serializeCall({ capability: pass.capability, item: pass.item, call }),
        });
        pass.sent.any = true;
        const answer = await send(pass, call);
        switch (answer.outcome) {
            case "applied": {
                const proof = await confirm(pass, call);
                if (proof !== "held") {
                    return stop(
                        "unknown",
                        "postconditionUnconfirmed",
                        `GitHub accepted the ${call.verb} but the read-back answered ${proof}`,
                    );
                }
                appendFact(pass, "landed", seq, call);
                record(pass, call);
                return { kind: "done", changed: true };
            }
            case "already":
                appendFact(pass, "landed", seq, call);
                record(pass, call);
                return { kind: "done", changed: false };
            case "conflict":
                return refuseCall(pass, seq, call, "writeConflict", answer.detail);
            case "forbidden":
                return refuseCall(pass, seq, call, "writeForbidden", answer.detail);
            case "unsupported":
                appendFact(pass, "unsent", seq, call, {
                    code: "writeUnsupported",
                    detail: answer.detail,
                });
                return stop("refused", "writeUnsupported", answer.detail);
            case "retryLater":
                return stop("retryLater", "writeRetryLater", answer.detail);
            case "unknown":
                return stop("unknown", "writeUnknown", answer.detail);
        }
    };

    /**
     * One open send, resolved — the whole of `SENT-UNKNOWN`.
     * GitHub is asked BEFORE anything else. Only the resend branch meets a gate, because by then nothing has landed, so a world that now says no settles the effect.
     */
    const resolveOpen = async (
        pass: Pass,
        seq: number,
        call: Call,
        revision: string | null,
    ): Promise<CallResult> => {
        const proof = await confirm(pass, call);
        if (proof === "held") {
            appendFact(pass, "landed", seq, call);
            record(pass, call);
            return { kind: "done", changed: true };
        }
        if (proof === "unknown") {
            return stop(
                "unknown",
                "writeUnknown",
                "the read-back could not establish whether this call landed",
            );
        }
        if (revision !== pass.config.revision) {
            return refuseCall(
                pass,
                seq,
                call,
                "configurationChanged",
                "the configuration changed after this call was recorded; nothing was resent",
            );
        }
        const gate = await resumeGate(pass, operationOf(call));
        if (!gate.ok) {
            if (gate.result.outcome === "refused") {
                appendFact(pass, "refused", seq, call, gate.result);
            }
            return { kind: "stop", result: gate.result };
        }
        return await journalAndSend(pass, seq, call);
    };

    /** The plan from one call onward. The first stop ends the pass. */
    const runFrom = async (
        pass: Pass,
        calls: readonly Call[],
        startSeq: number,
        changedAlready: boolean,
    ): Promise<PassResult> => {
        let changed = changedAlready;
        for (let seq = startSeq; seq <= calls.length; seq += 1) {
            const result = await journalAndSend(pass, seq, calls[seq - 1]!);
            if (result.kind === "stop") return result.result;
            changed ||= result.changed;
        }
        return changed
            ? { outcome: "applied", code: null, detail: null }
            : { outcome: "already", code: null, detail: "every call in this plan already held" };
    };

    /** The open send the fold names, then whatever the plan has left. */
    const continueOpen = async (
        pass: Pass,
        seq: number,
        payload: string | null,
        revision: string,
        calls: readonly Call[],
    ): Promise<PassResult> => {
        // Nothing can be resent from bytes nobody can read, and leaving the send open
        // would hand the sweep the same dead end forever.

        const journaled = payload === null ? null : parseJournaledCall(payload);
        if (journaled === null) {
            const detail =
                "the ledger's bytes for this call could not be read; it is closed and nothing was resent";
            appendFact(pass, "refused", seq, null, { code: "rowUnreadable", detail });
            return { outcome: "refused", code: "rowUnreadable", detail };
        }
        const resolved = await resolveOpen(pass, seq, journaled.call, revision);
        if (resolved.kind === "stop") return resolved.result;
        if (seq >= calls.length) {
            return { outcome: "applied", code: null, detail: null };
        }
        if (revision !== pass.config.revision) {
            return {
                outcome: "refused",
                code: "configurationChanged",
                detail: "the configuration changed after this effect started; nothing else was sent",
            };
        }
        const gate = await resumeGate(pass, operationOf(journaled.call));
        if (!gate.ok) return gate.result;
        return await runFrom(pass, calls, seq + 1, true);
    };

    /** The dispatch: the fold's five states, five answers (D161). */
    const drive = async (
        pass: Pass,
        intent: AnyIntent,
        calls: readonly Call[],
    ): Promise<PassResult> => {
        const state = ledger.stateOf(pass.effectId, calls.length);
        if (state.kind === "settled") {
            return { outcome: "already", code: null, detail: settledDetail(state.how) };
        }
        if (state.kind === "inconsistent") {
            return { outcome: "refused", code: "ledgerInconsistent", detail: state.detail };
        }
        if (state.kind === "open") {
            const { revision } = sendOf(pass.effectId);
            return await continueOpen(pass, state.seq, state.payload, revision, calls);
        }
        if (state.kind === "resumable") {
            if (sendOf(pass.effectId).revision !== pass.config.revision) {
                return {
                    outcome: "refused",
                    code: "configurationChanged",
                    detail: "the configuration changed after this effect started; nothing was resumed",
                };
            }
            const gate = await resumeGate(pass, intent.operation);
            // Resuming at the first call means nothing landed, so nothing has changed yet.

            return gate.ok
                ? await runFrom(pass, calls, state.nextSeq, state.nextSeq > 1)
                : gate.result;
        }
        const gate = await freshGate(pass, intent);
        return gate.ok ? await runFrom(pass, calls, 1, false) : gate.result;
    };

    /** One approved effect, under its own lease, released on every exit. */
    const apply = async (
        effect: Effect,
        config: RepositoryConfig,
        budget: WriteBudget | undefined,
    ): Promise<EffectOutcome> => {
        const { intent } = effect;
        const pass: Pass = {
            effectId: intent.idempotencyKey,
            capability: intent.capability,
            repository: intent.repository,
            item: intent.item,
            config,
            records: effect.records,
            sent: { any: false },
        };
        const outcomeOf = (result: PassResult): EffectOutcome => ({
            effectId: pass.effectId,
            capability: pass.capability,
            operation: intent.operation,
            item: pass.item,
            ...result,
        });

        const plan = planFor(effect, config);
        if (!plan.ok) {
            return outcomeOf({ outcome: "refused", code: plan.code, detail: plan.detail });
        }
        if (!claim(pass.effectId)) {
            return outcomeOf({
                outcome: "unknown",
                code: "leaseHeld",
                detail: "a live worker holds this effect's lease",
            });
        }
        try {
            const result = await drive(pass, intent, plan.calls);
            if (budget !== undefined && pass.sent.any && SPENDS.has(result.outcome)) {
                budget.remaining -= 1;
            }
            return outcomeOf(result);
        } finally {
            ledger.release(pass.effectId, worker);
        }
    };

    return {
        async applyAll(effects, config, budget) {
            const outcomes: EffectOutcome[] = [];
            for (const effect of effects) {
                outcomes.push(
                    budget?.remaining === 0
                        ? heldBack(effect)
                        : await apply(effect, config, budget),
                );
            }
            return outcomes;
        },

        /**
         * One open send the sweep found, resolved and reported.
         * Log-only, and a send still open at the end says nothing: the sweep meets it again.
         */
        async recover(open, config) {
            const journaled = open.payload === null ? null : parseJournaledCall(open.payload);
            if (journaled === null) {
                const sent = sendOf(open.effectId);
                const detail =
                    "the ledger's bytes could not be read; it is closed and nothing was resent";
                // Only the send it closes can say which item and capability this was.

                ledger.record({
                    ...sent,
                    kind: "refused",
                    at: now(),
                    code: "rowUnreadable",
                    detail,
                    payload: null,
                });
                log({
                    event: "effectRefused",
                    effectId: open.effectId,
                    seq: open.seq,
                    code: "rowUnreadable",
                    detail,
                });
                return;
            }
            const pass: Pass = {
                effectId: open.effectId,
                capability: journaled.capability,
                repository: open.repository,
                item: journaled.item,
                config,
                records: null,
                sent: { any: false },
            };
            if (open.attempts >= EFFECT_ATTEMPT_CAP) {
                appendFact(pass, "abandoned", open.seq, journaled.call, {
                    code: "effectAbandoned",
                    detail: `this call was sent ${String(open.attempts)} times and nothing more is sent`,
                });
                log({
                    event: "effectAbandoned",
                    effectId: open.effectId,
                    seq: open.seq,
                    attempts: open.attempts,
                });
                return;
            }
            if (!claim(open.effectId)) return;
            try {
                const resolved = await resolveOpen(pass, open.seq, journaled.call, open.revision);
                if (resolved.kind === "done") {
                    log({ event: "effectApplied", effectId: open.effectId, seq: open.seq });
                } else if (resolved.result.outcome === "refused") {
                    log({
                        event: "effectRefused",
                        effectId: open.effectId,
                        seq: open.seq,
                        code: resolved.result.code,
                        detail: resolved.result.detail,
                    });
                }
            } finally {
                ledger.release(open.effectId, worker);
            }
        },
    };
}
