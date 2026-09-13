# automation-capabilities — one folder each, one registry

The capabilities the shell composes. Each lives in `src/<name>/` — its declaration and `evaluate`,
its settings, its own tests, and the design page it is built against — and `src/index.ts` lists them
as `CAPABILITIES`. The shell composes that list and names no capability, so adding one is a folder
and a line. This package imports core and nothing else, and does no I/O.

The four that ship, one line each: `intake` walks a new issue from its opening to triaged, ready
work; `prQuality` posts one dashboard comment telling a contributor what stops their pull request
being ready to review; `inactivity` reminds about stalled work and then releases it; `configReport`
comments on a pull request that changes `automations.yml`, saying what the App would read from it.
What each triggers on, maps, reads and may write is the generated table in
[`docs/capabilities.md`](../../docs/capabilities.md) — read that when this page and it disagree.

Writing one is [`design/trace.md`](../../design/trace.md), step by step, against the design page in
the folder; the tree is [`design/architecture.md`](../../design/architecture.md) §1.

```bash
pnpm --filter @hiero-hackers/automation-capabilities test
```
