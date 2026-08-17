# Candidate Capabilities

Eight candidates: **not ranked, not built.** The first is chosen by maintainer demand (Q2, still open),
not by this file's order. Each document follows [`TEMPLATE.md`](TEMPLATE.md), and its §1 declaration
becomes lockable against `packages/core/src/capability/declaration.ts` the day it is built.

## The ranking table

Q2's instrument. The ceiling is `issues:write`, `pull_requests:write`, `contents:read`
(`design/findings/endpoint-permission-matrix.md`, "The ceiling"). Demand cites the service tables in
`design/audit/services.md` §2 by group.

| Capability | Job | Permissions vs ceiling | Operational needs | Effect risk | Demand evidence |
|---|---|---|---|---|---|
| [`pr-quality`](pr-quality.md) | Explain what still blocks a pull request | within for the linked-issue slice; check signals need `checks:read`, deliberately withheld | none declared | comment-only | C++ dashboard, Python partial, JS gate (§2 group 3) |
| [`intake`](intake.md) | Turn a new issue into a next step | within | none declared | comment-only, then reversible label | Python moderate-and-lock, C++ `/finalize` (§2 group 1) |
| [`assignment`](assignment.md) | Let a contributor claim and release work | within; cross-repository limits would exceed | durable state candidate; cross-item | reversible label and assignee | C++ and Python both, marked 🟢 (§2 group 2) |
| [`inactivity`](inactivity.md) | Warn, then release stalled work | within | needs schedules; durable state candidate | destructive — unassign or close | C++ and Python both, marked 🟢 (§2 group 4) |
| [`notifications`](notifications.md) | Deliver one focused alert | exceeds — `actions:read` plus off-GitHub delivery | needs schedules; durable state required | comment-only on GitHub, but an external send is unrecallable | Python alerts, JS Slack feed (§2 group 6) |
| [`review-routing`](review-routing.md) | Recommend or request reviewers | exceeds when team routing needs organization `members:read` | durable state candidate; cross-item | reversible request, but notification noise | Python `queue:*` only (§2 group 3) |
| [`progression`](progression.md) | Recognise completed work, suggest next | within, but **needs org-wide data — out of the first milestone by its own doc** (D57) | durable state candidate; cross-item | reversible label; public ranking can still harm | C++ and Python both, marked 🟢 (§2 group 5) |
| [`admin`](admin.md) | Rotate mentors, maintain a denylist | **exceeds ceiling — evidence-gathering only**: `contents:write` to propose, organization `members:read` to decide | needs schedules; durable state candidate | its proposal operation is not an approved adapter operation | Python only (§2 group 7) |

## The meaning matrix

The seven `MAPPABLE_MEANINGS` (`packages/core/src/config/schema.ts`). R read · W write · blank neither.
`?` marks a cell derived from a document's behaviour prose rather than quoted from it.

| Capability | awaitingTriage | ready | inProgress | needsReview | needsRevision | readyToMerge | blocked |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `pr-quality` | | | | W? | W? | R? | R? |
| `intake` | RW? | W? | R? | | | | R? |
| `assignment` | | RW? | RW? | | | | R? |
| `inactivity` | | W? | R? | R? | R? | | R |
| `notifications` | | | | R? | | R? | R? |
| `review-routing` | | | | R? | R? | W? | R? |
| `progression` | | | | | | R? | |
| `admin` | | | | | | | |

Only one cell is quoted: `inactivity` configures blocked behaviour explicitly. Every other cell is
inferred, because no candidate document names a meaning from `MAPPABLE_MEANINGS` — the matrix is a
hypothesis to confirm, not a record. `progression` writes `skill:` labels, which are outside these seven.

**`ready` carries three W entries — an A1-class coupling risk.** `intake` promotes into it, `assignment`
leaves it on a claim and returns to it on a release, `inactivity` returns reaped work to it. That is
exactly A1's shape, the shared `status:` namespace no single feature owned, and A3's pair, assignee and
position mutated together by separately togglable features (`design/audit/lessons-learned.md`). `ready`
needs a named owner and one documented edge per writer before any two of the three can be ranked
together. The `blocked` column is read-only for every row: only a human may pause an item (D79).

## Profiles

| Profile | Members | What the profile supplies |
|---|---|---|
| contribution | `intake` + `assignment` + `inactivity` | the `ready` and `inProgress` mappings all three touch, and the timers — unresolved until `ready` has an owner |
| pull request | `pr-quality` + `review-routing` | one distinct managed-comment marker per member and a shared pull-request-flow mapping |
| signals | `notifications` alone | nothing shared; its coupling is the delivery channel, not a meaning |

A profile supplies mappings, defaults, and tested compatibility rules. It never enables a member (P2),
and every member stays independently disableable (P3).

## Independence, and what this catalogue is for

A capability is independent when it names no sibling, receives only its own validated configuration and
the platform interfaces its contract declares, holds no Octokit or raw GitHub context, stops every read,
write, and schedule when disabled, and can do its job with no sibling enabled. Manual state entry proves
reachability, not that every combination is safe. The catalogue records what the audit found so it is not
lost; it does not oblige anyone to rebuild an old service, and GitHub-native behaviour or a
repository-local Action may remain the better answer for a row. Capabilities choose from closed platform
vocabularies (`packages/core/src/capability/catalogue.ts`, D61) — a capability that needs an operation
outside them extends the catalogue by review, which is the intended cost.
