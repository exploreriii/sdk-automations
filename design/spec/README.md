# Spec

What each part of the platform must do — written before the code, and kept afterwards only where the
code is still tested against it. Every document says which of those two it is.

| Document | Status |
|---|---|
| [`taxonomy.md`](taxonomy.md) | **Built** — `packages/core/src/workflow/transitions.ts`; every edge held equal by `doc-drift.test.ts` |
| [`safety.md`](safety.md) | **Built**, except §3–§4 — `rules.ts` and `write.ts` implement the write rules; the clock-triggered destructive door exists in `destructive.ts` but nothing reaches it |
| [`config-schema.md`](config-schema.md) | **Built**, except §11 — `packages/core/src/config/`; migration and rollback are unwritten |
| [`manual-edits.md`](manual-edits.md) | **Partly built** — the human-precedence rule is in `workflow/project.ts`; the five incoherence classes are proposals |
| [`testing.md`](testing.md) | **Partly built** — the strategy the suite grew from; its adapter and effect-recovery tiers have nothing to test yet |
| [`projections.md`](projections.md) | **Not built — build guide.** Managed comments, markers, reactions, reports. No write path exists; this is the working answer to Q9 |
| [`resolvers.md`](resolvers.md) | **Not built — build guide.** Two of its five candidates (`linkedIssues`, `isAutomationActor`) are in the closed catalogue; three are not |

A **build guide** is finished when its subject is built: what the code does moves to that package's
README, and what stays here is only the part the code must keep satisfying — with the test that
keeps it honest named in the row above. A document with no such test is a proposal, however
confident it reads.

## Platform responsibilities

The services the shared platform owns. A capability receives only the part its declaration allows.

| Service | Responsibility | Built |
|---|---|---|
| Configuration | Loads, validates, projects, and explains repository configuration | yes |
| Observation | Converts GitHub events and current state into normalized facts | yes |
| Policy | Checks repository mode, actor authority, permissions, mappings, and safety rules | yes |
| Operations | Records audit information, recovery state, and kill-switch status | partly — records yes, kill switches no |
| Resolvers | Answers shared read-only questions through one documented mechanism | no — catalogue declared, no implementation |
| Effect execution | Plans, applies, verifies, and reconciles approved GitHub changes | no |
| Managed output | Owns App-authored comment identity, safe rendering, and updates | no |

The system as it stands is drawn in [`../architecture.md`](../architecture.md); what is scheduled and
what is gated is in [`../build-plan.md`](../build-plan.md).
