# mneme Loop Progress

## CURRENT

| Date       | Phase | Task          | Last SHA | Notes |
|------------|-------|---------------|----------|-------|
| 2026-06-23 | P0    | AWAITING_HUMAN | —       | SPEC §1–§6 complete. Parked at p0-freeze. Human must review SPEC.md, set Frozen:YES, touch APPROVALS/p0.freeze, commit. |

## History

| Date       | Phase | Unit  | Outcome |
|------------|-------|-------|---------|
| 2026-06-23 | P0    | p0-1  | DONE — SPEC §1 `.mseg` file header + slot layout (202B) + var region fully specified |
| 2026-06-23 | P0    | p0-2  | DONE — SPEC §2 `.mnsw` usearch key↔slot_id mapping + async rebuild + mmap strategy |
| 2026-06-23 | P0    | p0-3  | DONE — SPEC §3 `.mpq` M=8/K=256, 1MiB codebook, drift detection (alignment_score < 0.85) |
| 2026-06-23 | P0    | p0-4  | DONE — SPEC §4 data_root/<org_id>/ layout, fcntl lock, open/drop lifecycle |
| 2026-06-23 | P0    | p0-5  | DONE — SPEC §5 SlotId/MemoryInput/Hit/Filter types, open/insert/recall/compact signatures+semantics |
| 2026-06-23 | P0    | p0-6  | DONE — SPEC §6 6 invariants: append-only, async HNSW, stable ids, tombstone, entity-controlled, header consistency |

## P1 — Proof of physics (PASS 2026-06-23)
| Unit | Outcome |
|------|---------|
| p1-1 | DONE — gen_vectors.py: 10k+200 real LongMemEval memories embedded via bge-m3/blaiq (prod model), 1024-dim, normalized, deterministic |
| p1-2 | DONE — mneme-probe crate: .mseg-precursor writer/mmap-reader (memmap2+zerocopy), int8 scalar quant, rayon brute scan; 4 tests + proptest green, clippy -D warnings clean, fmt clean |
| p1-3 | DONE — qdrant_bench.py: local Qdrant 1.18.2, int8 scalar quant (prod parity), keep-alive REST, recall@10 p50 |
| p1-4 | DONE — GATE PASS: mneme_scan_p50_ms=0.1548 < qdrant_rest_p50_ms=2.0571 (13.3x). mneme recall@10=0.957 vs f32 oracle; Qdrant recall@10=1.0 |

GO decision: thesis proven. Local int8 mmap scan beats Qdrant REST by 13x at 10k on real bge-m3 vectors. Advancing to P2 (production crate).

## P2 — Production crate (GATE PASS 2026-06-23)
| Unit | Outcome |
|------|---------|
| p2-1 | mseg-format: FileHeader(64B)+SlotHeader(202B) byte-array LE structs, spec-locked (offset_of! == SPEC §1.2/§1.3) |
| p2-2 | LZ4 var text region (append/read-by-ptr, 64KiB cap, proptest 200) + MsegError enum |
| p2-3 | Segment: growable mmap .mseg + parallel .vec mmap + append-only .txt; create/open/flush |
| p2-4 | CRUD: insert(append-only)/get/delete(tombstone+free-list)/recall(exact f32 cosine + entity+temporal Filter) |
| p2-5 | Shard: data_root/<org_id>/ + flock(LOCK_EX|NB) advisory lock (stronger than fcntl per §4.3 note) |
| p2-6 | §6 invariant tests (append-only/stable-ids/tombstone-keeps-bytes/entity-controlled/header-consistency) + OOB-safety proptest (Miri documented-skip: mmap not Miri-able, no nightly) |
| p2-7 | GATE PASS: fmt + clippy --all-targets --all-features -D warnings + test (35) + llvm-cov 89.7% (>=80). Baseline: mseg_insert_p50_us=3.79, mseg_recall_p50_ms=22.55 (exact f32, HNSW is P3) |

P2 deliverable: production .mseg crate, format spec-locked, CRUD complete, multi-tenant, 35 tests, 89.7% coverage. Advancing to P3 (usearch HNSW + entity bitmap O(1) filter).

## P3 — HNSW + entity bitmap (GATE PASS 2026-06-23)
| Unit | Outcome |
|------|---------|
| p3-1 | mnsw-index: thin usearch wrapper (Cos+i8, label=slot_id, save/load), 143 LOC, 4 tests |
| p3-2 | append.rs isolated write path + AsyncIndexer (bg thread) + HNSW recall; overlap >=0.97 real 10k, non-blocking w/ pending adds |
| p3-3 | entity-bitmap O(1) + bi-temporal filter over HNSW candidates (ef widens 8x on active filter) |
| p3-4 | writepath_isolation gate PASS: append_p99_under_concurrent_rebuild=54.75us (insert unblocked by indexing) |
| p3-5 | GATE PASS: recall10_p50_ms=1.334 @1M (<5), recall10_quality_loss_pct=0.75 vs Qdrant f32 (<3). Parallel bulk-seed (1M HNSW build 293s). |

P3 deliverable: usearch HNSW overlay, sub-2ms recall@10 @1M, 99.25% recall vs exact, write-path isolated. Also: SOLVIS real-doc recall demo (hybrid RRF+MMR ~1.4ms, cross-encoder rerank hooks). Advancing to P4 (Product Quantization).

## P4 — Product Quantization (GATE PASS 2026-06-24)
| Unit | Outcome |
|------|---------|
| p4-1 | mpq crate: k-means PQ codebook M=128/K=256, encode/decode, .mpq format. 4 tests |
| p4-2 | ADC distance (precomputed [M][K] table, no decode) |
| p4-3 | drift detection (alignment<0.85), pq_drift_detect test, retrain never inline |
| p4-4 | GATE PASS: pq_recall10_overlap_pct=100 (ADC scan + exact rescore, Qdrant-parity) >96; pure-ADC@10=79.3%. Segment train_pq() populates vector_pq+PQ_TRAINED+.mpq |

P4 done: 32x PQ compression, ADC, drift. Advancing to P5 (bi-temporal + 2-hop graph).
