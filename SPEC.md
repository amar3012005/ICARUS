# mneme `.mseg` File Format Specification — RFC

> **STATUS: DRAFT — PHASE 0 DELIVERABLE, NOT YET FROZEN.**
>
> This file is the single source of truth for the mneme storage format. Phase 0 of
> `GLOBAL_PLAN.md` is complete only when this spec covers all four formats below plus
> the query API, and a human has reviewed and frozen it. **No implementation code may
> be written until this spec is frozen.** Once frozen, scope is locked — any change
> requires an explicit human-approved spec revision (bump the version), and any new
> capability not in this spec goes to `FUTURE.md`.

---

## 0. Document control

| Field | Value |
|---|---|
| Format version | 0 (DRAFT) |
| Frozen | NO |
| Reviewed by | — |
| Freeze date | — |

To freeze: fill the three fields above, commit, and the P0 gate (`loop/PHASE_GATES.md`) passes.

---

## 1. `.mseg` — memory segment (one per org)

> TODO (P0): fully specify. The skeleton below is the design intent from
> `GLOBAL_PLAN.md`; expand each field with exact endianness, alignment, and invariants.

- File header: magic bytes `MNEME\0`, format version, dimension, slot count, PQ codebook ref, free-list head.
- Fixed slot region: array of slot headers (~194 B each — see GLOBAL_PLAN layout table).
- Variable region: LZ4-compressed memory text, addressed by `text_ptr`.
- Endianness: little-endian (target x86-64 / arm64).
- Alignment: slot region page-aligned for mmap.

## 2. `.mnsw` — HNSW index (reuses `usearch` on-disk format)

> TODO (P0): specify how usearch's serialized index keys map to `.mseg` slot ids,
> and the co-location / mmap strategy. Do NOT design a bespoke HNSW format — reference
> `reference/OPENSOURCE_RECON.md` for the chosen crate.

## 3. `.mpq` — Product Quantization codebook (per org)

> TODO (P0): specify M (subspaces), K (centroids), training trigger (first 10k inserts),
> drift-detection alignment score, and on-disk layout.

## 4. Multi-tenant isolation

> TODO (P0): one `.mseg`/`.mnsw`/`.mpq` triple per org. Specify directory layout,
> naming, and the open/mount lifecycle.

## 5. Query API surface

> TODO (P0): exact signatures + semantics.

```rust
fn open(path: &Path) -> Result<Shard>;
fn insert(&mut self, mem: MemoryInput) -> Result<SlotId>;
fn recall(&self, query: &[f32], filter: Filter, hops: u8, top_k: usize) -> Result<Vec<Hit>>;
fn compact(&mut self) -> Result<()>;
```

`Filter` carries: entity bitmap, `valid_from`/`created_at` ranges. `hops` triggers
adjacency-list BFS. All served from one mmap'd shard.

---

## 6. Invariants (must hold at all times)

> TODO (P0): enumerate. E.g. write path is append-only; index rebuild is async; a recall
> never blocks on rebuild; slot ids are stable; deletes are tombstones until `compact`.
