/**
 * Which rows one decided pass writes down: a verdict per item finding, one per effect (D163).
 * A judgement only — appending them is the processor's, and the store's `decide` is one row each.
 */

import type { Finding, Report, Subject } from "@hiero-hackers/automation-core";
import type { Decision } from "../store/index.js";
import type { EffectOutcome } from "./effects.js";
import { scheduleOfSweptId, SWEEP_EFFECT } from "./schedule.js";

/** One decided pass, as its rows name it. `event` is what makes them a sweep's. */
export interface DecidedPass {
    /** The record's delivery id: a GUID, or a swept item's synthetic name. */
    readonly passId: string;
    readonly event: string;
    readonly at: string;
    readonly report: Report;
    readonly effects: readonly EffectOutcome[];
}

/** The subjects a row is written about: one item, or one act on it. */
type ItemSubject = Extract<Subject, { readonly kind: "item" | "effect" }>;

const aboutAnItem = (finding: Finding): finding is Finding & { readonly subject: ItemSubject } =>
    finding.subject.kind === "item" || finding.subject.kind === "effect";

/**
 * Every row one pass writes: its item verdicts in report order, then its effects.
 * A record with no item finding and no effect writes none — a config rejection has no item.
 */
export function decisionsOf(pass: DecidedPass): Decision[] {
    const swept = pass.event === SWEEP_EFFECT;
    const common = {
        passId: pass.passId,
        source: swept ? ("sweep" as const) : ("webhook" as const),
        sourceId: swept ? scheduleOfSweptId(pass.passId) : pass.passId,
        at: pass.at,
    };
    return [
        ...pass.report.findings.filter(aboutAnItem).map((finding) => ({
            ...common,
            item: finding.subject.item,
            capability: finding.subject.capability,
            verdict: finding.severity,
            code: finding.code,
            detail: finding.summary,
            effectId: null,
        })),
        ...pass.effects.map((outcome) => ({
            ...common,
            item: outcome.item,
            capability: outcome.capability,
            verdict: outcome.outcome,
            code: outcome.code,
            detail: outcome.detail,
            effectId: outcome.effectId,
        })),
    ];
}
