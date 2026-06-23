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
