# STAGE 1 — RECON (read-and-decide; write zero code)

You are a Claude Code agent running unattended on a dedicated vCPU, building **mneme** — a
purpose-built memory filesystem for AI agents (Rust core, Apache-2.0, `napi-rs` Node bindings
to replace Qdrant inside HIVEMIND). This is the **recon stage** of a four-stage loop
(recon → implement → review → verify). Your only job here is to decide the cheapest correct
way to do the current task and to forbid any net-new code that a maintained crate already
covers. **You MUST NOT write, edit, or stage any source file in this stage.** Output a verdict
and stop.

The repo root is `/Users/amar/HIVE-MIND/mneme`. All paths below are relative to it.

## 0. Orient — read these first, in this order (do not skip)

A fresh context starts every loop iteration. These files are your entire memory. Read them
before doing anything else:

1. **`loop/STATE.json`** — the machine cursor. The fields that decide your behavior:
   `phase` (P0–P7), `task` (the slug you are working), `iter`/`max_iter` (runaway cap),
   `scope_frozen_at_spec` (true once SPEC.md is frozen — see §3), `last_shipped_sha`,
   `consecutive_gate_failures`, `blocked`. If `blocked` is `true`, do not proceed — emit
   `RECON VERDICT: BLOCKED` echoing `blocked_reason` and stop.
2. **`loop/PROGRESS.md`** — the human-readable cursor. The `## CURRENT` block names the exact
   task, its status, and the next verifiable artifact. The `## PHASE LEDGER` table is the
   per-phase gate artifacts. The `## HISTORY` log (newest at top) is what already happened —
   read enough of it to not re-derive solved problems.
3. **`SPEC.md`** — the frozen `.mseg` / `.mnsw` / `.mpq` byte-layout RFC and query API. This is
   the contract. The slot header is fixed (`id u32`, `flags u16`, `created_at i64`,
   `valid_from i64`, `text_ptr u32`, `vector_pq [u8;128]`, `entity_bitmap u64`,
   `adjacency [u32;8]` ≈ 194 B) plus an LZ4 text region. The current task must stay inside what
   SPEC.md defines.
4. **`GLOBAL_PLAN.md`** — the 16-week phase program (P0–P7), the thesis, the targets table, and
   the **kill conditions** you must engineer against (HNSW rebuild-on-write bottleneck; PQ
   centroid drift). The per-phase gate is stated here in the `## Phases` section.
5. **`loop/PHASE_GATES.md`** if it exists — the machine-checkable exit predicate for each phase.
   If it does **not** yet exist, the authoritative gate for the current phase is the **Gate:**
   line under that phase's heading in `GLOBAL_PLAN.md`; use that.
6. **`INSTRUCTIONS.md`** and **`NOTES.md`** if they exist — `INSTRUCTIONS.md` is the standing
   operating contract; `NOTES.md` is cross-iteration shared memory ("what worked, what failed,
   reusable test fixtures"). If `NOTES.md` exists, reading it is mandatory — it prevents you
   re-deriving a dead end a prior iteration already burned. If either is absent, proceed without
   it; do not create it in this stage.
7. **`reference/OPENSOURCE_RECON.md`** — the pre-vetted crate-reuse decisions. This is your
   primary reuse oracle and it is binding (see §2).

## 1. Find what already exists in-repo (cheaper than searching the world)

Before searching crates.io, prove the capability is not already in the repo. Run, in order:

- `git -C /Users/amar/HIVE-MIND/mneme log --oneline -15` — recent commits, to see what the last
  iterations shipped.
- Semantic/structural search of the existing Rust crate: prefer the **code-review-graph** MCP
  tools (`semantic_search_nodes`, `query_graph`) over raw grep for finding a function/struct by
  intent — they are faster and give callers/dependents. Fall back to
  `rg -n '<symbol-or-keyword>' crate/ bench/` only when the graph does not cover it.
- `rg --files crate/src` and read any module whose name matches the task. The single
  source-of-truth rule is **hard**: slot-layout constants (`SLOT_BYTES`, field offsets),
  `int8`/PQ cosine, the `entity_bitmap` AND, and mmap accessors must each live in exactly one
  place. If the task is "add behavior X" and a module already owns the adjacent logic, the
  cheapest path is to extend it, not to add a parallel implementation. Re-implementing
  something that exists is a DRY violation the review stage (`similarity-rs --threshold 0.85`)
  will reject — catch it here.

## 2. Find an existing crate before writing any net-new code (the prime directive)

mneme's innovation budget is the **`.mseg` byte layout, the entity-bitmap AND filter, and the
per-org PQ codebook + drift detection — those three only**. Everything else is bought, not
built. Consult `reference/OPENSOURCE_RECON.md` first; its decisions are binding. The
non-negotiable reuse targets:

| Need | Use this crate — do NOT hand-roll | Notes |
|---|---|---|
| HNSW graph index (P3) | **`usearch`** (Apache-2.0) | Gives HNSW + int8 scalar quant + mmap `view()` + filter-during-traversal. Hand-rolling HNSW is forbidden. A `*hnsw*`-named file under `crate/src/` that is more than a thin (<150 LOC) wrapper over usearch fails CI. |
| mmap the `.mseg` file | **`memmap2`** | Wrap behind one thin safe owner that controls file lifecycle. |
| Cast the fixed slot header off bytes | **`zerocopy`** (`FromBytes`+`KnownLayout`) | Preferred over `rkyv` for a fixed layout mneme controls. |
| Compress the per-slot text blob | **`lz4_flex`** (pure Rust) | Not a custom codec; not the C `lz4` crate (keep the build pure-Rust for clean napi cross-builds). |
| Node bindings (P6) | **`napi-rs` v3** (async/Promise) | No `node-gyp`, no hand-rolled FFI. |
| Parallel scan / k-means / BFS fan-out | **`rayon`** | |
| Gate benchmarks | **`criterion`** | Every phase gate is a number it produces. |
| Format property/fuzz tests | **`proptest`** | Round-trip, bitmap-AND, temporal-range invariants. |
| PQ math (P4) | **BUILD** it (port from faiss `ProductQuantizer.h` + paper 2401.08281; evaluate pure-Rust `vq` crate as a head-start). usearch does scalar i8 quant, **not** product quantization. | The per-org codebook + drift detect is novel mneme work. |

If the current task maps to a row above, the verdict's reuse decision is fixed — name that
crate. `AVOID` outright: `arroy`/`hannoy` (bundle LMDB storage, collide with `.mseg`). Treat
`faiss`, `lance`, `qdrant` internals, `tantivy`, `rkyv`, `zstd`, `hnswlib`, `instant-distance`
as **reference-only** — study the math/patterns, never take them as a runtime dependency.

For any task not covered by `OPENSOURCE_RECON.md`, do live recon: `cargo search <keyword>`,
and a web/GitHub search for an Apache-2.0/MIT/BSD crate that already does it. License must be
permissive (no GPL/AGPL). Record the search you ran so the implement stage can put a `RECON:`
block in the commit body — the CI `recon-check` gate **fails the merge** if a new source file
over 30 LOC lands without a `RECON:` block citing a crates.io/GitHub result or an explicit
`RECON: no-reuse-found because <reason>`.

## 3. Enforce the scope freeze (mechanical, not optional)

If `STATE.json.scope_frozen_at_spec` is `true`, SPEC.md is frozen and scope is locked. Any task
or sub-idea that is **not** expressible within SPEC.md's defined formats/API is out of scope:
it does not become code and it does not become a new task — it goes to `FUTURE.md` (append a
one-line entry; create the file only if needed). The per-phase work queue can only **shrink**.
If you discover the current task itself requires changing a slot offset, field semantic, or
`FORMAT_VERSION`, that is a spec revision requiring a human — emit
`RECON VERDICT: BLOCKED — needs SPEC.md revision` and stop; do not improvise a format change.
Genuine spec ambiguity is also a human-stop, not a guess.

If the current phase is **P0** and SPEC.md is still `DRAFT`/not frozen, the task is to complete
and freeze the spec itself — there is no crate to reuse for a design document; the verdict is
`GAP` with the cheapest path being "fill the remaining `TODO (P0)` sections of SPEC.md per
GLOBAL_PLAN.md, then freeze." No implementation code is permitted while SPEC.md is unfrozen.

## 4. Output — the RECON VERDICT (the only thing you produce)

Emit exactly this block and nothing that touches a file:

```
RECON VERDICT
  task:        <the STATE.json task slug>
  phase:       <P0..P7>
  classification: EXISTS | PARTIAL | GAP | BLOCKED
  in-repo:     <module/path that already covers this, or "none">
  reuse:       <crate to adopt + version, or "BUILD: <why no reuse path exists>">
  cheapest path: <≤5 numbered steps the implement stage will follow, scoped to ONE commit>
  acceptance:  <the test(s)/number that will prove this task done — restated from the gate>
  kill-condition watch: <which of the two kill conditions this task can violate, or "none">
  scope:       in-SPEC | OUT-OF-SCOPE→FUTURE.md
```

- `EXISTS` = fully covered in-repo or by a single crate call; implement stage just wires it.
- `PARTIAL` = a crate/module covers most; name the thin glue to build.
- `GAP` = genuine net-new (must be one of the three mneme-IP areas, or a justified exception).
- `BLOCKED` = needs a human (spec revision, true ambiguity, or `STATE.json.blocked`).

Keep the verdict tight and concrete. Name commands, crates, and file paths — not intentions.
**Do not write code. Do not edit PROGRESS.md or STATE.json in this stage.** The next stage
(`implement`) consumes this verdict.
