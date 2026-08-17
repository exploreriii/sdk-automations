# Contracts

What the code must keep satisfying. Every document here is read by a check, so drift fails the suite
instead of waiting to be noticed.

| Document | The check that reads it |
|---|---|
| [`taxonomy.md`](taxonomy.md) | `packages/dev/checks/test/doc-drift.test.ts` — every state-diagram edge equals a `PROFILE_EDGES` row |
| [`config-schema.md`](config-schema.md) | `packages/dev/checks/test/spec-drift.test.ts` — the modes table is `REPOSITORY_MODES`; every accepted top-level key appears |
| [`catalogue.md`](catalogue.md) | `packages/dev/checks/test/catalogue-drift.test.ts` — the four closed lists, and each intent's idempotency class, action class, and permission |
| [`contract.md`](contract.md) | `packages/dev/checks/test/contract-drift.test.ts` — §1's interfaces are the declaration's fields, exactly |
| [`safety.md`](safety.md) | `packages/dev/checks/test/safety-drift.test.ts` — the refusal table is `SafetyRefusalCode`, exactly |

**The entry rule: no check, no entry.** A document arrives here with the test that locks it, or it
belongs in [`../guides/`](../guides/) as a build guide. A contract nobody executes is a
proposal wearing a contract's name, and the difference is invisible from the prose.

A guide is promoted here when its subject is built AND a check reads what remains. Built without a
check is not enough: `contract.md` sat in `guides/` for a month because its §1 sketch had drifted
from the type it described — a permissions block D62 deleted, and fields the code had renamed.

The system as it stands is drawn in [`../architecture.md`](../architecture.md).
