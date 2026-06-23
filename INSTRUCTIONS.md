# mneme — Production Constitution

> This is the law the autonomous Claude Code agent obeys on **every** iteration, with
> no human watching. It is not advisory. Each article names the exact command or gate
> that enforces it. If a gate is red, the work is not done — regardless of how the code
> "looks". You cannot ask the human a question mid-iteration; this document is written
> so you never need to. Read it at the start of every iteration alongside
> [`loop/PROGRESS.md`](./loop/PROGRESS.md).

## How to use this file

Run the **iteration checklist** at the bottom top-to-bottom on every loop. Each step
maps to one article below. A step is "passed" only when its command exits 0 (or its
gate's predicate is true) and you have seen the output **in this session** — never on
trust, never on memory of a previous run.

---

## Article 1 — RECON BEFORE WRITE (the prime directive)

You do **not** write a new module, struct, function >30 LOC, or dependency until you
have proven nothing already does it. Reuse always beats rebuild. The innovation budget
is the `.mseg` byte layout *only* (see [`SPEC.md`](./SPEC.md)); everything around it is a
reused crate.

**Before authoring any new source file or non-trivial function, do all three:**

1. Search the existing tree:
   ```sh
   rg -n "<capability keyword>" crate/ bench/        # ripgrep the repo
   ```
   and the HIVEMIND graph (`semantic_search_nodes` / `query_graph` MCP tools) — do not
   re-implement something that exists.
2. Search the ecosystem for an Apache/MIT-compatible crate:
   ```sh
   cargo search <keyword>                            # crates.io
   gh search repos "<keyword> rust" --limit 10       # GitHub
   ```
3. Record the finding in the commit body under a literal `RECON:` block, citing at
   least one search result, **or** an explicit `RECON: no-reuse-found because <reason>`.

**Non-negotiable reuse targets** (`reference/OPENSOURCE_RECON.md` is the full audit):

| Need | You MUST use | You must NOT |
|---|---|---|
| HNSW (P3) | the `usearch` crate | hand-roll HNSW. A new `*hnsw*` source file >150 LOC that is not a thin wrapper over `usearch` is a constitution violation. |
| Node bindings (P6) | `napi-rs` v3 | node-gyp, hand-rolled N-API, or any bespoke FFI. |
| mmap | `memmap2` | a custom mmap layer. |
| text compression | `lz4_flex` | a custom codec. |
| zero-copy header read | `zerocopy` | hand-written transmute/pointer casts outside the one sanctioned unsafe module. |

**Enforcement gate `recon-check`:** any commit adding a new `.rs`/`.js` file >30 LOC
without a `RECON:` block fails review. `Cargo.toml` must contain `usearch` once P3
starts and `napi` once P6 starts (allowlist); a `*hnsw*` file in `crate/src/` over the
LOC cap fails (denylist).

## Article 2 — NO DUPLICATE CODE

Shared logic — slot-header encode/decode, int8 cosine, bitmap AND, mmap accessors, the
slot-offset constants — lives in **exactly one place** and is imported. The `.mseg`
encode/decode is the single most dangerous thing to duplicate: a slot-offset constant
that diverges between the writer path, reader path, test fixtures, and the Node shim
silently corrupts the on-disk format.

**On every PR / pre-commit:**
```sh
similarity-rs --threshold 0.85 crate/src/         # AST-normalized clone detection (Rust)
jscpd --threshold 0 --min-tokens 50 bindings/     # copy-paste detection (Node shim)
```
A near-duplicate function pair above threshold **fails the build**. On a hit: extract the
shared logic into the single canonical module and import it — do not silence the linter.

**Single source of truth for layout constants:** `SLOT_BYTES`, `FORMAT_VERSION`, and all
field offsets exist only in `crate/src/format.rs`. This grep must print nothing:
```sh
rg -c 'SLOT_BYTES|FORMAT_VERSION' --type rust crate/src | awk -F: '$2>0 && $1!~/format\.rs$/'
```
If those magic numbers appear anywhere else, the format can drift — fail and fix.

## Article 3 — NO BUGS SHIP

You may never claim a behavior works on code that was not run. Correctness is proven by
machine, not by reading.

### 3a. TDD red→green (every new behavior)
Write the failing test **first**, see it fail for the right reason, then write the
minimal code to make it green. For format/PQ/HNSW units the failing test is a numeric
assertion (recall@10, latency, overlap %). No production function merges without a test
that exercises it.

### 3b. Bug fixes carry a regression test
A `fix:` commit must touch a test file in the same diff. Prove the new test RED on the
parent commit before applying the fix:
```sh
git stash && cargo test <new_test> ; git stash pop   # observe RED, then fix to GREEN
```
A `fix:` commit with no test-file change in its diff fails review.

### 3c. The full gate chain (HARD GATES — never advance on red)
Run, in order, and see each exit 0 **before** committing:
```sh
cargo fmt --all -- --check                                   # gate: fmt
cargo clippy --all-targets --all-features -- -D warnings     # gate: lint-rust (warnings = errors)
cargo test --all-features                                    # gate: test-rust (100% green; no un-justified #[ignore])
cargo llvm-cov --fail-under-lines 80                         # gate: coverage-rust (>= 80% lines)
```
On any Node-touching change also:
```sh
eslint --max-warnings 0 && prettier --check . && npm test    # gate: lint-node
knip                                                         # gate: deadcode-node (unused files/exports/deps)
```

### 3d. No performance regression
The product *is* a number. Across commits, gated benchmarks may not regress past the
phase threshold or beyond a 5% noise band:
```sh
cargo bench                                                  # criterion
critcmp base pr                                              # gate: bench-no-regression (fail if gated p50 regresses >5%)
```

### 3e. Memory safety
Crate root carries `#![forbid(unsafe_code)]`. The one mmap/raw-slot-read module opts out
via `#[allow(unsafe_code)]`; it is the **only** file allowed to. Every `unsafe` block
carries a `// SAFETY:` proof comment (enforced by `clippy::undocumented_unsafe_blocks`
as `-D`). The reader is fuzzed:
```sh
rg -L 'forbid\(unsafe_code\)' crate/src/   # must list ONLY the one sanctioned mmap module
cargo +nightly fuzz run mseg_reader        # feed corrupt bytes; assert no panic/UB (P2, P5 gates)
cargo +nightly miri test -p mseg-format    # UB detection where feasible
```
If the count of files containing `unsafe` increases beyond the single sanctioned module,
fail.

### 3f. No debug noise
No `println!` / `eprintln!` / `dbg!` in non-test Rust, no `console.log` in committed
Node. Use `tracing`. This grep must print nothing:
```sh
rg -n 'println!|eprintln!|dbg!' crate/src/ | rg -v '#\[cfg\(test\)\]'
```

## Article 4 — SCOPE IS FROZEN AT SPEC.md

`SPEC.md` is the contract. Once frozen (its document-control block filled and committed),
the `.mseg` byte layout and the in-scope manifest are locked. **Every new idea you have
mid-build goes to [`FUTURE.md`](./FUTURE.md) — never into the current phase's code.**
This is what mathematically guarantees each phase terminates: the per-phase work-unit
queue can only shrink.

- Changing slot size, a field offset, or field semantics requires an explicit `SPEC.md`
  version bump + a format-migration note in the **same** PR. The `spec-lock` gate asserts
  the Rust `FORMAT_VERSION` + offset constants in `format.rs` byte-match the layout table
  parsed from `SPEC.md`; a mismatch (code changed without a SPEC diff) fails.
- A PR that adds a top-level feature/module not in `SPEC.md`'s in-scope manifest fails —
  route it to `FUTURE.md` instead.
- "While I'm here, I'll also add…" is forbidden. If it is not the current work-unit's
  acceptance test, it is out of scope.

## Article 5 — EVERY PHASE ENDS WITH ONE VERIFIABLE ARTIFACT

A phase is **not** done because the code is written. It is done when its single
artifact — a number, a benchmark, a binary, a passing harness — exists and is recorded.
The literal pass/fail predicate per phase is in
[`loop/PHASE_GATES.md`](./loop/PHASE_GATES.md). You may not advance `STATE.json.phase`
until that predicate is true and the proof is committed.

| Phase | The one artifact (do not advance without it) |
|---|---|
| P0 | frozen `SPEC.md` (all four formats + API + invariants), human-reviewed |
| P1 | `bench/RESULTS.md`: int8 scan beats Qdrant REST @ N=10k on **real** HIVEMIND memories |
| P2 | `cargo test` 100% green + `cargo clippy -D warnings` clean + `cargo bench` baseline in `BENCH.md` |
| P3 | recall@10 < 5 ms @ 1M with entity filter, < 3% loss vs Qdrant f32 |
| P4 | recall@10 overlap > 96% vs f32 + working codebook drift detector |
| P5 | time-travel query correct across 1M slots in < 8 ms |
| P6 | HIVEMIND eval-harness ≥ Qdrant baseline + 72h soak clean (swap `core/src/ingestion/indexer.js`) |
| P7 | arXiv paper submitted + public repo + reproducible `xMEM` benchmark |

**Verification-before-completion (the cardinal sin to avoid):** never write "done",
"complete", or "passing" in a summary that is not immediately preceded, in the same
session transcript, by the real command output that proves it. Record every gated number
in [`BENCH.md`](./BENCH.md) with the git SHA that produced it and the baseline it beat —
proof of progress lives outside context, so a fresh post-compaction session can trust it.

**The two kill-condition invariants are first-class review criteria** (re-check on any
unit touching the index or PQ):
- The append write-path (`mseg::append`) must **not** reach `rebuild_hnsw` or
  `retrain_codebook` in its call graph. HNSW rebuild and codebook retrain are async/
  background only. Gate: a banned-call-edge check over the append module + a criterion
  bench `append_p99_under_concurrent_rebuild` that fails if append p99 regresses while a
  rebuild is in flight.
- PQ codebook is read-only on the hot path; centroid drift is **detected** (alignment
  score < 0.85 flags retrain) and retrain is **enqueued**, never run inline. A unit test
  feeds a drifted distribution, asserts the detector flags it, and asserts recall is
  still served from the existing codebook meanwhile.

## Article 6 — STATE DISCIPLINE

The loop survives weeks of context compaction only because state lives in files, not in
your head.

- **Commit cadence:** one work-unit = one commit, straight to the working branch
  (greenfield — no docker-cp, no prod box until P6). A commit lands only after Article 3's
  gate chain is green. Commit messages follow `<type>: <description>` (feat/fix/refactor/
  docs/test/chore/perf/ci) and carry the `RECON:` block from Article 1.
- **Author identity:** all commits are authored as **`amarsai3012005`**. Verify before
  committing:
  ```sh
  git config user.name    # must be amarsai3012005
  ```
- **`loop/PROGRESS.md` every iteration:** update the CURRENT block (phase, task, status,
  next artifact) at the start and append to HISTORY at the end of **every** iteration.
  This is the ground truth a fresh session rehydrates from.
- **`loop/STATE.json` every iteration:** advance `iter`; on a shipped unit set
  `last_shipped_sha` (re-running a unit must be idempotent — skip if the SHA already
  covers it); on phase advance increment `phases_done` and update `phase`. Honor
  `max_iter` and `consecutive_gate_failures` / `max_consecutive_gate_failures` as the
  anti-stall backstop — hitting a cap parks to BLOCKED, never silently spins.
- **`BENCH.md`:** append every measured number with its SHA. Never overwrite history.
- **HIVEMIND memory:** after any real file Edit/Write, `hivemind_ingest_code`; on an
  architectural choice, `hivemind_log_decision`; at the end of a meaningful task,
  `hivemind_save_conversation` tagged `session-progress`.
- **`loop/PAUSE`:** if this file exists, halt cleanly at the next checkpoint.

## Article 7 — WHEN TO STOP AND ASK THE HUMAN

Default posture: **keep going.** A gate failure is not a reason to stop — it is the next
work-unit (snapshot the finding to `loop/PROGRESS.md`, regenerate a narrowed unit, and
grind it). Runaway is bounded by `max_iter` and `max_consecutive_gate_failures` in
`STATE.json`, which park to BLOCKED rather than spin forever.

**Stop and set `STATE.json.blocked = true` (with `blocked_reason`) ONLY for genuine
product ambiguity that the spec does not resolve and that no amount of grinding can:**
- The `SPEC.md` is silent or self-contradictory on a decision needed to proceed (a real
  spec gap, not a thing you can decide and document).
- A phase gate threshold is genuinely unachievable and the fix requires changing the
  frozen spec or the program's success criteria (a human-only decision).
- P6 integration would touch production HIVEMIND in a way that needs human sign-off
  (live-org data, the `core/src/ingestion/indexer.js` swap on a real tenant).

**Do NOT stop for** anything decidable from `SPEC.md` + `INSTRUCTIONS.md`, a red gate, a
flaky test, a missing fixture, a reuse decision, or "I'm not sure this is the best
approach" — decide, document the decision (and route any new idea to `FUTURE.md`), and
continue.

---

## The iteration checklist (run this, in order, every loop)

1. **Rehydrate.** Read `loop/PROGRESS.md` (CURRENT + HISTORY) and `loop/STATE.json`.
   Confirm the active phase and work-unit. If `loop/PAUSE` exists → halt.
2. **Recon (Art. 1).** `rg` the tree + `cargo search`/`gh search` the ecosystem. Decide
   reuse-vs-build; draft the `RECON:` block. If a mandated crate covers it, use it.
3. **Plan.** Restate the work-unit's acceptance tests as the contract; bound the change
   to one commit. No scope outside `SPEC.md` (Art. 4) → else route to `FUTURE.md`.
4. **TDD red (Art. 3a).** Write the failing test/bench; run it; confirm it fails for the
   right reason.
5. **Implement to green.** Minimal code. No duplicate logic (Art. 2). No new `unsafe`
   outside the sanctioned module (Art. 3e). No debug noise (Art. 3f).
6. **De-sloppify.** Strip over-defensive `unwrap`/`expect`, dead code, commented blocks,
   slop tests. `knip`/`cargo machete` for unused deps/exports. `cargo test` still green.
7. **Adversarial self-review.** Borrow/lifetime soundness; every `unsafe` has `// SAFETY:`;
   the two kill-condition invariants hold (Art. 5).
8. **Gate chain (Art. 3c–3e).** `fmt --check` → `clippy -D warnings` → `cargo test` →
   `llvm-cov --fail-under-lines 80` → `cargo bench` + `critcmp` → fuzz/miri at P2/P5.
   Any red → fix; never advance on red.
9. **Dedup + spec-lock + recon-check (Art. 1, 2, 4).** `similarity-rs`, the SLOT_BYTES
   grep, `spec_matches_code` test all clean; `RECON:` block present.
10. **Verify the claim (Art. 5).** You have seen real passing output **this session**.
    No "done" without it.
11. **Ship (Art. 6).** Confirm `git config user.name` == `amarsai3012005`; one commit;
    record numbers in `BENCH.md`; `hivemind_ingest_code` / `log_decision`.
12. **Update state (Art. 6).** `loop/PROGRESS.md` CURRENT + HISTORY; `loop/STATE.json`
    `iter`/`last_shipped_sha`/caps. Mark the unit `[x]` only after ship is proven.
13. **Phase gate (Art. 5).** If it was the last unit in the phase, run
    `loop/PHASE_GATES.md`'s predicate. Pass → advance `phase`, record the artifact in
    `BENCH.md`. Miss → spawn a narrowed recovery unit; do **not** advance. Genuine spec
    ambiguity → `STATE.json.blocked = true` (Art. 7).

The only stable terminal state is `STATE.json.phase == "P7"` with the P7 launch
artifacts present. Until then, the resting state is **keep working**.
