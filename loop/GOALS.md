# mneme — GOALS (work-unit queue)

> The loop's queue + cursor. One open unit at a time, top-to-bottom.
> Checkbox states: `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked.
>
> **The orchestrator (`run-loop.sh`) owns the checkboxes.** The agent must NOT
> flip `[ ]`→`[x]` — the script does that, and only after a machine gate proves
> the unit. Each unit is a checkbox line followed by an indented spec block.
> Out-of-SPEC ideas go to `FUTURE.md`, never here.

## Phase P0 — Spec first (gate: frozen SPEC.md, no code yet)

- [x] p0-1: SPEC §1 — fully specify `.mseg` slot header + variable region
      depends_on: none
      acceptance: every field has exact type/size/offset/endianness; variable LZ4 region addressing defined; file header (magic, version, dim, count, free-list) defined
      risk_tier: medium
      rollback: revert SPEC.md §1 to skeleton

- [x] p0-2: SPEC §2 — `.mnsw` HNSW index format (map usearch on-disk index to slot ids)
      depends_on: p0-1
      acceptance: names the reused crate (usearch) per reference/OPENSOURCE_RECON.md; specifies key→slot-id mapping + co-location/mmap strategy; NO bespoke HNSW design
      risk_tier: low
      rollback: revert §2

- [x] p0-3: SPEC §3 — `.mpq` PQ codebook format
      depends_on: p0-1
      acceptance: M subspaces, K centroids, training trigger (first 10k), drift alignment score, on-disk layout all specified
      risk_tier: medium
      rollback: revert §3

- [x] p0-4: SPEC §4 — multi-tenant isolation scheme
      depends_on: p0-1
      acceptance: one .mseg/.mnsw/.mpq triple per org; directory layout + naming + open/mount lifecycle specified
      risk_tier: low
      rollback: revert §4

- [x] p0-5: SPEC §5 — query API surface (exact signatures + semantics)
      depends_on: p0-1
      acceptance: open/insert/recall/compact signatures final; Filter carries entity bitmap + created_at/valid_from ranges; hops semantics defined; all served from one mmap
      risk_tier: medium
      rollback: revert §5

- [x] p0-6: SPEC §6 — invariants
      depends_on: p0-1,p0-5
      acceptance: enumerate — append-only write path; async (never inline) index rebuild; recall never blocks on rebuild; stable slot ids; tombstone deletes until compact. These are the kill-condition guards the later gates check.
      risk_tier: high
      rollback: revert §6

- [x] p0-freeze: human review + freeze SPEC.md
      depends_on: p0-1,p0-2,p0-3,p0-4,p0-5,p0-6
      acceptance: HUMAN sets Frozen:YES + Reviewed by:<name> in SPEC.md, creates loop/APPROVALS/p0.freeze, and commits as themselves (NOT the loop identity). The loop will AWAIT HUMAN here — it cannot self-freeze. Gate: loop/gates/p0_spec_frozen.sh exits 0.
      risk_tier: human-gate
      rollback: set Frozen:NO

## Phase P1 — Proof of physics (gate: mneme int8 scan p50 < Qdrant REST p50 @10k, real memories)

- [x] p1-1: real test-vector generator (bge-m3 via blaiq LiteLLM (prod model), 1024-dim, real LongMemEval memories)
      depends_on: p0-freeze
      acceptance: bench/gen_vectors.py streams LongMemEval haystack turns, embeds 10,000 corpus + 200 query memory texts with bge-m3 via blaiq LiteLLM gateway (same model+endpoint HIVE-MIND prod uses, 1024-dim), L2-normalizes, writes bench/data/corpus_f32.bin (10000×1024 f32 LE) + queries_f32.bin (200×1024) + meta.json (counts, dim, model, sha of source). Deterministic (fixed slice). Real text only, no synthetic.
      risk_tier: medium
      rollback: rm bench/gen_vectors.py bench/data/*

- [x] p1-2: Rust workspace + mneme-probe crate (mseg-precursor writer/reader + int8 scan)
      depends_on: p1-1
      acceptance: crate/ cargo workspace builds; mneme-probe lib has: write_segment() (header + N×{id u32, int8[dim]} packed, mmap-readable), open_segment() (memmap2-wrapped, zerocopy cast), int8 scalar-quantize (per-vector L2→i8 scale 127), brute_scan(query, top_k) rayon parallel cosine over int8, returns top_k (slot_id, score). cargo test green incl. proptest round-trip (write→mmap→read byte-identical) + scan-correctness vs exact f32 oracle (top-10 overlap ≥ 0.9 on real vectors).
      risk_tier: high
      rollback: rm -rf crate/

- [x] p1-3: Qdrant baseline harness (real REST, int8 scalar quant, recall@10 p50)
      depends_on: p1-1
      acceptance: bench/qdrant_bench.py starts local qdrant 1.18.2, creates 1024-dim cosine collection with int8 scalar quantization (matches HIVEMIND prod config), upserts the 10k corpus, runs 200 query recall@10 over REST (HTTP localhost, default search), records p50 latency ms across queries. Writes qdrant_rest_p50_ms to a temp numbers file.
      risk_tier: medium
      rollback: kill qdrant; rm qdrant storage

- [x] p1-4: run benchmark, write RESULTS.md numbers, pass p1 gate
      depends_on: p1-2,p1-3
      acceptance: mneme-probe bench bin loads corpus, builds segment, runs identical 200 queries recall@10, measures p50 (criterion or manual percentile). Append mneme_scan_p50_ms= and qdrant_rest_p50_ms= to bench/RESULTS.md with the producing sha. loop/gates/p1_beats_qdrant.sh exits 0 (mneme p50 < qdrant p50). Both numbers from real runs on identical real vectors.
      risk_tier: high
      rollback: revert RESULTS.md numbers

## Done

_(units move here with their sha as they complete)_
