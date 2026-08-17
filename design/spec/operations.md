# Operations

> **Not built.** What production requires before the App can run for anyone else: an operator, stop
> controls, an audit record, and a named audience for every failure. The runnable shell has none of
> it. Measured answers live in [`../findings/`](../findings/); sequencing lives in
> [`../build-plan.md`](../build-plan.md).

## 1. The operator

One deployment gives every repository the same configuration, permissions, adapter behaviour, and
upgrades — but it needs an organization-owned operator, not one contributor's personal account
(Q1, Q13). Whoever takes it must be able to:

- store and rotate the App private key and the webhook secret;
- control deployment, kill switches, storage, backups, and retention;
- monitor webhook delay, queue depth, API limits, failures, and reconciliation;
- suspend processing without uninstalling the App;
- prove whether one or several application processes are active.

A personal development App is separate from the production App and is only ever used for sandbox work
(P8).

## 2. Intake

**The production receiver terminates GitHub's POST directly — no relay, tunnel, or forwarding tier.**
Protocol 6.2 demonstrated why: an acknowledging relay is structurally an ack-first receiver, so
GitHub's ledger records `OK` for deliveries the receiver never saw, recreating P9's loss window
somewhere no process discipline can reach. Relays are acceptable only in ring-zero development.

## 3. Process and coordination

Whether the first production version runs one process or several is open (D18 answers it for
business-hours operation; Q17 carries the rest). Whichever is chosen must define **deployment
overlap, restart behaviour, poison-item handling, and how pending work transfers to a new process.**
Current-state checks alone do not stop two processes reaching opposing decisions from the same stale
read.

## 4. Pacing

**The adapter is the only component that handles rate-limit and retry behaviour. Capabilities never
implement a private retry loop.** The adapter records primary and secondary rate-limit headers, uses
conditional reads where supported, paginates every list operation, paces writes, applies bounded
backoff, and stops retrying when GitHub's response says waiting is required. Measured budgets are in
[`../findings/endpoint-permission-matrix.md`](../findings/endpoint-permission-matrix.md) (Q10).

## 5. Failure audiences

Every failure class has one primary audience and a clear next step. **The App must not create a new
repository comment for every internal retry or temporary GitHub failure.**

| Failure | Primary audience | Candidate channel |
|---|---|---|
| Configuration is invalid or outdated. | The repository maintainer or configuration author. | A configuration report whose final form depends on permissions. |
| A capability lacks an installation permission. | The repository or installation owner. | The effective-configuration report names the missing permission and the blocked operations. |
| A command is refused or remains unclear. | The person who issued the command. | The command acknowledgement is updated with the current facts and a safe next step. |
| A capability repeatedly creates invalid intent. | The capability developer and the operator. | Telemetry and audit records, without repeated repository comments. |
| Webhook delivery or queue delay is sustained. | The operator. | Metrics and an alert naming the installation and the delay. |
| GitHub returns a sustained service or rate failure. | The operator; the repository only when user-visible service is affected. | The adapter reports it and pauses unsafe retries. |
| A repository item repeatedly crashes processing. | The operator. | The queue isolates the item and records enough detail for a safe replay. |
| The executor cannot tell whether a write happened. | The operator, and any directly affected command user. | The recovery record states the observed postcondition and the next reconciliation step. |

## 6. Audit records and retention

One audit record should connect the normalized observation, the effective configuration revision, the
capability decision, the typed intent, the policy result, the adapter calls, the final outcome, and
any recovery activity. The canonical delivery report covers the first half of that chain today; the
adapter and recovery halves do not exist.

An audit record carries no secrets and no unnecessary repository content. Retention period, access
control, deletion process, and whether public and private repositories need different handling are
open (Q17); ninety days was proposed for the delivery and journal tables under D43 and never
ratified. Repository comments are user-facing output, never the operational audit record.

## 7. Kill switches

Five stop controls, of which only the third exists:

- a **global** operator switch stops all new processing;
- an **installation** switch stops one organization or installation;
- a **repository mode** stops workflow-changing writes for one repository — *built*: `disabled` and
  `observe`;
- a **capability** switch stops one capability without touching another;
- an **item-level pause** may be supplied by a selected workflow profile.

The operator runbook must say what happens to queued and pending work when each switch activates.

## 8. Migration

Old and new automation must never write the same managed state at the same time (Q7). Every pilot
repository needs an inventory of its old triggers, permissions, state writes, effect writes,
disablement controls, and rollback steps before the App writes anything. A migration mapping may
translate old labels or fields into internal meanings; it stays specific to that repository and never
becomes universal platform policy.
