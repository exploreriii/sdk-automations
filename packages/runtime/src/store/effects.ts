/** What an effect is, and what state its journal says it is in. Vocabulary only. */

/**
 * The recovery classification derived from an effect's latest journal row.
 * `attempt` is durable across crashes, so a restart does not reset the bound (D42).
 */
export type EffectState =
    | { readonly state: "neverStarted" }
    | {
          readonly state: "complete";
          readonly lastDoneSeq: number;
          readonly revision: string;
      }
    | {
          readonly state: "midSequence";
          readonly lastDoneSeq: number;
          readonly revision: string;
      }
    | {
          readonly state: "sentUnknown";
          readonly seq: number;
          readonly intent: string;
          readonly attempt: number;
          readonly revision: string;
      };

/** One unresolved `sent` journal row — the sweep's unit of work. */
export interface OpenIntent {
    readonly effectId: string;
    readonly seq: number;
    readonly intent: string;
    readonly attempt: number;
    readonly at: string;
    readonly revision: string;
}

/** One `done` journal row, as a write the platform made on an item (D159). */
export interface StoredOwnWrite {
    /** The row's call VERB, which only a release shares with its operation's name. */
    readonly operation: string;
    /** The login a release names; absent on every call that names none. */
    readonly login?: string;
    readonly doneAt: string;
}
