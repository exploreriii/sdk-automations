# Contracts

What the code must keep satisfying. Every document here is read by a check, so drift fails the suite
instead of waiting to be noticed.

| Document | The check that reads it |
|---|---|
| [`taxonomy.md`](taxonomy.md) | `packages/dev/checks/test/doc-drift.test.ts` — every state-diagram edge equals a `PROFILE_EDGES` row |
| [`config-schema.md`](config-schema.md) | `packages/dev/checks/test/spec-drift.test.ts` — the modes table is `REPOSITORY_MODES`; every accepted top-level key appears |
| [`safety.md`](safety.md) | `packages/dev/checks/test/safety-drift.test.ts` — the refusal table is `SafetyRefusalCode`, exactly |

**The entry rule: no check, no entry.** A document arrives here with the test that locks it, or it
belongs in [`../guides/`](../guides/README.md) as a build guide. A contract nobody executes is a
proposal wearing a contract's name, and the difference is invisible from the prose.

A guide is promoted here when its subject is built AND a check reads what remains. Built without a
check is not enough — that is how `contract.md` came to sit in `guides/` while its code exists.

The system as it stands is drawn in [`../architecture.md`](../architecture.md).
