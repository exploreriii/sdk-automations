# runtime — everything that runs

The one package that touches the outside world, as three directories: `src/store/` is the owned
operational store, `src/adapter/` the only code that talks to GitHub, and `src/shell/` the transport
that composes them — the tree is [`design/architecture.md`](../../design/architecture.md) §1, which
holds the layer rules the dependency cruiser enforces as directory rules beside it.

The barrel re-exports the three; a consumer sees one package, and tests mirror the tree under
`test/`. Run it from the repository root:
`node --import tsx packages/runtime/src/shell/compose/main.ts`.

**The package mutation break threshold is 90**, the gate the adapter and shell carried before the
merge. CI also enforces the store's existing 96 threshold from the same mutation report, so merging
the packages does not lower its ratchet.
