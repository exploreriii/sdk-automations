# runtime — everything that runs

The one package that touches the outside world, in three directories with the layer rules the
dependency cruiser holds as directory rules:

- [`src/store/`](src/store/README.md) — the owned operational store: deliveries, the effect journal,
  schedules. Sits on core only.
- [`src/adapter/`](src/adapter/README.md) — the only code that talks to GitHub, one directory per
  job (D176): `client/` talks, `reads/` reads, `writes/` changes. Sits on core only, and is imported
  by the composition root alone.
- [`src/shell/`](src/shell/README.md) — the transport, one directory per box of its drawing (D172):

  - `compose/` — the environment as one record, the live seams, and the start.
  - `inbound/` — the webhook lane: verify, accept, claim, decide, complete.
  - `sweep/` — the sweep lane: the schedule row, one firing's budgets, the driver.
  - `decide/` — the one box both lanes call, and the config and externals it decides through.
  - `apply/` — the applier as a loop over a five-row table, one module per operation below it.
  - `jobs/` — the tick's four named jobs, and the shutdown order.
  - `observe/` — the read-only commands behind `pnpm shell:explain` and `pnpm shell:status`.
  - `log.ts`, `paths.ts`, `effects.ts` — the vocabulary every directory above may name.

The barrel re-exports the three; a consumer sees one package. Tests mirror the tree under `test/`,
with one exception that proves the rule: `test/sweep.test.ts` is about the seam BETWEEN the adapter
and the shell, which neither directory may import the other across, so it sits above both and
reaches each through its barrel — the way the composition root does. Run it from the repository
root: `node --import tsx packages/runtime/src/shell/compose/main.ts`.

**The package mutation break threshold is 90**, the gate the adapter and shell carried before the
merge. CI also enforces the store's existing 96 threshold from the same mutation report, so merging
the packages does not lower its ratchet.
