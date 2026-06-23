# FUTURE.md — scope-creep parking lot

**Purpose.** Frozen scope is how a 16-week unattended build survives. The `.mseg` byte layout and the in-scope manifest are frozen in `SPEC.md` at P0, before any code. **Any idea that is not already in `SPEC.md` lands here — never in the current phase's code.** This file is the only legal destination for new ideas generated mid-run.

**Why this is mechanical, not advisory.** The per-phase work queue (`GOALS.md`) can only **shrink**; a phase terminates exactly when its queue empties and its single milestone artifact meets threshold in `BENCH.md`. If new ideas were allowed to append units, no phase would ever terminate and the program would wander for 16 weeks. Routing every new idea here is what guarantees each phase ends.

**Enforced by:** the `spec-lock` gate. A scope-manifest linter FAILS any PR that adds a top-level feature flag or module not listed in `SPEC.md`'s in-scope manifest, with the failure message directing the change here. Separately, any change to slot size, field offsets, or field semantics requires an explicit `SPEC.md` `FORMAT_VERSION` bump + a migration note in the same PR, or the `spec_matches_code` test fails.

**The rule for everything below:**
> **Nothing in this file is worked on until P7 ships** (current_phase == P7 with launch artifacts present). Logging an item here is the *complete* action — do not design it, do not prototype it, do not benchmark it. If an item turns out to be load-bearing for an in-scope gate, that is a `SPEC.md` change (version bump + review), not a silent pull from this list.

**How to add an item:** one checkbox, a one-line rationale, and the phase it could earliest be reconsidered (always ≥ P7). No designs, no code snippets. Keep it boring.

---

## Deferred ideas (none active until P7 ships)

### Storage / format
- [ ] **Residual Vector Quantization (RVQ) codebook** — RVQ (`ruvector-residual-vq`) keeps more recall than PQ's independent-subspace assumption (~64x compression), but P0 freezes a fixed 128B `pq_vector` slot. Reconsider as a P4+ codebook-quality upgrade behind a `FORMAT_VERSION` bump. _(REFERENCE_ONLY in OPENSOURCE_RECON.md.)_
- [ ] **zstd dictionary-trained cold/archival tier** — higher ratio (70–75%) than LZ4 with a dictionary pre-trained on similar memory texts; loses on decompress speed, so it cannot touch the recall hot path. Possible cold-storage tier only. _(REFERENCE_ONLY; pulls a C dep unless a pure-Rust zstd port is used.)_
- [ ] **Variable-length structured side region (rkyv)** — only if a slot ever needs nested/variable-length payloads beyond the LZ4 text blob; `zerocopy` covers the fixed header today. Would be a format-version change.
- [ ] **`entity_bitmap` beyond 64 entities** — the 8-byte bitmap caps at 64 entity facets. Scaling past that (roaring-bitmap posting lists, à la tantivy) is a format + filter change, not a tweak.
- [ ] **`adjacency[32B]` beyond fixed fan-out** — the fixed 32-byte adjacency region bounds graph degree per slot. Variable or spilled adjacency for high-degree nodes is a format change.

### Retrieval / index
- [ ] **Real BM25 / lexical hybrid recall (tantivy)** — mneme's entity filter is a bitmap AND inside the single mmap read, deliberately not an inverted index. A true keyword/BM25 hybrid would add a second storage engine and break the single-mmap-read claim — a post-launch architectural decision. _(REFERENCE_ONLY.)_
- [ ] **Alternate distance metrics** — beyond the P0-fixed metric (cosine on int8). Dot-product / L2 / learned metrics are easy to add to `usearch` but change recall semantics and every gate baseline; defer.
- [ ] **IVF / IVF-PQ partitioning** — coarse quantizer over the PQ codes for sub-linear candidate selection at >1M scale. Lance and faiss do this; it is a P3/P4 superset, not in frozen scope.
- [ ] **Reranking stage** — a second-pass exact-float rerank of ANN candidates. Out of scope until the PQ overlap gate and eval-harness baseline are met without it.

### Scale-out / multi-node
- [ ] **Distributed / sharded multi-node** — mneme P0..P6 is single-node, single-mmap. Sharding, replication, and a cross-node query planner are a separate system; the P6 kill-condition work (write-path isolation) is the prerequisite, not this.
- [ ] **GPU PQ codebook training** — k-means codebook training is CPU + `rayon` in P4. GPU training (CUDA/Metal) only matters at retrain volumes mneme has not hit; revisit if drift-retrain becomes a throughput bottleneck post-launch.
- [ ] **Concurrent multi-writer append** — P-phase append is single-writer by design (write-path isolation simplifies the kill-condition proof). Multi-writer coordination is a post-launch concern.

### Portability / packaging
- [ ] **WASM build** — a `wasm32` target for browser/edge embedding. The C-backed `usearch` FFI complicates this; would likely need the pure-Rust `instant-distance` fallback and a no-mmap path. Out of scope.
- [ ] **Bindings beyond Node** — Python / Go / C-ABI bindings. P6 ships only the napi-rs Node binding needed for the HIVEMIND swap; other languages are launch-time demand-driven.
- [ ] **Pure-Rust (no-C) build profile** — swap `usearch` for `instant-distance`/`hnsw_rs` if a C-free build is ever mandated (e.g. for the WASM target or a hardened supply chain). Contingency only; usearch is the P3 mandate today.

### Operations / product
- [ ] **Managed cloud offering** — hosted mneme as a service. Pure product/business scope; nothing in the Rust core changes for it. Not before OSS launch lands.
- [ ] **Online / incremental codebook update** — update the PQ codebook without a full retrain when drift is detected. P4 ships detect-and-enqueue-retrain; incremental update is a quality/latency optimization on top.
- [ ] **Compaction / GC of deleted slots** — reclaiming space from tombstoned (`flags`-deleted) slots and rewriting the `.mseg` file. P-phase CRUD marks deletes; physical compaction is a maintenance feature for later.
- [ ] **Encryption at rest / per-org key isolation** — the mmap file is plaintext today. Envelope encryption per org is a security feature to scope after the format and swap are proven.
- [ ] **Observability / metrics export** — structured `tracing` is in scope for the core; a metrics surface (Prometheus, OTel) for the deployed binary is post-P6.

---

_If you are reading this mid-run and tempted to start one of these: stop. Confirm `current_phase`. If it is not P7-with-launch-artifacts, the correct action is to leave the checkbox unchecked and return to the active `GOALS.md` unit._
