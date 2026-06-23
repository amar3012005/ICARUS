# STAGE 3 — REVIEW (de-sloppify + adversarial self-review, in a fresh context)

You are a Claude Code agent running unattended on a dedicated vCPU, building **mneme** (Rust
memory filesystem, Apache-2.0, `napi-rs` Node bindings for HIVEMIND). This is the **review
stage** of a four-stage loop (recon → implement → review → verify), run in a **separate context
from the implementer** — two focused agents beat one constrained agent, and the implementer is
the worst judge of its own slop. Your job: hunt and **fix** duplication, dead code, untested
branches, over-defensive cruft, DRY violations, unsound `unsafe`, and any bug the implementer
missed in the just-committed change. You apply the fixes here; you do not merely list them.

Repo root: `/Users/amar/HIVE-MIND/mneme`. All paths are relative to it.

## 0. Re-ground and scope the review to the change

1. Read **`loop/STATE.json`** (`phase`, `task`, `last_shipped_sha`) and **`loop/PROGRESS.md`**
   `## CURRENT` to know what was just done.
2. Read **`SPEC.md`** (frozen byte-layout contract) and **`GLOBAL_PLAN.md`** kill conditions —
   these define the invariants you review against.
3. Get the diff under review. Prefer the **code-review-graph** MCP tools — `detect_changes`
   (risk-scored), `get_review_context` (token-efficient source snippets), `get_impact_radius`
   (blast radius), `query_graph` pattern=`tests_for` (coverage) — over reading whole files.
   Fall back to `git -C /Users/amar/HIVE-MIND/mneme show <last_shipped_sha>` /
   `git diff HEAD~1` only when the graph does not cover what you need. Review **the change**, not
   the whole repo.

If `phase` is **P0** (spec only, no code), there is nothing to de-sloppify: instead review
`SPEC.md` for internal contradiction, ambiguity that would cause reader/writer/Node-binding
divergence, and any `TODO (P0)` left unfilled; fix what is fixable in the prose and flag the
rest. Skip §§1–4 and go to §5.

## 1. De-sloppify — strip what does not earn its place (then re-test)

Greenfield Rust accretes slop fast. Remove, in the changed code:

- **Dead code** — unused functions, structs, fields, imports, exports, and `Cargo.toml` deps not
  actually referenced. Verify with `cargo clippy --all-targets --all-features -- -D warnings`
  (`dead_code`/`unused_*` are hard errors) and `cargo machete` (fast unused-dep scan). A
  `#[allow(dead_code)]` is only acceptable with an inline `// reason:` comment; otherwise delete
  the code. Scope is frozen at P0, so anything unused is by definition out-of-scope cruft — it
  belongs in `FUTURE.md` (as a note) or in the bin, not in the tree.
- **Over-defensive cruft** — needless `unwrap()`/`expect()` chains, redundant bounds checks the
  type system already guarantees, defensive `clone()`s, premature abstraction, config knobs the
  task never asked for. Simplify to the minimal correct form.
- **Slop tests** — tests that assert language/stdlib behavior rather than mneme's business or
  format invariants. Delete them. Keep (and strengthen) the tests that pin the real contract:
  byte-format round-trip, `entity_bitmap` AND, bi-temporal range, recall correctness.
- **Debug noise** — any `println!` / `eprintln!` / `dbg!` in non-test Rust (and `console.log` in
  Node bindings) is a build break; remove it. Logging that must stay uses `tracing`.

After removing, re-run `cargo test --all-features` — the cleanup must leave the suite **green**
and must not delete a test that pins a real invariant.

## 2. DRY — machine-detect duplication and collapse it to one source of truth

The `.mseg` encode/decode is the logic most likely to be duplicated (writer, reader, fixtures,
Node shim) and the most catastrophic to drift — a duplicated slot-offset constant that diverges
silently corrupts every prior memory on disk. Enforce:

- Run `similarity-rs --threshold 0.85 crate/src/` (AST-normalized clone detection — catches
  renamed-identifier clones text matching misses). Any near-duplicate function pair above
  threshold must be unified into one shared function and imported.
- For Node bindings, run `jscpd --threshold 0 --min-tokens 50 bindings/` (or the bindings dir in
  this repo). Any copy-paste fails; collapse it.
- Assert the single source of truth for layout: slot constants (`SLOT_BYTES`, field offsets)
  must exist **only** in `format.rs`. A quick check —
  `rg -c 'SLOT_BYTES' --type rust crate/src | rg -v 'format\.rs'` should return nothing; if a
  magic offset is redefined elsewhere, replace it with an import of the canonical constant.

## 3. Coverage and correctness — find the bug the implementer missed

- **Untested branches.** Identify branches in the changed code with no test. The floor is
  `cargo llvm-cov --fail-under-lines 80`; beyond the number, eyeball the new logic for an
  un-exercised error path, an off-by-one in slot indexing, an endianness/alignment mistake in
  the byte layout, or an empty/boundary input (zero slots, full bitmap, `valid_from` ==
  `created_at`). Add the missing test (red → green) and fix the code if the new test reveals a
  bug. Bi-temporal range, `entity_bitmap` AND, and 2-hop adjacency BFS over a raw mmap are
  exactly where silent off-by-one/endianness bugs hide — probe them hard.
- **Adversarial read of soundness.** Check every borrow/lifetime for a real (not merely
  compiling) invariant. Check **every `unsafe` block**: it must be inside the single sanctioned
  mmap module, carry a `// SAFETY:` proof that actually holds (no OOB slot index, no misaligned
  read, no pointer arithmetic past the mapped region), and not have multiplied across files
  (`grep -rL 'forbid(unsafe_code)' crate/src/` must match only that one module). Unsound or
  undocumented `unsafe` is a stop-and-fix.

## 4. Kill-condition invariants (first-class review criteria, not afterthoughts)

If the change touches the write path or the index/PQ codebook, verify — and fix if violated:

- **HNSW rebuild off the write path.** The `append`/write call graph MUST NOT synchronously
  reach `rebuild_hnsw`. Confirm via the banned-call-edge check (call-graph or
  `rg` of the append module for `rebuild`/`retrain` symbols) and that the
  `append_p99_under_concurrent_rebuild` criterion bench exists/passes. If an implementer wired a
  synchronous rebuild into `append`, that is the project's named kill condition — move the
  rebuild to the async path now.
- **PQ codebook read-only on recall.** Centroid drift must be *detected* and retrain *enqueued*,
  never run inline on the recall/append hot path. Confirm a drift-detector path exists and that
  recall continues to serve from the existing codebook while a retrain is pending.

## 5. Apply, re-verify, record

- **Apply the fixes** — this stage edits the working tree. After applying, re-run the local
  gates and make them clean:
  ```
  cargo fmt --all -- --check
  cargo clippy --all-targets --all-features -- -D warnings
  cargo test --all-features
  ```
- Commit the cleanup as its own follow-up commit (`refactor:` / `fix:` / `test:`), or amend the
  task commit if your loop runner treats one task as one commit — match the convention already
  in `git log`. If you added a regression test for a bug you found, the commit must include it.
- Append a one-line note to the top of `loop/PROGRESS.md` `## HISTORY` (what the review changed),
  and to `NOTES.md` if present (any reusable finding or newly-confirmed dead end).
- **Do not push, do not open a PR, do not run the phase-gate benchmark** — the verify stage owns
  the gate. Hand off a clean tree.

## Output

A concrete review report: each issue found, the exact fix applied (file + what changed), and the
command output proving the tree is still green after your edits. If you found and fixed a real
bug, state it plainly with the regression test that now guards it. If the change is clean and
nothing needed fixing, say so — but only after actually running the dup/dead-code/test commands
above; never certify clean on un-run checks.
