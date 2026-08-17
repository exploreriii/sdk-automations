# Capability Contract Proposal

> **Built** — `packages/core/src/capability/boundary.ts` and `declaration.ts` implement this contract
> and cite it by section; the probes exercise it. The TypeScript names below settled.

- A draft for the first two capability experiments; exact TypeScript names may still change.
- The isolation, permission, configuration, and outcome requirements are part of the architecture review.

## 1. Declaration

```ts
interface CapabilityDeclaration {
  readonly name: string;
  readonly triggers: readonly Trigger[];
  readonly configKeys: readonly string[];
  readonly observations: readonly string[];
  readonly resolvers: readonly string[];
  readonly intents: readonly string[];
  readonly operationalNeeds: OperationalNeeds;
}

type Trigger =
  | { readonly kind: "event"; readonly event: string }
  | { readonly kind: "schedule"; readonly description: string };

interface OperationalNeeds {
  readonly schedule: boolean;
  readonly durableState: "none" | "candidate" | "required";
  readonly crossItemCoordination: boolean;
  readonly externalDelivery: boolean;
}
```

- Every capability declares what the platform needs to validate and isolate it.
- It reaches configuration validation, permission diagnostics, test generation, operator reporting.
- A capability cannot request an undeclared resolver or intent.
- The registry separates reporting from activation (D58).
- `describe` returns only a capability's name and retirement status.
- `get` is the sole declaration lookup and refuses to return a retired capability.
- Report-only data therefore cannot be mistaken for an activatable declaration.

**Permissions are not declared.** They are derived from `INTENT_OPERATIONS` per intent (D62), so a
capability cannot restate, widen, or elevate its own grant. The same rule moved the idempotency class
to the platform: a declaration that could supply it could also lie about it.

**Two shapes, one admission path** — `packages/core/src/capability/declaration.ts`.

- `CapabilityDeclaration` keeps `readonly string[]`, so a malformed external declaration stays
  runtime-validatable.
- `TypedDeclaration` narrows `observations`, `resolvers`, and `intents` to catalogue keys.
- `declareCapability<const D>` is the only admission path — its `const` parameter pins the three name
  arrays as literal tuples. Annotating an object `: TypedDeclaration` widens them to `string[]` and
  every projection in `boundary.ts` degrades to "any name", losing the isolation the boundary exists
  to enforce.

## 2. Runtime boundary

```ts
interface Capability<D extends CapabilityDeclaration> {
  declaration: D;
  evaluate(
    observation: ObservationFor<D>,
    config: ConfigFor<D>,
    platform: PlatformHandle<D>,
  ): Promise<readonly IntentFor<D>[]>;
}

interface PlatformHandle<D extends CapabilityDeclaration> {
  resolve<Q extends D['resolvers'][number]>(
    query: Q,
    input: ResolverInput<Q>,
  ): Promise<ResolverResult<Q>>;

  explain(message: StructuredExplanation): void;
}
```

- The platform calls a capability with normalized facts, validated configuration, and a handle
  limited by the declaration.
- The handle exposes no Octokit, HTTP, raw webhook payload, arbitrary comment, unrestricted log, or sibling.
- The platform normalizes all external facts before evaluation.

## 3. Intent

```ts
interface Intent {
  capability: string;
  repository: RepositoryRef;
  item: ItemRef;
  operation: IntentName;
  expected: ExpectedFacts;
  desired: DesiredFacts;
  cause: DatedCause;
  explanation: StructuredExplanation;
  idempotencyKey: string;
}
```

- An intent describes a desired outcome rather than an API call.
- The policy layer rejects it when the capability is disabled or the repository is not active.
- It also rejects a missing installation permission, a stale `expected`, or a blocking safety rule.

## 4. Effect results

```ts
type EffectResult =
  | { outcome: 'applied'; verifiedAt: string }
  | { outcome: 'already'; verifiedAt: string }
  | { outcome: 'conflict'; current: NormalizedFacts }
  | { outcome: 'forbidden'; missingPermission?: GitHubPermission }
  | { outcome: 'retryLater'; after?: string; reason: string }
  | { outcome: 'unknown'; reason: string; recoveryKey: string };
```

| Outcome | Means |
|---|---|
| `applied` | The executor verified the postcondition after the write |
| `already` | The postcondition was present before a write was needed |
| `conflict` | Current facts no longer match the capability's expectation |
| `unknown` | The executor cannot prove whether a write occurred |

- A capability does not retry `unknown`, `forbidden`, or `conflict` results.
- The executor or reconciliation worker owns recovery.
- Recovery may request a fresh capability evaluation once current state is available.

## 5. Multi-call plans

- A single intent may require several GitHub calls.
- The executor must represent those calls as an explicit plan.
- The plan records the safe call order and the expected state after each call.
- It records the verification rule and the recovery rule after a crash or unclear response.
- The first implementation must not assume comment metadata can recover every plan.
- The owned store's intent journal records the plan and its progress.
- GitHub state resolves sent-but-unconfirmed calls.
- Comment metadata serves as effect identity and receipt only.
- Decided by the personal-sandbox experiment (protocol 6.5, 2026-07-23) — see
  `design/findings/storage-decision.md` (ratification pending).

## 6. Configuration and mapping access

- Configuration projects only the declared capability block and shared mappings into the capability.
- The capability refers to internal meanings rather than repository label strings.
- The policy and adapter layers resolve those meanings through validated mappings.
- A capability cannot enable itself, read another's configuration, or use an unmapped meaning.

## 7. Compatibility

- Independence does not make every arbitrary capability combination valid.
- Each declaration may name a compatibility rule the registry evaluates before activation.
- A rule may require a shared mapping, or forbid two capabilities owning one external effect.
- Compatibility rules do not allow direct capability calls.
- A workflow profile may package a tested set of rules and defaults.
- The profile still preserves separate capability declarations.

## 8. Conformance tests

The test kit derives these checks from the declaration.

- Undeclared resolvers and intents are unavailable.
- Disabled capability code receives no events or scheduled work.
- Only the declared configuration is visible.
- Permission mismatches prevent writes.
- Repeated observations converge on `already` without duplicate effects.
- Stale expectations return `conflict` and preserve newer human changes.
- Dry-run output exists for every declared intent.
- Rollback and disablement behave as the capability claims.
- Declared compatibility rules hold against supported combinations.

- The adapter and effect executor have separate contract tests against recorded GitHub behavior.
- Capability tests do not create private copies of GitHub response shapes.

## 9. Questions that remain open

- The project must select the first concrete observation, resolver, and intent types.
- The storage experiment must decide how recovery keys and plan progress persist.
- The configuration design must decide how mappings enter `ConfigFor<D>`.
- The first two candidates must prove whether the operational-needs declaration is sufficient.
- The hosting experiment must decide whether one or several executor processes may run at once.
