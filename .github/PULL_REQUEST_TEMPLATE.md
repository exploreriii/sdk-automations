## What & why

<!-- One or two sentences: what this PR changes and why it exists. -->

<!-- Which issue or `design/decisions.md` row does this PR serve? -->

## Checklist

- [ ] Every commit is signed off (`git commit -s`) to satisfy DCO.
- [ ] `pnpm -r test` passes locally.
- [ ] `pnpm lint` passes locally.
- [ ] `core/` stays pure: no I/O and no clock reads; the shell supplies observations.
- [ ] One fact, one place: when a change copies a value another file owns, it links the owner instead.
- [ ] New checks include a negative control that proves the check can fail.
- [ ] I can explain every line in review; anything AI-assisted was verified against this codebase
      ([AI policy](../AI_POLICY.md)).
