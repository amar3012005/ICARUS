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

## Phase P2 — Production crate (gate: cargo test 100% green + clippy -D warnings clean + bench baseline)

- [x] p2-1: mseg-format crate — file header (64B) + slot header (202B) exact byte layout
      depends_on: p1-4
      acceptance: new crate/mseg-format. FileHeader (64B) + SlotHeader (202B) #[repr(C)] zerocopy structs byte-match SPEC §1.2/§1.3 EXACTLY (offsets/sizes/types). flags bitmask (SPEC §1.4) const set. spec_lock test asserts size_of::<FileHeader>()==64, size_of::<SlotHeader>()==202 and every field offset matches a fixture table parsed from SPEC.md. cargo test green, clippy -D warnings clean.
      risk_tier: high
      rollback: rm -rf crate/mseg-format

- [x] p2-2: variable LZ4 text region (lz4_flex) — append + read-by-text_ptr
      depends_on: p2-1
      acceptance: VarRegion writer appends LZ4 block, returns text_ptr/text_len_lz4/text_len_raw; reader decompresses by ptr. 64KiB max text enforced (Err TextTooLarge). proptest: text round-trips (compress→ptr→decompress == original) for arbitrary utf8 ≤64KiB. clippy clean.
      risk_tier: medium
      rollback: revert p2-2 module

- [x] p2-3: segment open/create lifecycle + .vec bootstrap side-file (SPEC §3.3)
      depends_on: p2-1,p2-2
      acceptance: Segment::create initializes 64B file header (magic MNEME\0, version 0, dim, counts, free_list_head=0xFFFFFFFF, var_region_off page-aligned). Segment::open mmaps RW (memmap2 wrapped owner), validates header. Raw f32 vectors stored in <org>.vec side-file (pre-PQ bootstrap, SPEC §3.3) keyed by slot_id. proptest: create→open round-trip header-consistent. clippy clean.
      risk_tier: high
      rollback: revert p2-3

- [x] p2-4: CRUD — insert/get/delete/recall (append-only, free-list, tombstone)
      depends_on: p2-3
      acceptance: insert (LZ4 text append + slot append OR free-list pop + .vec append; returns stable SlotId; append-only per SPEC §6.1); get(SlotId) (Err TombstonedSlot if deleted); delete (set TOMBSTONE + free-list push, var bytes NOT freed per §6.4); recall (brute-force f32 cosine over .vec, skip tombstoned, apply Filter entity_mask + temporal ranges per §5.4 steps 1-4, hops=0 for P2). proptest: insert N → all gettable; delete → not in recall, slot reusable; append-only (file strictly grows on insert). clippy clean.
      risk_tier: high
      rollback: revert p2-4

- [x] p2-5: multi-tenant Shard + fcntl lock (SPEC §4)
      depends_on: p2-4
      acceptance: Shard::open(data_root, org_id) validates org_id [a-zA-Z0-9_-]{1,64} (reject .. / symlink traversal), mkdir data_root/<org_id>/, acquires shard.lock via fcntl F_SETLK (Err ShardLocked if held). Drop flushes msync + releases lock. test: two opens of same org → second Err ShardLocked; bad org_id rejected. clippy clean.
      risk_tier: medium
      rollback: revert p2-5

- [x] p2-6: invariant tests + Miri over unsafe mmap path (SPEC §6)
      depends_on: p2-4
      acceptance: proptest suite encoding SPEC §6 invariants — append-only (file grows, existing slots immutable), tombstone-until-compact, stable slot ids, header-consistent-after-flush. cargo +nightly miri test over the mmap read path passes (or documented-skip if miri unavailable, with a same-coverage non-miri OOB-safety proptest). clippy clean.
      risk_tier: high
      rollback: revert p2-6

- [x] p2-7: criterion bench baseline + P2 milestone gate
      depends_on: p2-1,p2-2,p2-3,p2-4,p2-5,p2-6
      acceptance: criterion bench over insert + recall recorded to bench/RESULTS.md (mseg_insert_p50_us, mseg_recall_p50_ms vs the same 10k real corpus). Full workspace cargo test 100% green, cargo clippy --all-targets -D warnings clean, cargo fmt --check clean. These three are the P2 gate.
      risk_tier: medium
      rollback: revert p2-7

## Phase P3 — HNSW + entity bitmap (gate: recall@10 <5ms @1M, <3% quality loss vs Qdrant float32, writepath isolated)

- [x] p3-1: mnsw-index crate — thin usearch HNSW wrapper (reuse, ≤150 LOC, label=slot_id)
      depends_on: p2-7
      acceptance: new crate/mnsw-index wrapping usearch 2.25 (Cos, i8 scalar quant). add(slot_id as label, vector), search(query, ef)->candidate slot_ids, save(.mnsw)/load(.mnsw) (usearch serialize). NO bespoke HNSW (recon denylist: any *hnsw* file >150 LOC fails). build clean, unit tests: add N → self-search returns own id; save→load round-trip; clippy -D warnings clean.
      risk_tier: high
      rollback: rm -rf crate/mnsw-index

- [x] p3-2: HNSW-backed recall + async index update (write-path isolation)
      depends_on: p3-1,p2-4
      acceptance: Segment gains an optional .mnsw overlay. insert() appends slot+vec+text AND enqueues an async usearch.add (channel/bg thread) — NEVER rebuilds inline (SPEC §6.1/§6.2). recall() uses usearch.search(ef=max(4k,64)) for candidates, post-filters tombstones, exact/ADC rerank, returns top_k. recall never blocks on the async queue (SPEC §6.2). tests: HNSW recall matches brute-force top-k on 10k real (overlap ≥ 0.97); recall returns even with pending async adds. clippy clean.
      risk_tier: high
      rollback: revert p3-2

- [x] p3-3: entity-bitmap O(1) filter in recall
      depends_on: p3-2
      acceptance: recall(query, Filter{entity_mask}) applies bitwise-AND entity filter (SPEC §1.3/§5.4) over HNSW candidates (usearch predicate callback if available, else post-filter), plus temporal ranges. test: entity-filtered recall returns only slots with matching bits; matches brute-force-with-filter on real data. clippy clean.
      risk_tier: medium
      rollback: revert p3-3

- [x] p3-4: write-path isolation gate (append never triggers inline rebuild)
      depends_on: p3-2
      acceptance: loop/gates/writepath_isolation.sh passes — no static call edge append→rebuild_hnsw, AND append_p99_under_concurrent_rebuild bench number recorded to bench/RESULTS.md (insert p99 stays bounded while a background index rebuild runs). Encodes the kill-condition guard (HNSW rebuild-on-write).
      risk_tier: high
      rollback: revert p3-4

- [x] p3-5: 1M recall@10 benchmark — <5ms + <3% quality vs Qdrant float32 (P3 GATE)
      depends_on: p3-2,p3-3,p3-4
      acceptance: build a 1M-vector dataset (real bge-m3 base + documented fill strategy to 1M), index with HNSW, measure recall@10 p50 (<5ms) and quality overlap vs Qdrant float32 recall@10 (<3% loss). Write mnsw_recall10_p50_ms_1m + mnsw_quality_loss_pct to bench/RESULTS.md. loop/gates/p3_recall_latency.sh + writepath_isolation.sh exit 0. NOTE: 1M real-embed cost/time is a resource decision — flag to user at this unit.
      risk_tier: high
      rollback: revert RESULTS numbers

## Done

## Phase P4 — Product Quantization (gate: recall@10 overlap >96% vs float32 + pq_drift_detect test; retrain never inline)

- [ ] p4-1: mpq crate — PQ codebook training (k-means, M=128 subspaces × 8 dims, K=256) + encode/decode
      depends_on: p3-5
      acceptance: new crate/mpq. PqCodebook::train(vectors, M=128, K=256) runs per-subspace k-means (kmeans++ init, Lloyd iters, rayon over subspaces), produces [M][K][dim/M] f32 centroids. encode(vec)->[u8;128] (nearest centroid per subspace). decode(code)->reconstructed f32 vec. .mpq on-disk format byte-matches SPEC §3.2 (magic MPQC, M/K/dim header, centroids row-major). save/load. unit tests: train→encode→decode reconstruction error bounded; save/load round-trip; clippy clean.
      risk_tier: high
      rollback: rm -rf crate/mpq

- [ ] p4-2: ADC (asymmetric distance computation) — query vs PQ codes
      depends_on: p4-1
      acceptance: adc_table(query) precomputes [M][K] distances (query subvec vs each centroid); adc_distance(table, code) sums per-subspace table lookups (no decode). matches SPEC §3.3 ADC. test: ADC ranking correlates with exact f32 cosine ranking (top-10 overlap high on real vectors). clippy clean.
      risk_tier: medium
      rollback: revert p4-2

- [ ] p4-3: drift detection — alignment score + enqueue retrain (never inline)
      depends_on: p4-1
      acceptance: alignment_score(codebook, sample) = mean cosine(reconstructed, original) over a sample; <0.85 sets a DRIFT flag and ENQUEUES retrain (never runs inline — writepath gate: retrain_codebook absent from append.rs). cargo test pq_drift_detect passes (drift on a shifted distribution flags; aligned distribution does not). clippy clean.
      risk_tier: high
      rollback: revert p4-3

- [ ] p4-4: integrate PQ into segment + P4 gate (recall@10 overlap >96% vs float32)
      depends_on: p4-1,p4-2,p4-3
      acceptance: segment trains per-org codebook at 10k inserts, populates slot vector_pq + PQ_TRAINED flag, .vec side-file retired post-train per SPEC §3.3 (or kept for rerank). recall path can use ADC over PQ codes. bench: pq_recall10_overlap_pct = overlap of PQ-based recall@10 vs float32 ground truth on real 10k. Write to bench/RESULTS.md. loop/gates/p4_pq_overlap.sh exits 0 (>96.0). clippy clean.
      risk_tier: high
      rollback: revert RESULTS numbers

## Done

_(units move here with their sha as they complete)_
