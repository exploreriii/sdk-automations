---
name: capability-design
description: Author or revise a capability design doc in design/guides/capabilities/ — the section structure, config conventions, guard patterns, and bot voice this repo's capability docs follow. Use when designing a new capability, rewriting an old-style candidate doc, or reviewing edits to one.
---

# Designing a capability for sdk-automations

The exemplars are `pr-quality.md`, `inactivity.md`, and `assignment.md` in
`design/guides/capabilities/` — read the nearest one before writing.

## Evidence before design

Start from what exists: the C++ SDK bot (`hiero-ledger/hiero-sdk-cpp` `.github/scripts/`, central
config `hiero-automation.json`), the Python SDK bots (`hiero-ledger/hiero-sdk-python`
`.github/scripts/` — check `archive/` before treating a bot as live), and this repo's audit
(`design/audit/services.md` and the per-SDK deep-dives). Import their guards and their scars;
drop their plumbing (markers, regexes, env config). Where the two SDKs differ, make the difference
two example configs of one schema, not two features.

## The sections, in order

1. **Title** — `# name — the one-sentence job`, lowercase name matching the config key.
2. **Description** — 2–6 bare lines: what it does, the acts-on / never-acts-on split, the one
   or two rules a reader must not miss. No history, no audit citations, no rationale prose.
3. **What the output looks like** — real rendered examples of every comment the capability
   posts, in blockquotes. Voice: the C++/Python coaching register, professional and neutral —
   greet by name, name the reason, the fix, and the date; never scold. Show fail and unknown
   states, not only success. No markdown links with placeholder targets (the link checker
   rejects them — write "the Signing Guide (configured link)").
4. **What the config looks like** — full `automations.yml` blocks, valid YAML. Multiple examples
   when policies genuinely differ (the C++-shaped and Python-shaped presets). Follow with the
   rules prose only for what the examples cannot show.
5. **How it works** — one mermaid flowchart (guards in evaluation order), then a table where the
   behavior is tabular (per-check semantics, ladders), then only the prose rules that live
   nowhere else.
6. **Phases** — a table: Phase · Ships · Needs first. "Needs first" names every missing
   platform piece (catalogue entries, resolvers, sweep drivers, mapping families) honestly —
   vocabulary the catalogue lacks appears HERE, never silently assumed. Mark speculative rows
   `(candidate)`.
7. **Declaration** — triggers, observations, resolvers, intents, permissions, operationalNeeds;
   mark every entry `(exists)` or `(new)`, with the phase that needs it.
8. **Verified by** — `Scenario | Proves`. This table IS the spec of the edge cases: counting
   rules, races, dedup, dry-run, kill switch, human sovereignty. When prose gets trimmed, its
   semantics must survive here.

## Config conventions (all three exemplars follow these)

- **Explicit consent**: everything is opt-in; blocks carry `enabled: true`; "truthy is not
  consent". Never hang children off a scalar (`issues: true` + children is invalid YAML).
- **Meaning-sets and numbers**: guards are lists of mapped meanings (`claimableOnlyWhen`,
  `capIgnores`, `exemptWhen`) or numbers — never raw label strings. Check whether an existing
  meaning already expresses the rule before inventing config.
- **Cascade**: numbers resolve most-specific-first (reason → ladder → capability default), and
  each act threshold must exceed its remind threshold by `MIN_GRACE_DAYS` where warn-then-act
  applies.
- **Per-item blocks** when items may grow options (the pr-quality checks pattern) — a second
  option kind is the trigger to convert booleans to blocks.
- **Mapping families**: label spellings under `mappings.labels`, command spellings under
  `mappings.commands`, skill tiers under `mappings.skills` — shared vocabulary never moves into
  a capability's settings. A guard naming a meaning demands its mapping (unmapped = invisible).
- Inline comments state constraints on the keys they constrain; deny wins when meaning-sets
  conflict; misconfiguration is "reported as unusable, not silently ignored".

## Design rules that recur

- Advisory before destructive; warn-then-act behind the destructive gate; unknown never reads as
  pass, "under the cap", or "no conflict" (D51).
- Capabilities compose through meanings and timeline events, never by naming a sibling or
  parsing a sibling's comment prose (P3).
- Native GitHub controls are never fought; roles are never read — the native UI is every team
  member's bypass.
- Commit text and titles are attacker-controlled: escaped, mentions broken.
- Repo-local counting; org-wide reads are the parked ceiling question (D57).
- Managed comments: one per identity, updated in place; refusals cycle-scoped so repeats don't
  amplify.

## Finishing

Run the checks suite (`pnpm test` in `packages/dev/checks`) — citations, links, and doc drift
gate the docs. A direction change earns a register row in `design/decisions.md` (D130 is the
model); a candidate doc revision does not.
