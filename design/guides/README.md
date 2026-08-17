# Build guides

Unbuilt work, written down before the code. A guide is falsified by a decision, not by a test, and it
is retired the day its subject ships: what the code does moves into the owning package's README, and
whatever the code must keep satisfying moves to [`../contracts/`](../contracts/README.md) with a check.

The anatomy, so a reader knows what to expect: a **shape diagram** of the thing being built, the
**ground rules** it may not break, its **components as tables**, how it is **verified**, and
**done-when**. Sequencing lives on tracking issues, never here — a guide that dates itself rots.

| Document | Status |
|---|---|
| [`adapter.md`](adapter.md) | The first component that talks to GitHub; lands behind seams that already exist (#111) |
| [`effects.md`](effects.md) | The write path: naming, verification, reconciliation, rollback, and the unreachable destructive door |
| [`projections.md`](projections.md) | Managed comments, markers, reactions, reports — the working answer to Q9 |
| [`resolvers.md`](resolvers.md) | Five candidates; two are in the closed catalogue, three are not |
| [`operations.md`](operations.md) | Operator duties, intake requirement, kill switches, failure audiences, audit record, migration |
| [`manual-edits.md`](manual-edits.md) | Partly built — human precedence is in `packages/core/src/workflow/project.ts`; the incoherence classes are proposals |
| [`testing.md`](testing.md) | Partly built — the strategy the suite grew from; its adapter and effect-recovery tiers have nothing to test yet |
| [`threat-model.md`](threat-model.md) | Threats and required controls, drafted before permissions and storage were decided; needs an audit against the running system |
| [`contract.md`](contract.md) | Built, and still here — see below |
| [`capabilities/`](capabilities/README.md) | Nine unranked proposals; the first is chosen by maintainer demand (Q2) |

`contract.md` is the awkward one. Its subject is built, but its §1 records two deliberate divergences
from `packages/core/src/capability/declaration.ts` — a document that knowingly differs from the code
cannot claim a check, and a contract without a check is the thing this split exists to prevent.
Reconciling the two, then promoting it, is an open task.

What is scheduled and what is gated is in [`../build-plan.md`](../build-plan.md).
