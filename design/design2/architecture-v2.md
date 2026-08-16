# System architecture (v2 draft — temporary name)

> Drawings, not prose. One italic line under each names the code or test that falsifies it.
> Why: [`decisions.md`](decisions.md). The narrated journey: [`trace.md`](../trace.md).

## Part 1 — The system

### 1. Context

```mermaid
flowchart LR
    subgraph GitHub
        WH["Webhook deliveries"]
        REST["REST API"]
        CFG["automations.yml on the default branch"]
    end
    subgraph App["The App — one process, one disk"]
        SH["shell"]
        DB[("SQLite, single file")]
    end
    M["Maintainers"] -->|review and merge config| CFG
    WH -->|HTTP POST| SH
    CFG -->|read| SH
    SH <--> DB
    SH -.->|"no writes exist (P5, D46)"| REST
```

*Sources: `packages/shell/src/receiver.ts` · [`decisions.md`](decisions.md) P5, D46, D110.*

### 2. Packages — the allowed edges, and only those

```mermaid
flowchart TD
    shell["shell — transport"] --> core["core — pure logic"]
    shell --> store["store — SQLite"]
    shell --> probes["probes — capability stubs"]
    store --> core
    probes --> core
```

*An edge not drawn is forbidden — enforced by `.dependency-cruiser.cjs` via
`packages/dev/checks/test/architecture.test.ts`.*

## Part 2 — Inside each package

### 3. shell — the mode gate

```mermaid
stateDiagram-v2
    [*] --> Load: loadConfig
    Load --> Observe: file absent
    Load --> Parse: text read

    Parse --> Observe: empty document
    Parse --> Rejected: documentUnparseable, duplicateKey
    Parse --> Sections: YAML parsed

    Sections --> Rejected: notAMapping, unknownKey, schemaVersionUnsupported, modeInvalid
    Sections --> Observe: mode key absent
    Sections --> Disabled: mode disabled
    Sections --> Observe: mode observe
    Sections --> DryRun: mode dry-run
    Sections --> Active: mode active

    Rejected: record 'configRejected' — fail closed, nothing decided
    Active: record 'modeUnsupported' — BEFORE decide()

    Disabled --> Decide
    Observe --> Decide
    DryRun --> Decide
    Decide: decide() runs — gates refuse per intent (modeDisabled, modeRecordsOnly)
    Decide --> Done: record 'decision'
    Rejected --> Done
    Active --> Done
    Done: atomic completion — every path ends here
    Done --> [*]
```

*Sources: `packages/core/src/config/parse.ts` · `packages/core/src/config/sections.ts` ·
`packages/shell/src/processor.ts` — pinned by `packages/core/test/config/parse.test.ts` and
`packages/shell/test/shell.test.ts`.*

### 4. core — inside `decide()`

```mermaid
flowchart TD
    IN["input: delivery or observation"] --> K{"kind?"}
    K -->|delivery| N["normalizeDelivery — GitHub's wire format dies here"]
    K -->|observation| OBS
    N -->|ignored| FI["finding: deliveryIgnored (info)"]
    N -->|malformed| FM["finding: problem — one of seven malformed codes"]
    N -->|observation| OBS["observation + projection, computed once"]
    OBS --> LOOP{{"for each capability"}}
    LOOP -->|"not enabled, or observation undeclared"| SKIP["skip — no finding, zero trace"]
    LOOP --> VIEW["projectCapabilityView + EngineHandle"]
    VIEW --> EV["capability.evaluate → intents"]
    EV --> IL{{"for each intent: gateIntent"}}
    IL --> SC["screen"] --> DW["derive world"] --> GT["gate"]
    GT --> D["Decision — report + approved"]
    FI --> D
    FM --> D
    SKIP --> D
```

*Source: `packages/core/src/engine/decide.ts` — total by construction; zero-trace skip proven by
`packages/probes/test/engine-matrix.test.ts`.*

### 5. core — the capability boundary (probes plug in here)

```mermaid
flowchart LR
    subgraph engine ["engine — per admitted capability"]
        CFG["RepositoryConfig"]
        OB["observation"]
        RES["externals.resolve"]
    end
    subgraph crosses ["the three values that cross"]
        O["observation — positions and meanings, never labels"]
        V["config view — own settings + mappedMeanings (names only)"]
        P["platform — resolve (declared only) + explain"]
    end
    CFG -->|projectCapabilityView| V
    OB --> O
    RES -->|EngineHandle| P
    O --> CAP["capability.evaluate()"]
    V --> CAP
    P --> CAP
    CAP -->|returns| INT["intents — asking, never doing"]
    subgraph absent ["absent by shape — no type to reach for"]
        X1["✕ GitHub client / HTTP"]
        X2["✕ raw webhook payload"]
        X3["✕ a sibling capability's settings"]
        X4["✕ repository label strings"]
        X5["✕ mode, enabled, permissions"]
        X6["✕ a claimable DerivedWorld"]
    end
```

*Sources: `packages/core/src/capability/boundary.ts` · the three probes (`prQuality`, `intake`,
`inactivity`) are today's capabilities behind this boundary · leaks refuted by
`packages/probes/test/boundary.test.ts` · independence (P3) by
`packages/probes/test/engine-matrix.test.ts`.*

### 6. core — safety: how an intent becomes a verdict

```mermaid
flowchart TD
    I["intent"] --> SC{"screen — eight refusal codes"}
    SC -->|"foreignCapability, undeclaredIntent, invalidCause, authoritativePositionUnavailable, positionConflict, pauseNotCapabilityWritable, meaningWrongEntity, transitionNotOnMap"| SF["finding (problem) — the gate never runs"]
    SC -->|ok| DW["deriveWorld(projection, expected) — claims are checked, never trusted"]
    DW --> PRE{"preflight"}
    PRE -->|"killSwitch, preconditionStale"| R
    PRE --> DOOR{"door policy"}
    DOOR -->|"wrongEntryPoint, preventiveGateUnavailable"| R
    DOOR --> GEN["general rules, in order — precedence is contract"]
    GEN -->|observation| RO["record-only"]
    GEN -->|"capabilityDisabled, permissionMissing, itemBlocked, humanOrderingUnknown, invalidTimestamp, newerHumanChange, modeDisabled"| R["refuse + SafetyRefusalCode"]
    GEN -->|modeRecordsOnly| RO
    GEN -->|"no rule fired"| AP["apply"]
    AP --> APPR["Decision.approved"]
    R --> F["verdictFinding — severity from one table"]
    RO --> F
    AP --> F
    SF --> F
```

*Sources: `packages/core/src/safety/rules.ts` · `packages/core/src/safety/write.ts` ·
`packages/core/src/report/convert.ts`. The destructive door
(`packages/core/src/safety/destructive.ts`) is unreachable from `decide()` today.*

### 7. core — the workflow state machine

Drawn once, in [`core/taxonomy.md`](../core/taxonomy.md), where
`packages/dev/checks/test/doc-drift.test.ts` holds its every edge equal to `PROFILE_EDGES` in
`packages/core/src/workflow/transitions.ts`. Not copied here — a second drawing would be the
unchecked one.

### 8. store — five tables, five questions

| Table | The question it answers |
|---|---|
| `seen_delivery` | is this delivery durable, claimed, or done? |
| `delivery_report` | what did we decide for this delivery? |
| `effect_journal` | did this call reach GitHub? |
| `effect_claim` | who holds this effect's lease right now? |
| `schedule` | what clock-triggered work is due now? |

```mermaid
erDiagram
    seen_delivery {
        TEXT delivery_id PK
        TEXT event_name
        BLOB payload "NULL iff done"
        TEXT payload_digest "sha256 hex"
        TEXT received_at
        TEXT state "pending, processing, done"
        TEXT claim_worker
        TEXT claim_token
        TEXT claimed_at
        TEXT completed_at
    }
    delivery_report {
        TEXT delivery_id PK
        TEXT claim_token "the committing token"
        TEXT report_json
        TEXT completed_at
    }
    effect_journal {
        TEXT effect_id PK
        INTEGER call_seq PK
        TEXT intent
        TEXT status "sent, done"
        TEXT at
        INTEGER attempt
        TEXT revision
    }
    effect_claim {
        TEXT effect_id PK
        TEXT worker
        TEXT at "lease stamp"
    }
    schedule {
        TEXT schedule_id PK
        TEXT due_at
        TEXT effect
        TEXT status "pending, running, done"
        TEXT claimed_at
        TEXT claim_token
    }
    seen_delivery ||..o| delivery_report : "same GUID, no FK, one transaction"
```

*Source: `packages/store/src/schema.ts` — schema version 4; drift rejected by the D110 fingerprint.*

## Part 3 — How they interact

### 9. One delivery, in time

```mermaid
sequenceDiagram
    autonumber
    participant GH as GitHub
    participant R as receiver
    participant S as store
    participant P as processor
    participant E as core decide()

    rect rgb(235,235,235)
    note over GH,S: synchronous — inside the HTTP request
    GH->>R: POST bytes + delivery, event, signature headers
    R->>R: verifyBody — HMAC-SHA256 of the raw bytes (fail → 401)
    R->>S: acceptDelivery — exact bytes, state 'pending'
    S-->>R: accepted, duplicate, or conflict — INSERT ON CONFLICT is the dedup
    R-->>GH: 202 (conflict → 409)
    note over R,GH: P9 — the durable row exists before the ack, so a crash one millisecond later loses nothing
    end

    rect rgb(247,247,247)
    note over R,E: decoupled — after the response has flushed
    R->>P: onAccepted fires drain (fire-and-forget)
    P->>S: claimNextDelivery — 256-bit claim token, 15-minute stale takeover
    P->>P: loadConfig, then parseConfigDocument (text + sha256 revision)
    alt config rejected
        P->>P: record kind 'configRejected' — fail closed, still completed
    else mode active
        P->>P: record kind 'modeUnsupported' — before decide()
    else disabled, observe, or dry-run
        P->>E: decide(delivery, config, capabilities, externals)
        E-->>P: report → record kind 'decision'
    end
    P->>S: completeDeliveryWithReport — report row + 'done', one transaction
    note over P,S: any failure before commit releases the claim
    end
```

*Sources: `packages/shell/src/receiver.ts` · `packages/shell/src/processor.ts` — pinned end to end
by `packages/shell/test/shell.test.ts`.*

## Part 4 — The goal

### 10. What remains — solid is built, dashed is gated

```mermaid
flowchart LR
    subgraph today ["built and live"]
        IN["intake → decide() → report"]
        DORM["store: effect_journal, effect_claim, schedule<br/>(built, dormant — nothing reachable writes them)"]
        DOOR["destructive door<br/>(built, unreachable from decide())"]
    end
    subgraph goal ["gated — each piece names its gate"]
        ACT["active mode<br/>(D46 + stage-six evidence)"]
        WP["one write path per effect<br/>(adoption record, decisions §3)"]
        ADP["narrow adapter<br/>(operation list fixed by Q16 matrix)"]
        REC["effect recovery + reconciliation<br/>(consumes the dormant journal and claim tables)"]
        SWEEP["schedule sweeps → staleItemsDue<br/>(consumes the dormant schedule table)"]
    end
    IN -.-> ACT
    ACT -.-> WP
    WP -.-> ADP
    ADP -.->|"writes, verified postconditions"| GH["GitHub REST"]
    WP -.-> REC
    DORM -.-> REC
    DORM -.-> SWEEP
    SWEEP -.-> IN
    DOOR -.->|"first destructive capability"| WP
```

*The goal is drawn only where a register row supports it: gates and order in
[`build-plan.md`](../build-plan.md), stages five to eight · adapter operations in
[`endpoint-permission-matrix.md`](../operations/endpoint-permission-matrix.md) · everything else is
an open question in [`decisions.md`](decisions.md) §4, deliberately not drawn.*
