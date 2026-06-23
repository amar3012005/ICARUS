# mneme — Phase Exit Gates

> The exact, machine-checkable exit gate for each of P0..P7. Each phase produces
> **ONE verifiable artifact** (a number, a file, a benchmark, a binary). A phase
> does not advance until its gate command **exits 0**. There are no time gates.
>
> This file is read by two consumers:
> 1. The agent, at phase-decomposition time, to know what the active phase must prove.
> 2. `loop/run-loop.sh`, which `grep`s the `GATE_CMD[Pn]:` lines below and runs the
>    command verbatim. Exit 0 → advance `STATE.json.phase`. Non-zero → recovery unit.
>
> **Contract for `GATE_CMD` lines:** each is a single shell command (pipes/`&&`
> allowed) that returns exit 0 **iff** the artifact satisfies the predicate, and
> non-zero otherwise. It must be deterministic and self-contained (it may read
> `bench/RESULTS.md`, run `cargo`, or invoke a checked-in harness script). It must
> NOT depend on agent prose. Keep the literal command on ONE line so the grep
> extracts it whole.

---

## Gate table

| Phase | Single artifact | Exact pass condition | Proving command (exit 0 = pass) |
|---|---|---|---|
| **P0** | frozen `SPEC.md` | `Frozen: YES`, `FORMAT_VERSION` set, human reviewer filled, human-only `loop/APPROVALS/p0.freeze` present, freeze commit NOT authored by the loop identity, AND no `crate/**/*.rs` exists yet (spec-before-code) | `bash loop/gates/p0_spec_frozen.sh` |
| **P1** | `bench/RESULTS.md` latency row | brute-force int8 cosine scan p50 **< Qdrant REST p50** at N=10k on REAL HIVEMIND memories | `cargo bench --bench scan_vs_qdrant && bash loop/gates/p1_beats_qdrant.sh` |
| **P2** | production crate | `cargo test --all-features` 100% green, `clippy -D warnings` clean, `fmt --check` clean, coverage ≥ 80% | `cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test --all-features && cargo llvm-cov --fail-under-lines 80` |
| **P3** | `recall@10` benchmark | `recall@10 < 5ms` @ 1M AND quality loss **< 3%** vs Qdrant float32; usearch HNSW overlay; entity-bitmap O(1) filter; write-path isolated | `cargo bench --bench recall_1m && bash loop/gates/p3_recall_latency.sh && bash loop/gates/writepath_isolation.sh` |
| **P4** | PQ overlap number | `recall@10 overlap > 96%` vs float32 (per-org PQ codebook) AND drift detector enqueues retrain (never inline) | `cargo test pq_drift_detect && cargo bench --bench pq_overlap && bash loop/gates/p4_pq_overlap.sh` |
| **P5** | time-travel benchmark | bi-temporal (`created_at`+`valid_from`) range + 2-hop adjacency BFS served from ONE mmap, p50 `< 8ms` @ 1M; format fuzz clean | `cargo bench --bench bitemporal_2hop && bash loop/gates/p5_timetravel.sh && cargo +nightly miri test -p mseg-format` |
| **P6** | live integration result | napi binding swapped into `core/src/ingestion/indexer.js`; HIVEMIND eval-harness **≥ Qdrant baseline**; 72h soak clean (no crash/leak/latency-regression) | `bash loop/gates/p6_eval_ge_baseline.sh && bash loop/gates/p6_soak_72h.sh` |
| **P7** | launch artifacts | arXiv submission id recorded AND public GitHub repo URL recorded AND xMEM benchmark numbers in `bench/RESULTS.md` | `bash loop/gates/p7_launch_artifacts.sh` |

---

## Machine-readable gate commands (consumed by run-loop.sh)

> `run-loop.sh` runs `GATE_CMD[<phase>]` and advances only on exit 0. These ARE the
> gates — the table above is human-readable; these lines are the source of truth the
> orchestrator parses. One command per line, prefixed `GATE_CMD[Pn]:`.

```
GATE_CMD[P0]: bash loop/gates/p0_spec_frozen.sh
GATE_CMD[P1]: cargo bench --bench scan_vs_qdrant && bash loop/gates/p1_beats_qdrant.sh
GATE_CMD[P2]: cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test --all-features && cargo llvm-cov --fail-under-lines 80
GATE_CMD[P3]: cargo bench --bench recall_1m && bash loop/gates/p3_recall_latency.sh && bash loop/gates/writepath_isolation.sh
GATE_CMD[P4]: cargo test pq_drift_detect && cargo bench --bench pq_overlap && bash loop/gates/p4_pq_overlap.sh
GATE_CMD[P5]: cargo bench --bench bitemporal_2hop && bash loop/gates/p5_timetravel.sh && cargo +nightly miri test -p mseg-format
GATE_CMD[P6]: bash loop/gates/p6_eval_ge_baseline.sh && bash loop/gates/p6_soak_72h.sh
GATE_CMD[P7]: bash loop/gates/p7_launch_artifacts.sh
```

---

## What each gate command checks (the helper scripts under `loop/gates/`)

**These scripts are CHECKED IN as fixtures (not agent-authored).** A gate the agent
could rewrite is a self-graded exam — so the orchestrator forbids modifying any
`loop/gates/*.sh` in the same commit as `crate/` code (`gate_no_exam_tampering`).
Each script sources `loop/gates/_lib.sh` (single source of truth for number
extraction + comparison), reads its number from `bench/RESULTS.md`, and `exit 0`
iff the predicate holds. A **missing** number is always a fail, never a pass.

- **`p0_spec_frozen.sh`** — SPEC `Frozen: YES` + `FORMAT_VERSION` + reviewer filled;
  human-only `loop/APPROVALS/p0.freeze` present; the freeze commit's author is NOT
  the loop identity (`amarsai3012005@…`); and `find crate -name '*.rs'` is empty
  (spec-before-code). The agent cannot self-freeze.
- **`p1_beats_qdrant.sh`** — asserts `mneme_scan_p50_ms < qdrant_rest_p50_ms` (N=10k, real memories).
- **`p3_recall_latency.sh`** — asserts `recall10_p50_ms < 5.0` AND `recall10_quality_loss_pct < 3.0`.
- **`writepath_isolation.sh`** (kill-cond #1) — locates the append module under
  `crate/` (fails closed if absent), fails if it references `rebuild_hnsw`/`retrain_codebook`,
  and requires the `append_p99_under_concurrent_rebuild=` bench number to exist.
- **`p4_pq_overlap.sh`** — asserts `pq_recall10_overlap_pct > 96.0`.
- **`p5_timetravel.sh`** — asserts `bitemporal_2hop_p50_ms < 8.0`.
- **`p6_eval_ge_baseline.sh`** — asserts `mneme_eval_score >= qdrant_eval_score`.
- **`p6_soak_72h.sh`** — asserts `soak_hours_completed > 71.9`, `soak_crashes == 0`,
  `soak_rss_growth_pct < 5.0`, `soak_recall_p99_ms < 5.0` (a soak still running fails).
- **`p7_launch_artifacts.sh`** — asserts a well-formed `arxiv_submission_id=`, an
  `https://github.com/...` `public_repo_url=`, and `xmem_*` numbers. This is also the
  orchestrator's terminal-exit check (one source of truth for "done").

### `p4_pq_overlap.sh` — P4
Reads `pq_recall10_overlap_pct` (the `pq_overlap` bench) from `bench/RESULTS.md`;
asserts `> 96.0`. Separately, `cargo test pq_drift_detect` (already in the
`GATE_CMD[P4]` chain) proves the drift detector flags retrain on a drifted
distribution AND that recall is still served from the existing codebook meanwhile
(no inline retrain — kill-condition #2).

### `p5_timetravel.sh` — P5
Reads `bitemporal_2hop_p50_ms` (the `bitemporal_2hop` bench at 1M) from
`bench/RESULTS.md`; asserts `< 8.0`. The Miri run in the `GATE_CMD[P5]` chain proves
the mmap reader is free of undefined behavior over the bi-temporal + adjacency reads.

### `p6_eval_ge_baseline.sh` — P6
Runs the HIVEMIND eval-harness against the mneme-backed `indexer.js` and against the
recorded Qdrant baseline; asserts `mneme_eval_score >= qdrant_eval_score` (written to
`bench/RESULTS.md`). This is the one phase where verification is on the live box with
real HIVEMIND auth, not just cargo.

### `p6_soak_72h.sh` — P6
Asserts a completed 72h soak: reads the soak ledger and fails unless the soak ran a
full 72h with zero crashes, no RSS growth beyond the leak threshold, and p99 recall
latency never breached the 5ms gate during the window. A soak still in progress is a
fail (the gate is "soak clean", not "soak started").

### `p7_launch_artifacts.sh` — P7
Asserts all three launch artifacts are recorded in `bench/RESULTS.md`: an
`arxiv_submission_id=`, a `public_repo_url=`, and the xMEM benchmark numbers
(`xmem_*`). This is the structural completion signal `run-loop.sh` also checks for
the terminal exit.

---

## Always-on per-commit gates (not phase gates, but every unit must pass them)

These run on every work-unit's verify stage (inside `run-loop.sh` → `run_inner_gates`),
independent of phase. A unit cannot be marked `[x]` until they are green. They
implement the production-grounding ruleset.

| Gate | Command | Enforces |
|---|---|---|
| fmt | `cargo fmt --all -- --check` | deterministic formatting |
| lint | `cargo clippy --all-targets --all-features -- -D warnings` | warnings = errors; dead-code/unused lints hard-fail |
| test | `cargo test --all-features` | 100% green, no un-justified `#[ignore]` |
| coverage | `cargo llvm-cov --fail-under-lines 80` | ≥ 80% line coverage |
| unused-deps | `cargo machete` | no unused Cargo deps (supply-chain + binary bloat) |
| dup | `similarity-rs --threshold 0.85 crate/` | no AST-normalized near-duplicate functions (DRY) |
| memory-safety | `grep -rL 'forbid(unsafe_code)' crate/ --include='*.rs'` matches only the one sanctioned mmap module | `unsafe` confined + every block carries `// SAFETY:` |
| no-debug-noise | `! grep -rnE 'println!|eprintln!|dbg!' crate/ --include='*.rs' \| grep -v 'cfg(test)'` | structured `tracing` only; no debug prints in committed code |
| recon-block | commit body contains a `RECON:` block (from `loop/.recon-current.md`) citing a crates.io/GitHub search or `no-reuse-found because <reason>` | reuse > rebuild (usearch for HNSW, napi-rs for bindings — never hand-rolled) |
| no-exam-tampering | no `loop/gates/*.sh` modified in the same commit as `crate/` code | a gate you can edit during the test is not a gate |
| spec-lock | `spec_matches_code` test: `format.rs` `FORMAT_VERSION` + offsets byte-match the `SPEC.md` fixture | frozen format / scope; offset drift = corruption |
| bugfix-has-test | a `fix:` commit must touch a test file in the same diff; regression test proven RED on parent commit | every bug fix carries a regression test |
| secret-scan | `gitleaks detect --no-git --redact` (CI-installed) | no committed secrets |

> Phase-specific extras layer on top: `fuzz-format` (`cargo +nightly fuzz run mseg_reader`
> + Miri) at P2 and P5; `writepath_isolation.sh` + `append_p99_under_concurrent_rebuild`
> bench at P3/P4/P6; `bench-no-regression` (`critcmp base pr`, fail on >5% p50 regression
> of any gated bench) on every PR and at every phase gate.
