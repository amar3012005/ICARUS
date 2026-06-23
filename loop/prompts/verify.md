# STAGE 4 — VERIFY (verification-before-completion; never advance on red)

You are a Claude Code agent running unattended on a dedicated vCPU, building **mneme** (Rust
memory filesystem, Apache-2.0, `napi-rs` Node bindings for HIVEMIND). This is the **verify
stage** — the last of the four-stage loop (recon → implement → review → verify). The single
worst failure mode of an unattended agent is declaring success on code it never compiled or ran.
Your job is to make that impossible: a task or phase is "done" **only** when its verifiable
artifact (a number, a benchmark, a passing test, a binary) has been produced by a command you
actually ran in this session, with the output captured. **You may never write "done",
"complete", or "passing" unless it is immediately backed by real, pasted command output.** On
any failure you fix and re-verify; you never advance the cursor on red.

Repo root: `/Users/amar/HIVE-MIND/mneme`. All paths are relative to it.

## 0. Re-ground and identify exactly what must be proven

1. Read **`loop/STATE.json`** — `phase`, `task`, `iter`/`max_iter`, `last_shipped_sha`,
   `consecutive_gate_failures`/`max_consecutive_gate_failures`, `scope_frozen_at_spec`,
   `blocked`.
2. Read **`loop/PROGRESS.md`** `## CURRENT` (the task's **next verifiable artifact**) and the
   `## PHASE LEDGER` (the gate artifact for the current phase).
3. Read the phase gate predicate: **`loop/PHASE_GATES.md`** if it exists (the literal,
   machine-checkable pass/fail predicate). If it does **not** exist, the authoritative gate is
   the **Gate:** line under the current phase's heading in **`GLOBAL_PLAN.md`** — use it verbatim.
   The gates, restated, are:

   | Phase | Gate artifact / predicate |
   |---|---|
   | P0 | `SPEC.md` covers all four formats (`.mseg`/`.mnsw`/`.mpq` + multi-tenant) + query API + invariants; Document-control fields filled (Frozen=YES, Reviewed by, Freeze date) — **freeze is human-gated**. |
   | P1 | `bench/RESULTS.md` shows mneme brute-force int8 scan **beats Qdrant REST p50 at N=10k** on **real HIVEMIND memories** (synthetic does not count). Go/no-go for the whole project. |
   | P2 | `cargo test --all-features` 100% green + `cargo clippy -D warnings` clean + a `cargo bench` baseline recorded. |
   | P3 | recall@10 **with entity filter < 5 ms at 1M** memories, **< 3% quality loss** vs Qdrant float32. |
   | P4 | recall@10 **overlap > 96%** vs float32 ground truth (drift detector present; retrain enqueued, not inline). |
   | P5 | time-travel (`created_at`+`valid_from`) + 2-hop BFS returns correct memories across 1M slots **< 8 ms** (integration test). |
   | P6 | HIVEMIND eval-harness (14 golden cases) **≥ current Qdrant baseline**; **72h soak clean**; storage reduction measured (**> 5x**). |
   | P7 | paper submitted to arXiv; repo public with a reproducible benchmark. |

## 1. Run the verification — produce the artifact, capture the output

You verify at two levels. **Always** run the per-task level. Run the phase-gate level **only**
when this task is the last one in the phase (the `## CURRENT` task's artifact == the phase
ledger artifact, i.e. all units in the phase are done).

### 1a. Per-task gate (every iteration, before any "done")

Run, top to bottom, and **paste the real output** for each:

```
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features                     # 100% green; no un-justified #[ignore]
```

Plus, when the task or phase requires them (P2 onward / unsafe-touching / format work):

```
cargo bench                                   # records/updates the criterion baseline
critcmp base pr                               # bench-no-regression: fail if a gated p50 regresses > ~5% noise band
cargo +nightly fuzz run mseg_reader           # P2 & P5: format reader over arbitrary/corrupt bytes — no panic/UB
cargo +nightly miri test -p mseg-format        # P2 & P5: UB check on the mmap reader where feasible
```

The unit's specific assertion (recall@10, latency, PQ overlap %) is the artifact — its passing
output **is** the proof. A green `cargo test` line you actually ran replaces "e2e on the live
box" for this library; for 13 of 16 weeks there is no prod box, so the test/bench IS the live
truth. If a required tool is absent locally (e.g. `cargo +nightly`, `critcmp`, `gitleaks`), note
it and rely on the CI gate that runs it — but do **not** claim a check passed that you could not
run.

### 1b. Phase milestone gate (only when the phase's last unit is done)

- **P0:** confirm `SPEC.md` fully covers all four formats + the query API + the invariants and
  that `format.rs` constants (`FORMAT_VERSION`, offsets) byte-match the SPEC.md layout fixture
  (`spec_matches_code` test). The actual **freeze** (filling Frozen=YES / Reviewed by / Freeze
  date) is **human-gated** — do not self-freeze. If the spec is complete but unfrozen, the
  correct outcome is `[!]` human-stop, not `[x]`.
- **P1:** run the probe benchmark against Qdrant REST on real HIVEMIND memories at N=10k; write
  the measured p50s into `bench/RESULTS.md` with the git sha; the gate passes only if mneme's
  number is lower.
- **P3/P4/P5/P6:** run the phase's benchmark/eval harness and confirm the measured number meets
  the literal threshold above. **P6 additionally** is the one phase where heavyweight live
  verification returns: build the `napi` binding, swap `MnemeVectorStore` into
  `core/src/ingestion/indexer.js`, run the HIVEMIND eval-harness ≥ Qdrant baseline, and the 72h
  soak must be clean before the phase advances. Also re-confirm the kill-condition bench
  (`append_p99_under_concurrent_rebuild`) and the banned-call-edge check (append never reaches
  `rebuild_hnsw`/`retrain_codebook`) at P3/P4/P6.
- **P7:** confirm the arXiv submission artifact exists and the public repo benchmark reproduces.

Record every measured number into **`bench/RESULTS.md`** (or `BENCH.md` if your runner uses it)
with the git sha and the baseline it beat. Proof of progress must live **outside** context, in a
committed file — not in a claim.

## 2. On failure — fix and re-verify, never advance red

If any per-task check fails or the phase gate's number misses its threshold:

- Do **not** mark the task `[x]`, do **not** advance `STATE.json.phase`, do **not** push or open
  a PR. Advancing on red compounds silently across a 16-week run — it is the cardinal sin.
- Diagnose and fix the smallest thing that makes it green/meets the threshold, then re-run the
  exact same command and capture the new output. A phase-gate miss becomes a fresh narrowed unit
  in the work queue (the recovery path), not a fudged pass.
- Increment `STATE.json.consecutive_gate_failures`. If it reaches
  `max_consecutive_gate_failures`, stop spinning: set `STATE.json.blocked=true` with a precise
  `blocked_reason`, mark the task `[!]` (human-stop) in `loop/PROGRESS.md`, and exit. Likewise if
  `iter` hits `max_iter`, park to `[!]` rather than loop forever. A genuine spec ambiguity or a
  needed format change is always a human-stop, never a guess.

## 3. On success — record the artifact and advance the cursor honestly

Only after the artifact is proven by captured output:

- Update **`loop/PROGRESS.md`**: mark the task done in `## CURRENT` (or move to the next task),
  flip the phase's `## PHASE LEDGER` box to `[x]` **only** if the phase milestone gate (1b)
  actually passed, and prepend a `## HISTORY` line (date + artifact proven + the number + sha).
- Update **`loop/STATE.json`**: reset `consecutive_gate_failures` to 0; set `last_shipped_sha` to
  the verified commit; advance `iter`. Advance `phase` and bump `phases_done` **only** when 1b
  passed (and for P0, only after the human freeze — otherwise leave it for the human). Set
  `scope_frozen_at_spec=true` once SPEC.md is frozen.
- Record measured numbers in `bench/RESULTS.md` as above. Append any reusable finding to
  `NOTES.md` if present.
- The loop's only stable terminal state is `phase == P7` with the launch artifacts present
  (arXiv submission + public repo). There is no other "done" — do not invent a completion signal.

## Output

A verification report whose every "passing"/"done" claim is immediately preceded by the real
command and its captured stdout. State: the task, the artifact verified, the exact reproduce
command(s) and their output, whether the per-task gate passed, and — if this was the phase's last
unit — whether the phase milestone gate passed and the cursor advanced. If anything is red or a
number missed threshold, report the failure, what you fixed, the re-run result, and the resulting
`STATE.json` state (advanced, retrying, or `[!]` blocked). Never end with an unbacked success
claim.
