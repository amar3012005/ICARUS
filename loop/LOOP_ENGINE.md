# mneme — Loop Engine Specification

> The control machinery that drives an unattended Claude Code agent through the
> 16-week, eight-phase mneme build (P0..P7) on a dedicated vCPU, with no human in
> the turn loop, across hundreds of context compactions, and finishes the whole
> program without faking success or quitting mid-way.
>
> This document is **self-sufficient**. The agent reading it cannot ask questions.
> Every rule below names HOW it is enforced — a command, a state field, a gate, a
> hook — not just what the rule is.

This engine is **not new from scratch**. It is the existing HIVEMIND per-goal
Stop-hook loop (`/Users/amar/HIVE-MIND/.claude/loop/LOOP.md` — the five mechanisms:
Stop-hook keeps working, state outside context, verify-before-ship, idempotency,
cheap honest verification) reused **unchanged in shape** as the inner tier, wrapped
in a new outer phase-gate supervisor. Do not reinvent those five mechanisms. The
only additions are the outer phase DAG, milestone-artifact gates, the per-phase
decomposition pass, the de-sloppify pass, and the kill-condition self-review.

---

## 0. The one-paragraph mental model

mneme's loop is a **two-tier nested machine**. The OUTER tier walks a linear DAG of
eight phase nodes `P0..P7`; each phase advances **only** when its single
milestone **artifact** — a recorded number, benchmark, or binary that satisfies a
literal predicate in `loop/PHASE_GATES.md` — is committed to `bench/RESULTS.md`.
Progress is **measured, not declared.** The INNER tier is the existing per-goal
Stop-hook engine, retargeted for Rust greenfield: it grinds a dependency-ordered
queue of bounded work-units (in `loop/GOALS.md`) through
`recon → plan → implement(TDD) → cargo check/clippy → de-sloppify → self-review →
test+bench verify → one-commit ship → journal/memory → mark [x]`. When the last
unit in a phase is `[x]`, the supervisor runs the phase milestone gate; if it
passes it advances `STATE.json.phase`, if it fails it spawns a narrowed recovery
unit. The only stable terminal state is `phase == P7` with the P7 launch artifacts
present. There is no other exit and no time gate.

---

## 1. Why two tiers (and what each tier owns)

The existing feature loop is single-tier: a flat queue of small "reuse-existing"
features, each verified by a live e2e on the prod box. mneme cannot use that flat
loop directly for five reasons (see §9). The fix is to **nest** the proven loop
inside a phase supervisor.

| Tier | Unit of work | Cursor | Gate | Cadence |
|---|---|---|---|---|
| OUTER — Phase supervisor (new) | one phase `Pn` | `STATE.json.phase` + `PROGRESS.md` ledger | milestone **artifact** meets predicate in `PHASE_GATES.md`, recorded in `bench/RESULTS.md` | weeks |
| INNER — Per-unit engine (reused) | one work-unit | `loop/GOALS.md` top-to-bottom + `STATE.json.iter` | `cargo test` 100% green + required `cargo bench` number recorded | one commit |

The inner loop is a **subroutine** of the outer loop. The outer loop never writes
code; it decomposes, dispatches the inner loop, and runs the milestone gate.

---

## 2. The eight phases as a DAG (outer tier)

Phases are sequential by dependency: `P(n)` cannot open until `P(n-1)`'s gate
artifact is committed. The full predicate + proving command for each gate lives in
`loop/PHASE_GATES.md` — that file is authoritative; the table below is the map.

| Phase | Weeks | Single milestone artifact | Gate (summary — see PHASE_GATES.md for exact predicate) |
|---|---|---|---|
| **P0** | wk1 | frozen `SPEC.md` (all four formats + query API + invariants) | `Frozen: YES` + `FORMAT_VERSION` set + human reviewer filled; **no code exists yet** |
| **P1** | wk2 | `bench/RESULTS.md` latency number | brute-force int8 cosine scan **beats Qdrant REST p50** at N=10k on REAL HIVEMIND memories |
| **P2** | wk3–4 | production Rust crate | `cargo test --all-features` 100% green + `clippy -D warnings` clean + CRUD round-trips proven |
| **P3** | wk5–7 | `recall@10` benchmark | `recall@10 < 5ms` @ 1M memories AND `< 3%` quality loss vs Qdrant float32 (usearch HNSW overlay + entity-bitmap filter) |
| **P4** | wk8–9 | PQ overlap number | `recall@10 overlap > 96%` vs float32 (per-org PQ codebook) + drift detector present |
| **P5** | wk10 | time-travel benchmark | bi-temporal range + 2-hop adjacency BFS served from one mmap, `< 8ms` @ 1M |
| **P6** | wk11–12 | live integration result | napi binding swapped into `core/src/ingestion/indexer.js`; HIVEMIND eval-harness **≥ Qdrant baseline** + **72h soak clean** |
| **P7** | wk13–16 | launch artifacts | arXiv paper submitted + public GitHub repo + xMEM benchmark numbers |

`P6` is the **single phase** where the original loop's heavyweight "verify on the
live box" returns (real `indexer.js`, real HIVEMIND auth, eval-harness, 72h soak).
For P0..P5 there is **no prod box** — `cargo test` + `cargo bench` IS the live truth.

---

## 3. Phase decomposition (RFC → DAG) — runs once when a phase opens

When `STATE.json.phase` advances to a new `Pn`, the **first** thing the agent does is
a one-time decomposition pass (Ralphinho RFC→DAG, see
`everything-claude-code:ralphinho-rfc-pipeline`):

1. Read the frozen `SPEC.md` (the contract) and this phase's row in
   `loop/PHASE_GATES.md` (the artifact + predicate).
2. Emit **N bounded work-units** into `loop/GOALS.md` as the inner-loop queue. Each
   unit carries the full Ralphinho unit-spec:

   ```
   - [ ] <id>  (depends_on: <ids|none>, risk_tier: 1|2|3)
         scope: <one commit's worth, names files>
         acceptance_tests: <the #[test]/bench assertions that prove this unit>
         rollback_plan: <how to undo if it regresses a gate metric>
   ```

3. Order units by `depends_on`; the inner loop walks them top-to-bottom.
4. **Coverage check (the decomposition gate):** the union of all units'
   `acceptance_tests` must provably cover this phase's milestone artifact. If a unit
   references scope **outside** `SPEC.md`, it does not belong in `GOALS.md` — it goes
   to `FUTURE.md`. This is enforced mechanically by the `spec-lock` scope-manifest
   linter (see `PHASE_GATES.md`): a unit naming a top-level feature/module not in
   `SPEC.md`'s in-scope manifest fails the check.

`risk_tier` drives inner-loop depth:

- **Tier 1** (isolated file, no format/unsafe/perf): skip the heavy self-review;
  `cargo test` + clippy is enough.
- **Tier 2** (touches multiple modules or public API): full inner pipeline.
- **Tier 3** (byte format, `unsafe`, perf hot path, PQ math, HNSW overlay): max
  scrutiny — mandatory adversarial self-review, a criterion bench, and (for format
  units) `proptest` round-trips + Miri.

Decomposition converts an unmanageable multi-week phase into ~5–15 independently
verifiable commits the inner Stop-hook loop already knows how to grind.

---

## 4. Per-unit inner pipeline (the existing engine, retargeted for Rust)

Reuse the existing Stop-hook loop unchanged in shape. Only the verbs change for a
Rust/no-prod-box context. Each stage is a **gate**: the next stage never starts until
this one proves itself. The prompt files in `loop/prompts/` drive the agent at the
named stages.

```
 feature-recon       loop/prompts/recon.md
   │  Search crates.io / usearch / napi-rs / existing mneme modules FIRST
   │  (mandatory Research&Reuse). Read NOTES.md for prior findings/fixtures.
   │  GATE: a reuse decision is recorded in the commit body under RECON:
   │        (adopt crate X / port pattern Y / net-new because <reason>).
   ▼
 plan
   │  Restate this unit's acceptance_tests as the contract. Bound to one commit.
   │  GATE: written plan whose steps map 1:1 to acceptance_tests.
   ▼
 implement (TDD RED→GREEN)     loop/prompts/implement.md
   │  Write the failing #[test]/criterion bench FIRST. For format/PQ/HNSW units
   │  the failing test IS a numeric assertion (recall@10, latency, overlap%).
   │  GATE: RED proven (fails for the RIGHT reason) BEFORE code — RED is the
   │        per-unit equivalent of "deploy". Then write minimal code to GREEN.
   ▼
 compile / clippy              (cargo check + cargo clippy -D warnings)
   │  Rust's typo/type/lint killer — the equivalent of py_compile / tsc --noEmit.
   │  HARD GATE: zero errors, zero clippy warnings. Never advance on red.
   ▼
 de-sloppify (SEPARATE pass)   loop/prompts/review.md  (fresh agent context)
   │  Strip slop the greenfield Rust accreted: tests of language behaviour,
   │  over-defensive unwrap/expect, dead code, commented-out blocks, unused deps.
   │  "Two focused agents beat one constrained agent." Mandatory for greenfield.
   │  GATE: cleanup applied AND cargo test still green; real format-invariant
   │        and business tests retained.
   ▼
 self-review (adversarial)     loop/prompts/review.md
   │  Read borrow/lifetime soundness, EVERY unsafe block (// SAFETY: proof), and
   │  the TWO engineered kill-conditions (§6). Tier-3 units get a written note.
   │  GATE: no unjustified unsafe; kill-condition invariants hold for any unit
   │        touching the index or PQ.
   ▼
 verify (test + bench)         loop/prompts/verify.md
   │  cargo test --all-features 100% green + cargo bench records this unit's
   │  number into bench/RESULTS.md. For a library the test+bench IS live truth.
   │  HARD GATE before commit. (P6 ONLY: also deploy napi into HIVEMIND core +
   │  eval-harness ≥ Qdrant baseline + 72h soak clean.)
   ▼
 ship (ONE unit = ONE commit)
   │  Greenfield → commit straight to the working branch (no docker-cp / prod box
   │  until P6). Idempotent: skip if last_shipped_sha already covers this unit.
   ▼
 journal + memory
   │  Append a line to bench/RESULTS.md history + write HIVEMIND memory
   │  (hivemind_ingest_code on touched files, hivemind_log_decision on choices).
   │  Append "what worked / what failed / reusable fixtures" to NOTES.md.
   ▼
 mark [x] → next unit
      The ORCHESTRATOR (run-loop.sh `mark_unit_done`) flips the exact line
      `[ ]`/`[~]`→`[x]` via sed — the AGENT never edits checkboxes (an agent that
      marks its own work done is the #1 livelock source). The mark happens ONLY
      after verify+ship proven. STATE.json.iter is reset ONLY when the open-unit
      queue actually shrank this iteration; if the same unit is still first-open
      after a "successful" pass, that is a no-progress event → consecutive_no_progress++
      (parks at max_consecutive_no_progress). Pick the next [ ] by dependency order.
```

When the **last** unit in a phase is `[x]`, the outer supervisor runs the **phase
milestone gate** (§2 / `PHASE_GATES.md`). Pass → advance `STATE.json.phase`,
flip the phase row in `PROGRESS.md` to `[x]`, write the artifact number to
`bench/RESULTS.md` with its git sha. Fail → §7 recovery.

---

## 5. Data flow between stages (what each artifact carries)

```
SPEC.md (frozen, P0)
   │ decomposition reads it
   ▼
PHASE_GATES.md (per-phase predicate + proving command)
   │ decomposition reads the active phase's row
   ▼
GOALS.md  ◄──── decomposition writes N units; Stop-hook re-injects active unit
   │ inner loop walks units top-to-bottom
   ▼
[recon]→ NOTES.md (read prior findings) ─────────────┐
[implement]→ source files + tests                    │ NOTES.md appended at unit end
[verify]→ bench/RESULTS.md (the number + sha)         │ (what worked/failed/fixtures)
[ship]→ git commit; STATE.json.last_shipped_sha       │
[memory]→ HIVEMIND ingest_code/log_decision ◄─────────┘
   │ last unit [x]
   ▼
PHASE MILESTONE GATE ── pass ──► STATE.json.phase++ ; PROGRESS.md ledger [x]
                     └─ fail ──► narrowed recovery unit appended to GOALS.md
```

The flat `.md` files survive context compaction; HIVEMIND memory gives queryable
graph context across the 16 weeks. A fresh post-compaction session rehydrates
entirely from `STATE.json` (where am I) + `PROGRESS.md` (phase ledger) +
`GOALS.md` (active queue) + `NOTES.md` (what's been tried) + git log (what shipped)
+ `bench/RESULTS.md` (proven numbers) — it never re-derives.

---

## 6. The two engineered KILL CONDITIONS (first-class review criteria)

These are the two ways mneme dies at scale. They are **checked architecture
invariants**, not afterthoughts. Any unit touching the index or PQ must satisfy them
in the self-review stage and at the relevant phase gate.

1. **HNSW rebuild-on-write bottleneck.** The append/write path
   (`mseg::append`) MUST be physically separate from the async index-rebuild path.
   HNSW index rebuild may **never** be triggered synchronously inside an append.
   - Enforced by a **banned-call-edge check**: a script over the append module fails
     the build if the symbols `rebuild_hnsw` / `retrain_codebook` are reachable from
     `append` (grep/call-graph).
   - Enforced by a criterion bench `append_p99_under_concurrent_rebuild`: p99 append
     latency must not regress while a background rebuild is in flight.
   - Reuse `usearch` for HNSW (do not hand-roll); keep mneme's append `.mseg`
     write-path separate from the async usearch index build.

2. **PQ centroid drift.** The PQ codebook is **read-only on the hot path**. Centroid
   drift is detected and a retrain is **enqueued**, never run inline.
   - Enforced by a unit test that feeds a drifted vector distribution and asserts the
     detector flags retrain AND that recall is still served from the existing codebook
     meanwhile (no inline retrain).

---

## 7. Anti-stall / forward-progress guarantee (survives a 16-week unattended run)

Five layered mechanisms. Together they make the only stable terminal state
`phase == P7` with launch artifacts present. The agent **cannot** silently quit,
spin forever, or fake completion.

1. **Stop-hook (reused, at BOTH tiers).** The turn cannot end while ANY `[ ]`/`[~]`
   unit exists in `loop/GOALS.md` OR `STATE.json.phase != P7`. Resting state = "keep
   working." Wired via the goal-loop Stop hook in `settings.json` (the same mechanism
   as `.claude/hooks/goal-loop-stop.py`).

2. **Three independent runaway caps + a no-op guard.** (Any one tripping parks the run.)
   - Inner: `max_iter` (default 80) — autofix attempts without a unit completing;
     resets ONLY on a real `[x]` (a queue that actually shrank), never on a bare pass.
   - Gate: `consecutive_gate_failures` vs `max_consecutive_gate_failures` (default 5)
     — a phase milestone gate failing repeatedly.
   - **No-progress: `consecutive_no_progress` vs `max_consecutive_no_progress`
     (default 3)** — a "successful" iteration that did NOT shrink the open-unit queue
     (the same unit is still first-open). This is the cap that catches the classic
     livelock the inner cap misses, because the orchestrator (not the agent) owns the
     `[x]` mark and measures the queue before/after.
   - No-op: `noop_turns` vs `max_noop_turns` (default 3) — an agent turn that was
     REQUIRED to mutate a file (decomposition, recovery unit) but changed nothing.
   - Hitting any parks: `blocked=true` + `blocked_reason`, stop for a human (exit 2).
     It never silently spins.

   **Human gates are distinct from caps.** A step that needs a human signature
   (P0 spec freeze; optionally P6 go-live, P7 launch) calls `await_human` (exit 3):
   it sets `STATE.json.awaiting_human` and stops WITHOUT consuming any failure cap,
   and the gate script additionally requires a human-only `loop/APPROVALS/<token>`
   file plus a non-loop commit author — so the agent cannot self-clear it.

3. **SHARED cross-iteration notes** (`loop/NOTES.md`, continuous-claude
   `SHARED_TASK_NOTES.md` pattern). Every unit **reads it at start, writes it at end**:
   "what works, what's tried, reusable test fixtures, kill-condition status." This is
   what lets a fresh post-compaction session rehydrate instead of re-deriving — it is
   the single most important survival mechanism over 16 weeks.

4. **Idempotency + dedup.** Re-running a unit is safe. `STATE.json.last_shipped_sha`
   prevents a double-commit. Cargo is declarative, so a rebuild is free. Deploys
   (P6 only) are restart-based, never append-based external sends.

5. **Mechanically frozen scope.** Any new idea generated mid-run goes to `FUTURE.md`,
   **never** into `loop/GOALS.md`. The per-phase queue can therefore only **shrink**,
   which mathematically guarantees the phase terminates. Genuine spec ambiguity that
   only a human can resolve → `[!]` human-stop (the honest caveat). Scope freeze is
   enforced by the `spec-lock` check (`PHASE_GATES.md`): a PR adding a top-level
   feature/module not in `SPEC.md`'s in-scope manifest fails.

**Completion signal (structural, not a magic phrase):** the program is done when
`STATE.json.phase == "P7"` AND the P7 launch artifacts exist (arXiv submission id +
public repo URL recorded in `bench/RESULTS.md`). The Stop-hook keeps the agent
working until exactly that state. There is no "/stop", no human "looks done", no
time limit — only the artifact.

---

## 8. State files (the durable memory outside context)

| File | Tier | Purpose | Survives compaction by |
|---|---|---|---|
| `SPEC.md` | outer | Frozen P0 byte-format RFC: slot layout, field offsets, `FORMAT_VERSION`, all gate thresholds. Single source of truth for decomposition. | being the contract; locked by `spec-lock` |
| `loop/PHASE_GATES.md` | outer | The literal pass/fail predicate + proving command for each of P0..P7. No phase advances until its gate command exits 0. | being machine-checkable |
| `PROGRESS.md` | outer | Phase ledger `[ ]/[~]/[x]` + the current cursor block (phase, task, blocked-on, next artifact). Week-scale analog of GOALS.md. | read first by a fresh session |
| `FUTURE.md` | outer | Scope-freeze sink. Every new idea goes here, NEVER into GOALS.md. Guarantees the per-phase queue only shrinks. | mechanical scope enforcement |
| `loop/GOALS.md` | inner | The CURRENT phase's decomposed work-units with Ralphinho unit-specs. Worked top-to-bottom; Stop-hook re-injects the active unit. | being the inner cursor |
| `STATE.json` | both | Runaway + dedup state. Inner `{iter, max_iter, last_shipped_sha}` PLUS outer `{phase, task, phases_done, scope_frozen_at_spec, consecutive_gate_failures, max_consecutive_gate_failures, blocked, blocked_reason}`. | the two caps are the backstop |
| `bench/RESULTS.md` | both | Durable record of every measured number (per-unit benches + each phase artifact) with git sha + the Qdrant baseline it beat. Makes gates honest. | proof lives outside context |
| `loop/NOTES.md` | both | Cross-iteration shared memory. Read-at-start / write-at-end of every unit. | the rehydration mechanism |
| git (one unit = one commit) | both | The durable, idempotent build history. `last_shipped_sha` dedup. Greenfield → commit to working branch (no prod box until P6). | git log survives any context loss |
| HIVEMIND memory | both | Queryable long-term store via `hivemind_ingest_code`/`log_decision`/`track_refactor`/`test_coverage` + a session-trail master-index per phase. | graph context across 16 weeks |
| `loop/PAUSE` | both | Manual kill-switch. `touch loop/PAUSE` halts at the next Stop-hook check; `rm loop/PAUSE` resumes. | n/a (human control) |

`STATE.json` canonical shape (the orchestrator reads/writes these exact keys —
see `loop/run-loop.sh`):

```json
{
  "project": "mneme",
  "phase": "P0",
  "task": "author-and-freeze-spec",
  "iter": 0,
  "max_iter": 80,
  "phases_done": 0,
  "last_shipped_sha": null,
  "scope_frozen_at_spec": false,
  "consecutive_gate_failures": 0,
  "max_consecutive_gate_failures": 5,
  "blocked": false,
  "blocked_reason": null
}
```

---

## 9. How this differs from the existing feature loop (five axes)

1. **Gate semantics.** Feature loop: gate = "feature shipped + live e2e green on the
   prod box" — a binary event. mneme: gate = a milestone **artifact** — a recorded
   number/benchmark/binary meeting a threshold, written to `bench/RESULTS.md` with
   the sha. Progress is measured, not declared.

2. **Nesting.** Feature loop is single-tier. mneme is two-tier: an outer phase DAG
   (P0..P7, weeks) wrapping the inner per-unit engine (commits). A phase is first
   DECOMPOSED into a fresh `GOALS.md` queue, then the existing loop grinds it. The
   existing loop becomes a subroutine.

3. **Scope direction.** Feature loop: humans append goals freely; the queue grows.
   mneme: scope is FROZEN at P0; the per-phase queue can only SHRINK; new ideas are
   forced to `FUTURE.md`. This is what guarantees termination.

4. **What "verify on the live box" means.** Feature loop verifies against running
   prod HIVEMIND every goal. mneme is a library with NO prod box for 13 of 16 weeks
   — "live truth" = `cargo test` 100% green + `cargo bench` number. The heavyweight
   live-box / eval / 72h-soak verification returns at exactly ONE phase: P6.

5. **New stages.** mneme adds (a) a one-time RFC→DAG decomposition at each phase
   start; (b) a mandatory de-sloppify pass in a separate agent context (greenfield
   Rust accretes slop where reuse-existing features did not); (c) an explicit
   adversarial self-review for the two kill-conditions (§6).

---

## 10. The agent's bootstrap on every fresh session (do this FIRST)

A compaction or a vCPU restart drops the agent into an empty context. Recover the
thread in this exact order before doing anything else:

1. `cat loop/STATE.json` — where am I (`phase`, `task`, `blocked`, `awaiting_human`, `iter`).
2. If `blocked == true`: STOP. A human must clear `blocked_reason`. Do not proceed.
   If `awaiting_human != null`: STOP. A human must satisfy that gate (see `loop/APPROVALS/README.md`).
3. `cat loop/PROGRESS.md` — the phase ledger + current cursor block (this is the file
   the orchestrator stamps; there is no root-level PROGRESS.md).
4. `cat loop/GOALS.md` — the active phase's unit queue; the first `[ ]`/`[~]` is the
   resume point.
5. `cat loop/NOTES.md` — what's already been tried; reusable fixtures.
6. `git log --oneline -20` — what actually shipped (ground truth over any claim).
7. `hivemind_recall({ tags: ["mneme", "session-progress"], mode: "insight" })` — the
   structured long-term context.
8. Resume the inner pipeline (§4) at the first unfinished unit. **Never restart the
   phase; never re-decompose a phase already decomposed (GOALS.md is non-empty).**
