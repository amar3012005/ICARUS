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

### 1.1 Endianness and alignment

- All multi-byte integers: **little-endian**.
- Slot region: page-aligned (align to 4096 bytes). Start offset rounded up from end of file header to next 4096-byte boundary.
- Slot headers: packed (no padding between slots). Each slot is exactly **194 bytes**.
- Variable region: immediately follows the slot array, no alignment padding.

### 1.2 File header

Offset 0, fixed 64 bytes:

```
offset  size  type    field            description
------  ----  ------  ---------------  -------------------------------------------
0       6     [u8;6]  magic            b"MNEME\0"  (6 bytes, null-terminated)
6       2     u16     format_version   0 = this spec; bump on incompatible change
8       4     u32     dim              embedding dimension (e.g. 1024 for bge-m3)
12      4     u32     slot_count       total allocated slots (includes tombstoned)
16      4     u32     live_count       slots with flags.TOMBSTONE == 0
20      4     u32     free_list_head   slot_id of first free (TOMBSTONED) slot, or 0xFFFF_FFFF if none
24      4     u32     var_region_off   byte offset from file start to variable region
28      4     u32     var_region_len   used bytes in variable region
32      4     u32     pq_codebook_off  byte offset to .mpq file header (0 if PQ not yet trained)
36      4     u32     reserved_0       must be 0
40      8     i64     created_at_epoch file creation unix timestamp (seconds)
48      8     i64     last_compact_at  unix timestamp of last compact(), or 0
56      8     u64     reserved_1       must be 0
```

Total file header: 64 bytes.

### 1.3 Slot header (194 bytes, fixed, little-endian)

The slot region begins at the first 4096-byte boundary after byte 64 of the file.
Slot `i` starts at `slot_region_off + i * 194`.

```
offset  size  type       field            description
------  ----  ---------  ---------------  ------------------------------------------
0       4     u32        id               stable slot id; assigned at insert, never reused
4       2     u16        flags            bit flags (see §1.4)
6       8     i64        created_at       ingestion unix timestamp (nanoseconds)
14      8     i64        valid_from       fact-validity start (nanoseconds); bi-temporal axis 2
22      4     u32        text_ptr         byte offset from var_region start to LZ4 block
26      4     u32        text_len_lz4     compressed length in bytes (0 = no text)
30      4     u32        text_len_raw     uncompressed length in bytes
34    128     [u8;128]   vector_pq        PQ-compressed embedding (128 bytes = 1024-dim / 8 subspaces × 1B each)
162     8     u64        entity_bitmap    64 canonical entity slots, 1 bit per entity (O(1) AND filter)
170    32     [u32;8]    adjacency        8 nearest-neighbour slot_ids; 0xFFFF_FFFF = empty slot
202     ...   (end)
```

Wait — recount: 4+2+8+8+4+4+4+128+8+32 = 202 bytes. GLOBAL_PLAN says ~194. Resolving:

Authoritative layout (this spec overrides the sketch in GLOBAL_PLAN.md):

```
offset  size  type       field
------  ----  ---------  ---------------
0       4     u32        id
4       2     u16        flags
6       8     i64        created_at       (nanoseconds, signed)
14      8     i64        valid_from       (nanoseconds, signed)
22      4     u32        text_ptr
26      4     u32        text_len_lz4
30      4     u32        text_len_raw
34    128     [u8;128]   vector_pq
162     8     u64        entity_bitmap
170    32     [u32;8]    adjacency
202
```

Slot size = **202 bytes**. (GLOBAL_PLAN ~194 was a pre-spec sketch; 202 is the frozen value.)

### 1.4 `flags` bitmask (u16)

| Bit | Mask   | Name        | Meaning                                                    |
|-----|--------|-------------|------------------------------------------------------------|
| 0   | 0x0001 | TOMBSTONE   | Slot is deleted; skipped in recall; eligible for compact   |
| 1   | 0x0002 | PQ_TRAINED  | `vector_pq` field is valid (0 = not yet quantized)         |
| 2   | 0x0004 | TEXT_INLINE | Text fits in text_ptr field itself (future optimization)   |
| 3   | 0x0008 | GRAPH_DIRTY | Adjacency list stale; async rebuild pending                |
| 4–15| —      | reserved    | Must be 0 on write; ignored on read                        |

### 1.5 Variable region — LZ4 compressed text

- Starts at `file_header.var_region_off`.
- Contains back-to-back LZ4 frame-format blocks, each addressed by a slot's `text_ptr`.
- Each LZ4 block is independent (decompresses standalone).
- Write path: append-only. New text blocks appended; old blocks never moved.
- Reclaimed by `compact()` only (see §5.4).
- Max raw text per slot: 64 KiB (enforced at insert; returns `Err(TextTooLarge)` otherwise).

### 1.6 Free-list

- `file_header.free_list_head` is the slot_id of the first TOMBSTONED slot, or `0xFFFF_FFFF`.
- TOMBSTONED slots chain via `adjacency[0]` (first adjacency word repurposed as next-free pointer when TOMBSTONE=1).
- `insert()` pops from the free list first (reuses the slot_id); only appends a new slot when the list is empty.
- Slot ids are **stable across compact()**; compact rewrites var region and rebuilds index but never renumbers slots.

---

## 2. `.mnsw` — HNSW index (reuses `usearch` on-disk format)

### 2.1 Chosen crate

`usearch` (v2.x) — see `reference/OPENSOURCE_RECON.md`. Do NOT implement bespoke HNSW.
The `.mnsw` file IS the usearch serialized index; mneme owns the slot_id↔usearch_label mapping.

### 2.2 Key → slot_id mapping

- usearch `label` (u64) = mneme `slot_id` (u32) cast to u64.
- On `insert(mem)`: add vector to usearch with label = new slot_id.
- On `compact()`: re-add surviving slot vectors; rebuild is atomic (write to `.mnsw.tmp`, rename).
- On TOMBSTONE: do NOT remove from usearch at delete time; filter tombstoned slots at recall time (post-filter on the hit list). This keeps the write path fast.

### 2.3 Co-location and mmap strategy

- `.mseg` and `.mnsw` sit in the same shard directory (see §4).
- `.mseg` is mmap'd read-write; `.mnsw` is loaded via `usearch::Index::load()` (usearch manages its own mmap).
- Both files opened on `Shard::open()`; held open for the shard lifetime.
- Writes to `.mseg` (slot append) are immediately visible via mmap. Index updates from HNSW are async (see §6 invariants).

### 2.4 Async index rebuild

- Every `insert()` queues a background task: `usearch.add(label, vector)`.
- The background task uses a per-shard `Mutex<usearch::Index>`.
- `recall()` calls `usearch.search()` under a read lock; concurrent inserts queue behind.
- Index is never rebuilt from scratch on normal writes — only on `compact()`.

---

## 3. `.mpq` — Product Quantization codebook (per org)

### 3.1 Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| M (subspaces) | 8 | 1024-dim / 8 = 128-dim per subspace; balanced compression/quality |
| K (centroids per subspace) | 256 | 1 byte per subspace → 128-byte PQ code |
| Training trigger | first 10,000 inserts | Enough data for stable centroids |
| Max drift before retrain | alignment_score < 0.85 | See §3.4 |

Result: 1024-dim float32 (4096 bytes) → 128-byte PQ code = **32x compression**.

### 3.2 On-disk layout

File: `<shard_dir>/<org_id>.mpq`

```
offset  size         field
------  -----------  -------------------------------------------
0       4            magic: b"MPQC"
4       2            version: u16 = 0
6       2            M: u16 (subspaces)
8       2            K: u16 (centroids per subspace)
10      4            dim: u32 (full embedding dimension)
14      4            trained_on: u32 (number of vectors used for training)
18      8            trained_at: i64 (unix timestamp, nanoseconds)
26      6            reserved (must be 0)
32      M×K×(dim/M)×4  centroids: f32 array, row-major
                     shape: [M][K][dim/M]
                     = 8 × 256 × 128 × 4 = 1,048,576 bytes
```

Total file size: 32 + 1,048,608 bytes ≈ 1 MiB.

### 3.3 Encoding and decoding

- **Encode** (insert path, after training): for each subspace `m`, find nearest centroid index in `centroids[m]` by L2; store index as u8 in `vector_pq[m]`.
- **Decode** (recall path, asymmetric distance): query vector is NOT quantized; distance from query to each slot = sum of `dist(query_subvec[m], centroids[m][pq_code[m]])` over M subspaces (ADC — Asymmetric Distance Computation).
- Before PQ is trained (`pq_codebook_off == 0`): store raw float32 in an overflow structure (not in the slot header — slot_id → raw vector side-file `<shard_dir>/<org_id>.vec`). Spec for `.vec` is in FUTURE.md (only needed during bootstrap phase).

### 3.4 Drift detection

After each batch of 1,000 inserts (once trained): compute **alignment score** = mean cosine similarity between each slot's PQ-reconstructed vector and the original (sampled from the `.vec` side-file, 512 random slots). If `alignment_score < 0.85`, set a `DRIFT` flag in the shard's in-memory state and log a warning. Retrain is manual-triggered via `compact()` (which retrains PQ, re-encodes all slots, rebuilds HNSW). Fully automatic retrain is deferred to FUTURE.md.

---

## 4. Multi-tenant isolation

### 4.1 Directory layout

```
<data_root>/
  <org_id>/               # one directory per org (org_id = alphanumeric slug, max 64 chars)
    shard.mseg            # memory segment
    shard.mnsw            # usearch HNSW index
    shard.mpq             # PQ codebook (absent until first 10k inserts)
    shard.vec             # raw float32 side-file (absent after PQ trained + compacted)
    shard.lock            # POSIX advisory lock (fcntl F_SETLK) — held by owning process
```

Single-shard-per-org design. Multi-shard sharding is deferred to FUTURE.md.

### 4.2 Naming invariants

- `org_id` must match `[a-zA-Z0-9_-]{1,64}`. Validated at `Shard::open()`.
- File names are fixed strings (not parameterized by org_id); the directory provides isolation.
- No symlinks or relative paths traversal (`..`) in org_id — validated and rejected.

### 4.3 Open / mount lifecycle

```
Shard::open(data_root, org_id):
  1. Construct path = data_root / org_id
  2. mkdir_all(path) if absent
  3. Acquire shard.lock via fcntl F_SETLK (LOCK_EX, non-blocking)
     → Err(ShardLocked) if another process holds it
  4. mmap shard.mseg (create + write file header if new)
  5. Load shard.mnsw via usearch::Index::load() (or create empty index)
  6. Load shard.mpq if present
  7. Return Shard handle

Shard::drop():
  1. Flush mmap (msync MS_SYNC)
  2. Release fcntl lock
  3. Close all file handles
```

One `Shard` object per org per process. The lock prevents double-open from concurrent processes.

---

## 5. Query API surface

### 5.1 Types

```rust
/// Stable identifier for a memory slot. Never reused, never renumbered.
pub type SlotId = u32;

/// Input to insert().
pub struct MemoryInput {
    pub text: String,              // raw memory text, max 64 KiB
    pub vector: Vec<f32>,          // embedding, length must equal shard.dim
    pub entity_bitmap: u64,        // caller-supplied entity bits
    pub adjacency: [SlotId; 8],    // caller-supplied graph neighbours (0xFFFF_FFFF = none)
    pub valid_from: i64,           // nanoseconds; when this fact became true
    pub created_at: Option<i64>,   // nanoseconds; None = use wall clock at insert time
}

/// One result from recall().
pub struct Hit {
    pub slot_id: SlotId,
    pub score: f32,                // ADC distance (lower = more similar)
    pub text: String,              // decompressed text
    pub entity_bitmap: u64,
    pub created_at: i64,
    pub valid_from: i64,
    pub adjacency: [SlotId; 8],
}

/// Filter applied during recall(). All conditions ANDed.
pub struct Filter {
    pub entity_mask: Option<u64>,        // if Some(m), slot passes iff (slot.entity_bitmap & m) != 0
    pub created_at_range: Option<(i64, i64)>,  // inclusive [lo, hi] nanoseconds
    pub valid_from_range: Option<(i64, i64)>,  // inclusive [lo, hi] nanoseconds
}
```

### 5.2 `open`

```rust
pub fn open(data_root: &Path, org_id: &str) -> Result<Shard>
```

- Acquires the shard lock (see §4.3). Non-blocking — returns `Err(ShardLocked)` immediately if locked.
- Creates the directory and empty segment if they don't exist.
- Returns a `Shard` handle that owns mmap + usearch index for the org's lifetime.

### 5.3 `insert`

```rust
pub fn insert(&mut self, mem: MemoryInput) -> Result<SlotId>
```

1. Validate: `mem.vector.len() == self.dim`, `mem.text.len() <= 65536`.
2. LZ4-compress `mem.text` → append to var region.
3. Pop slot from free list, or append new slot at `slot_count * 202`.
4. Write slot header (PQ-encode vector if PQ trained; else raw into `.vec` side-file).
5. Increment `live_count`. Update file header (mmap write — immediately durable via msync on next flush).
6. Queue async usearch add (non-blocking channel send; background thread drains).
7. Return `slot_id`.

Write path is **append-only** (existing slots never moved). Returns before HNSW is updated — HNSW update is async.

### 5.4 `recall`

```rust
pub fn recall(
    &self,
    query: &[f32],
    filter: Filter,
    hops: u8,
    top_k: usize,
) -> Result<Vec<Hit>>
```

1. Validate `query.len() == self.dim`.
2. **HNSW search**: call `usearch.search(query, ef_candidates)` where `ef_candidates = max(top_k * 4, 64)`. Returns up to `ef_candidates` candidates with usearch labels = slot_ids.
3. **Post-filter**: for each candidate slot, read its slot header from mmap. Skip if `flags.TOMBSTONE == 1`. Apply `Filter` (entity_mask AND, temporal ranges).
4. **ADC re-rank**: recompute ADC distance using PQ codebook for surviving candidates. Sort ascending.
5. **Graph hops** (if `hops > 0`): for each top-k hit, BFS over `adjacency` array up to `hops` levels. Add discovered slot_ids to candidate set. Re-filter and re-rank.
6. Return top `top_k` hits.

`recall()` never blocks on index rebuild (reads a snapshot of the usearch index under read lock). HNSW may be stale by at most the async lag (typically < 100ms). This is by design — see §6.

### 5.5 `compact`

```rust
pub fn compact(&mut self) -> Result<()>
```

1. Acquire exclusive lock (no concurrent recall during compact — compact is rare, O(minutes)).
2. Rewrite var region: copy only live (non-tombstoned) slot text blocks, update `text_ptr` in each slot header.
3. Reset free list (no tombstoned slots after compact).
4. Retrain PQ if drift flag is set or if `shard.vec` side-file exists (first compact after training).
5. Re-encode all `vector_pq` fields with new codebook.
6. Rebuild usearch index from scratch (write to `.mnsw.tmp`, atomic rename).
7. Delete `.vec` side-file if PQ is now trained.
8. Flush mmap. Update `last_compact_at`.

Compact rewrites the file but **does not renumber slot ids**. Slot ids are stable forever.

---

## 6. Invariants (enforced at all times; kill conditions if violated)

### 6.1 Append-only write path

> **Invariant**: `insert()` only appends. It never modifies an existing slot header, never moves var region blocks, never truncates any file. The only exception is updating the file header counters (`slot_count`, `live_count`, `var_region_len`, `free_list_head`) and the tombstone flag on an existing slot during `delete()`.

Kill condition: any code path that moves bytes in the slot region or var region outside of `compact()` is a bug. Tests must assert that inserting N memories strictly grows the file.

### 6.2 Async HNSW rebuild never blocks recall

> **Invariant**: `recall()` takes a read lock on the usearch index. It returns a result using the current index snapshot. If the async insert queue is non-empty (HNSW not yet updated), `recall()` still returns — it may miss the very latest inserts. This is expected and documented behavior.

Kill condition: `recall()` must never wait for a background HNSW task. If the async channel is full, the insert succeeds but logs a warning ("HNSW queue full, insert will be indexed with lag").

### 6.3 Stable slot ids

> **Invariant**: once a `SlotId` is returned by `insert()`, it identifies that memory forever within the shard. `compact()` does not renumber slots. If a slot is tombstoned and its id reused by a future insert (via free list), the old id is invalid and any caller holding it will get `Err(TombstonedSlot)` on access. Slot id reuse is allowed; slot id mutation is not.

### 6.4 Tombstone deletes until compact

> **Invariant**: `delete(slot_id)` sets `flags.TOMBSTONE = 1` on the slot header and adds the slot to the free list. The var region bytes are NOT freed at delete time — they are reclaimed only by `compact()`. `recall()` must skip tombstoned slots (checked in step 3 of §5.4).

Kill condition: any recall that returns a tombstoned memory is a bug.

### 6.5 Entity bitmap is caller-controlled

> **Invariant**: mneme does not assign or interpret entity bits. The caller (HIVEMIND) maps entity names to bit positions and passes `entity_bitmap` at insert time. mneme stores and filters but never modifies entity bitmaps.

### 6.6 File header always consistent after flush

> **Invariant**: `slot_count`, `live_count`, and `var_region_len` in the file header must be consistent with the actual slot region and var region after any `msync`. In-memory state may be ahead (buffered), but a crash-then-reopen must produce a consistent read (no partial slot headers written).

Enforcement: slot header write is a single `memcpy` of 202 bytes within the mmap. On x86-64/arm64, 202-byte aligned writes to mmap are not atomic — recovery on crash before msync may see a partial slot. P2 must add a write-ahead slot that marks the slot as VALID only after the full 202-byte header is flushed. This is tracked as a P2 requirement.

---

## Appendix A — Size accounting

| Item | Size |
|------|------|
| File header | 64 B |
| Slot header | 202 B |
| Average text (LZ4-compressed) | ~400 B |
| Average memory total | ~602 B |
| Qdrant point + Postgres row (today) | ~4,500 B |
| **Compression ratio** | **~7.5x** |

---

## Appendix B — Not in scope (→ FUTURE.md)

- Multi-shard per org (sharding by slot count)
- Automatic PQ retrain on drift
- Replication / WAL
- S3/object-storage backend
- Multi-dim support (different dim per org)
- Text larger than 64 KiB
- Slot id > 32-bit (u64 slot ids)
