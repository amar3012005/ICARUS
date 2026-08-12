## What / why

One concern per PR. Explain the failure this fixes or the measurement that motivated it — this
codebase's comments carry root causes on purpose, keep that in the PR description too.

## Tests

- [ ] Engine change → `cargo test --workspace` case added/updated
- [ ] Binding change → a JS (`mneme-node`) or Python (`mneme-python`) test case added/updated
- [ ] Format change → confirms the spec-lock test still passes, or explains why `SPEC.md` needed
      to change (frozen RFC — this should be rare and deliberate)

## Performance claims (if any)

Real `bge-m3` embeddings only, before/after numbers from `bench/`, and the hardware it ran on.
Synthetic/random vectors are not evidence (no real cluster structure).

## Dependencies

New dependency? Say what it replaces or why nothing existing covers it.
