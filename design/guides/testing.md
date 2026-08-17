# Test Strategy for the GitHub App Platform

> **Partly built** — the strategy the suite grew from. Its adapter-contract and effect-recovery tiers
> have nothing to test yet.

- The strategy must prove capability isolation, GitHub adapter behavior, effect recovery,
  configuration safety, and rollout controls.
- Specific frameworks will be selected with the implementation.

## 1. Test layers

| Layer | Proves | Depends on |
|---|---|---|
| Pure platform logic | config merge, policy, safety, intent validation | nothing external |
| Capability unit | one capability's intent from observation and config | owned platform fakes |
| Capability conformance | no undeclared config, resolver, intent, permission | registry, type boundary |
| Adapter contract | normalized reads and narrow writes match GitHub | fixtures, sandbox calls |
| Effect recovery | redelivery, partial effects and restarts converge | executor, forced failures |
| Configuration integration | loading, validation, effective values, rollback | fixtures, sandbox config |
| Composition | supported combinations keep compatibility rules | real platform, fake adapter |
| End-to-end sandbox | installation, webhook, token, API, storage path | dev App, personal sandbox |
| Replay and shadow | a new version leaves no unexplained difference | audit records, shadow traffic |

- Pure platform logic also covers compatibility, and is deterministic.
- Conformance also proves a capability cannot reach a sibling capability.
- Effect recovery also covers unclear responses and concurrent human edits (§5).
- Configuration integration covers default-branch loading, strict YAML validation, dormant settings,
  schema errors, effective values, permission mismatch, and rollback.
- Composition also preserves declared ownership rules.
- End-to-end also covers configuration and the recovery path.
- Replay evaluates recorded or live read-only observations; shadow traffic must be approved first.
- Audit records used for replay are sanitized.

## 2. Test boundary

- Capabilities are tested against platform interfaces this project owns.
- GitHub response shapes are handled and tested at one adapter boundary.
- This keeps the C++ automation's strong per-handler testing.
- It adds tests for the seams the old system could not verify.
- It avoids giving every capability a separate hand-written model of GitHub.

## 3. Capability conformance kit

The kit derives its tests from the capability declaration and verifies each of these.

- Disabled capabilities receive no events or schedules.
- Only the declared configuration is visible.
- Undeclared resolvers and intents are unavailable.
- Missing permissions prevent writes.
- Dry-run output exists for every declared intent.
- Repeated observations produce no duplicate effects.
- Stale expectations and newer human changes are handled.
- Capability-specific disablement and rollback work.
- Every declared compatibility rule holds.

- Passing the kit shows the capability follows the platform contract.
- It does not prove the capability policy is desirable.
- Maintainer review and capability-specific tests provide that evidence.

## 4. Adapter fixtures

- Real GitHub payloads and responses are recorded from approved sandbox traffic.
- Every fixture records source endpoint, event, API version, and capture date.
- It also records the sanitization applied and the expected normalization.
- Hand-written fixtures stay acceptable for impossible or security-sensitive fault injection.
- The test must clearly identify them as synthetic.
- The suite must not pretend a synthetic fixture proves real GitHub behavior.
- Adapter coverage: pagination · `null` and missing fields · redirects · conditional reads.
- Adapter coverage: rate-limit headers · secondary limits · validation errors · forbidden.
- Adapter coverage: timeouts · lost responses after a write may have succeeded.

## 5. Recovery matrix

Every multi-call effect is tested with failure after each call and before each verification read.

- The same webhook delivery arrives again.
- A different delivery describes the same current state.
- Events arrive out of order.
- GitHub applies a write but the response is lost.
- The process stops before recording progress.
- The process stops after recording progress but before the next call.
- A human makes the same change while the App is stopped.
- A human makes an opposing change while the App is stopped.
- A permission is removed during recovery.
- The mapped label or managed comment is renamed, edited, or deleted.
- Two executor processes attempt the same or opposing effects, where hosting permits that.

- The expected result is `applied`, `already`, `conflict`, `forbidden`, `retryLater`, or `unknown`.
- The test fails when the executor guesses success without verifying the postcondition.

## 6. Configuration matrix

- File states covered: absent · empty · valid · invalid · unknown-key · outdated · future-version.
- Change states covered: default-branch changes · pull-request-only changes · mode changes · rollback.
- Mapping states covered: disabled capabilities with dormant settings · mapping conflicts.
- Also covered: missing or renamed labels · missing fields · missing permissions.
- The suite proves no configuration and invalid configuration cause no workflow-changing writes.
- It proves every capability stays off when omitted or explicitly disabled.
- That holds even when a workflow profile provides settings.

## 7. Security tests

- Covered: invalid webhook signatures · replayed deliveries · command spam · forged markers.
- Covered: untrusted mentions and markup · oversized configuration · permission reduction.
- Covered: queue saturation · secret redaction.
- The App never runs pull request code with its write credentials.
- Fork and private-repository behavior is tested with the development App first.
- That happens before the corresponding capability is offered.

## 8. Required checks by stage

| Stage | Required evidence |
|---|---|
| Every pull request | pure logic, unit, conformance, configuration, security, failure injection |
| Release candidate | adapter contracts, effect recovery, composition, migration, replay |
| Personal sandbox | real webhook, token, API, storage, disablement, rollback |
| Hiero Hackers sandbox | observe, dry-run, reversible write, kill switch, clean soak |
| Volunteer pilot | maintainer approval, shadow comparison, rollback rehearsal |

- Pull-request failure-injection tests must be deterministic.
- A volunteer pilot also needs an agreed clean observation period.

## 9. Verification tiers within a layer

The implementation packages established a progression, each tier finding what the previous could not.

| Tier | Technique | Standing |
|---|---|---|
| 1 | Example tests | the floor, not the goal |
| 2 | Exhaustive enumeration | replaces examples over small finite spaces |
| 3 | Property-based tests | fast-check, fixed seeds, stated invariants |
| 4 | Model-based interleaving | a reference model beside the real component |
| 5 | Mutation audits | Stryker measures what the suite observes |

- Evidence, 2026-07-25: three real bugs and roughly twenty blind spots across `core/` and `store/`.
- New platform code — the stage-five shell above all — applies the tiers as it is written.
- Enumeration covers every safety context, meaning subset, and transition triple; it beats sampling
  and removes "did we pick the right examples?" — but only for the dimensions it NAMES.
- The safety sweep claimed 384 contexts while holding the action class fixed at one of five values.
- The omitted dimension is exactly where D52 lived, and 152 passing tests did not see it.
- A sweep that fixes an input is an example test wearing a sweep's name.
- Property tests cover unbounded spaces with stated invariants: parsers never throw and are fixed
  points; identifiers round-trip unchanged; timestamp order is chronological order.
- They found the mixed-precision ordering bug that examples missed.
- Interleaving runs hundreds of seeded random operation orders, asserting equality at every step.
- Current store operations are sequential, not simultaneous.
- The executor's 64 scheduled histories are not 64 exercised crash pairs — 18 both, 30 one, 16 none.
- Future multi-call effects must enumerate reachable failure points, assert every requested fault
  fired, add live overlap, and assert convergence plus non-duplication.
- CI runs Stryker on every pull request and push for each package owning a Stryker config.
- A deliberate cost, accepted 2026-08-15: the score is the proof behind every suite consolidation.
- Full surviving-mutant triage happens where "the tests are the spec" is under review: before
  stage-four ratification and before each pilot ring.
- Surviving mutants become a new test, or are documented as provably equivalent.
- A fake used by tiers 2–4 must state where it is kinder than the real dependency (D46: the crash
  grid's world answers reads with perfect consistency; GitHub does not).
- A test comparing a constant against itself proves nothing — assert literal shapes.

## 10. Questions that remain open

- The implementation must choose the test frameworks and fixture storage format.
- The project must define how sandbox records are sanitized and retained.
- The storage decision must determine database and queue integration tests.
- The hosting decision must determine process-overlap and deployment tests.
- The first capability must define policy-specific cases beyond the conformance kit.
- Maintainers must define the clean observation period for a pilot.
