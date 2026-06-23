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
