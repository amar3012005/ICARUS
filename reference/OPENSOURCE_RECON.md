# OPENSOURCE_RECON.md — mneme reuse map

**Status:** authoritative. This file is the standing answer to "is there an open-source way to do this?" for mneme.
**Scope rule:** mneme's innovation budget is the `.mseg` byte layout, the entity-bitmap AND filter, and the per-org PQ codebook + drift detection — **and nothing else**. Every other capability MUST be reused from a permissive-licensed crate listed below unless this file records why no reuse path exists.
**License rule:** mneme ships Apache-2.0. Only permissive (Apache-2.0 / MIT / BSD) dependencies are admissible in the runtime crate. Any GPL/AGPL/SSPL/BSL dependency is `AVOID` — no exceptions, including transitive. All 18 candidates below were license-checked; none are GPL/AGPL. The historical AGPL concern around Qdrant is moot: the Qdrant **core engine** is Apache-2.0 (they monetize via Cloud, not a license flip), so it is admissible as a *reference and benchmark target* — but never as a dependency (see verdict).

## How to use this file (enforced)

1. **Before authoring any new module/struct/fn**, find the capability in the table below. If a `REUSE` or `WRAP` row covers it, adopt that crate; do not hand-roll.
2. The `recon-check` CI gate (PR-body linter) FAILS the merge if a commit adds a new `.rs`/`.js` source file > 30 LOC without a `RECON:` block citing a crates.io/GitHub result **or** an explicit `RECON: no-reuse-found because <reason>`. This file is the canonical citation source.
3. Two mechanical allowlist/denylist asserts back the named-reuse mandates:
   - `grep -q '^usearch' Cargo.toml` MUST pass once P3 opens (HNSW is reused, not rebuilt).
   - The build FAILS if any file matching `src/**/*hnsw*` exceeds 150 LOC (i.e. it is more than a thin wrapper over `usearch`).
4. New ideas that this file marks `REFERENCE_ONLY`/`AVOID` or that are out of the P0-frozen scope go to `FUTURE.md`, never into the current phase.

Verdict legend: **REUSE** = take as a direct dependency. **WRAP** = take as a dependency but behind a thin mneme-owned safety/API layer. **REFERENCE_ONLY** = study the source/paper and port the math/pattern into a pure-Rust mneme module; do NOT take as a dependency. **AVOID** = architecturally or legally incompatible; do not use.

## Crate / library table

| Name | Lang | License | Purpose (one line) | Verdict | Key reason / boundary |
|------|------|---------|--------------------|---------|-----------------------|
| `usearch` (unum-cloud) | C++ core, official Rust crate | Apache-2.0 | Single-file HNSW ANN: graph index, scalar quant (f32/f16/bf16/**i8**/b1x8), filter callbacks during traversal, `save`/`load`/`view` (mmap-from-disk) | **REUSE** | The named do-not-rebuild-HNSW answer for P3. v2.25.x, actively maintained. Does **scalar** i8 quant, **NOT product quantization** — P4's per-org PQ is separate and BUILT. Keep mneme's append `.mseg` write-path physically separate from async `usearch` index build (kill-condition: HNSW rebuild-on-write). |
| `memmap2` | Rust | MIT OR Apache-2.0 | Cross-platform memory-mapped file IO (`Mmap`/`MmapMut`) | **WRAP** | The mmap plumbing under the single-mmap `.mseg` read. 255M+ downloads, MSRV 1.63. `Mmap::map` is `unsafe` (file mutation under an active map is UB) → wrap behind a thin mneme owner that controls the file lifecycle. Foundational from P1. |
| `zerocopy` (Google) | Rust | BSD-2 OR Apache-2.0 OR MIT | Zero-copy reinterpretation of byte ranges as `#[repr(C)]` structs (`FromBytes`/`IntoBytes`/`KnownLayout`/`Immutable`) | **REUSE** | Cast the fixed ~194B slot header off the mmap with bounds- and alignment-checked, no-copy reads. v0.8.x, MSRV 1.56. Preferred over `rkyv` because mneme controls and freezes the layout. |
| `lz4_flex` | Rust (pure) | MIT | Fastest pure-Rust LZ4 compress/decompress for the variable-length text blob `text_ptr` points to | **REUSE** | Pure Rust → clean napi cross-builds. Decompress 2+ GB/s; decompress only the winning rows after ANN, keeping the <5ms recall budget. Chosen over the C `lz4` crate to stay pure-Rust. |
| `rayon` | Rust | MIT OR Apache-2.0 | Data parallelism (`par_iter`) | **REUSE** | Parallelizes the P1 brute-force int8 cosine scan (near-free win vs a network hop to Qdrant), PQ k-means codebook training (P4), and the 2-hop BFS fan-out (P5). v1.11.x, ubiquitous. |
| `criterion` | Rust | Apache-2.0 OR MIT | Statistical benchmarking with confidence intervals | **REUSE** | Produces the **gate artifact** at P1/P3/P4/P6. Pair with `critcmp` for the `bench-no-regression` gate (fail if gated p50 regresses > 5% noise band). |
| `proptest` | Rust | MIT OR Apache-2.0 | Property-based / fuzz testing | **REUSE** | Round-trips the `.mseg` byte format (write→mmap→read), bitmap-AND correctness, bi-temporal range invariants, OOB safety on the mmap. Backbone of the P2 "100% green" gate and guards the frozen layout against regression. v1.9.x. |
| `napi-rs` (v3) | Rust → Node-API addon | MIT | Compile the Rust core into a Node native addon with `async fn` → JS Promise | **REUSE** | The named P6 bridge into HIVEMIND `core/src/ingestion/indexer.js`. Use **v3** (napi-v3.x). Expose a thin async API (`recall`/`ingest`/`delete`) so indexer.js call sites change minimally and the eval is apples-to-apples vs the Qdrant baseline. No node-gyp / hand-rolled FFI. |
| `faiss` (Meta) | C++ (+ `faiss-rs`) | MIT | Reference PQ: `ProductQuantizer.h`, IVF-PQ, OPQ, k-means codebook training, ADC distance | **REFERENCE_ONLY** | License is fine; do **not** take as a runtime dep. `faiss-rs` needs libfaiss + libfaiss_c (C++ compiler + BLAS + bindgen/LLVM) — heavy, fragile FFI that fights the pure-Rust + clean-napi goal and bloats the binary. **Study** `impl/ProductQuantizer.h` + arXiv:2401.08281 and port the encode/train/ADC math into a small pure-Rust module. |
| `Vq` (cogitatortech) | Rust (pure) | MIT/Apache-2.0 | Pure-Rust PQ/OPQ (per-subspace k-means codebooks, encode/decode) | **REFERENCE_ONLY** (→ `WRAP` if proven) | Best pure-Rust PQ head-start for P4. Verify maturity and recall against the strict >96% overlap gate before depending. If it passes the gate and exposes per-org codebook control, promote to `WRAP`; otherwise port the math. Targets the 32x compression: 128B pq_vector = 128 subspaces × 1 byte at m=128, k=256. |
| `ruvector-residual-vq` | Rust | Permissive (MIT/Apache-style) | Residual Vector Quantization (multi-codebook cascade, ADC, beam-search encode); ~64x compression; the scheme behind LanceDB's default compressor | **REFERENCE_ONLY** | RVQ keeps more recall than PQ's independent-subspace assumption, but mneme's frozen P0 fixes a **128B** `pq_vector` slot → RVQ is out of P0 scope. Logged in `FUTURE.md` as a P4+ codebook-quality upgrade. Study only; do not expand frozen scope. |
| `rkyv` | Rust | MIT (dual-permissive) | Zero-copy deserialization of arbitrary/nested/variable-length Rust types into an archived form | **REFERENCE_ONLY** | Heavier than needed for the **fixed** slot header — `zerocopy` is the better tool there. Consider only if a side region ever needs variable-length structured payloads beyond the LZ4 text blob. For the byte format itself, hand-rolled `#[repr(C)]` + `zerocopy` is more transparent and benchmarkable. |
| `zstd` (zstd-rs) | Rust bindings over C zstd | BSD / MIT (zstd is dual BSD + GPLv2 at the C layer) | Higher-ratio compression with dictionary pre-training (70–75% vs LZ4) | **REFERENCE_ONLY** | Decompress speed dominates the recall hot path, so LZ4 wins for per-slot text. The C layer's GPLv2-dual licensing plus the C dependency are extra reasons to avoid on the hot path. Keep only for a cold/archival tier or dictionary-trained corpus win → `FUTURE.md`. |
| `hnswlib` (nmslib) | C++ (header-only) | Apache-2.0 | Original standalone HNSW by Malkov (the HNSW paper author) | **REFERENCE_ONLY** | `usearch` already wraps the same algorithm with a maintained Rust crate, mmap view, quantization, and filtering that hnswlib lacks. Keep purely as a correctness/recall oracle when validating mneme's usearch integration and tuning M/ef. |
| `instant-distance` (InstantDomain) | Rust (pure) | Apache-2.0 OR MIT | Pure-Rust HNSW (Malkov–Yashunin) | **REFERENCE_ONLY** | Pure-Rust contingency if `usearch`'s FFI ever breaks the napi build — but it lacks mmap-view, i8 quant, and filter callbacks, all of which P3 needs. `hnsw_rs` and the `hnsw` crate are similar MIT pure-Rust fallbacks to keep in the back pocket. |
| `arroy` (Meilisearch) | Rust | MIT | Annoy-style ANN (random-projection trees) over LMDB | **AVOID** | License fine, architecture wrong: **tree-based not HNSW**, and it bundles its **own LMDB storage engine** — adopting it means adopting LMDB's layout instead of the `.mseg` format that *is* mneme. Its successor `hannoy` is HNSW-on-LMDB — same storage collision. Skip. |
| `lance` / `lancedb` | Rust core | Apache-2.0 | ML-native columnar format: IVF_PQ vector index, BM25, SQL filter, ACID versioning/time-travel on object storage | **REFERENCE_ONLY** | Closest "memory-as-files" peer. Strong reference for (1) IVF_PQ as built Rust PQ, (2) versioning/time-travel rhyming with mneme's bi-temporal P5, (3) columnar mmap layout. Adopting it means adopting Lance's format and surrendering the `.mseg` innovation. Use as a P7 benchmark baseline alongside Qdrant; do not depend. |
| `tantivy` (Quickwit) | Rust | MIT | Lucene-style full-text search (BM25, inverted index) | **REFERENCE_ONLY** | mneme's entity filter is an 8-byte bitmap AND'd inside the *same* mmap read — deliberately **not** an inverted index. Pulling tantivy adds a second storage engine and undercuts the single-mmap-read claim. Park in `FUTURE.md` for real BM25/keyword hybrid recall; borrow its roaring-bitmap posting-list tricks if `entity_bitmap` ever needs to exceed 64 entities. |
| `qdrant` internal crates (segment, quantization, payload-index) | Rust | Apache-2.0 (core engine) | The internals of the system mneme replaces | **REFERENCE_ONLY** | Not published as clean standalone libraries, and depending on the thing you replace defeats the purpose. **High-value reference**: study Qdrant's scalar/product quantization, segment mmap layout, and payload filtering, and use it as the **P1/P3/P6 latency + recall baseline mneme must beat**. Reference + benchmark target, never a dependency. |

### GPL/AGPL scan result

No candidate is GPL/AGPL/SSPL/BSL at the layer mneme would consume. The only adjacent traps surfaced and dispositioned:
- **zstd** C layer is dual BSD + GPLv2 — irrelevant because zstd is `REFERENCE_ONLY` and off the hot path; if ever revived (archival tier) use a permissive build path and document it here first.
- **Qdrant** historical AGPL worry — the **core engine is Apache-2.0**; admissible as reference/baseline, never a dependency.

## Per-phase reuse vs build (P0 → P7)

The discipline at every phase: **BUILD only the three things that ARE mneme** — the `.mseg` byte format/CRUD, the entity-bitmap AND filter, and the per-org PQ codebook + drift detection. **BUY everything else.**

### P0 — SPEC.md file-format RFC (frozen before any code)
- **Build:** the spec itself — the ~194B slot header `{id, flags, created_at, valid_from, text_ptr, pq_vector[128], entity_bitmap[8], adjacency[32]}` + LZ4-text layout, `FORMAT_VERSION`, and every gate threshold. Pure design; no library.
- **Reference (ideas only):** Lance's columnar layout, Qdrant's segment format, and the PQ paper (arXiv:2401.08281) to inform the design before freezing. **BUY-ideas, BUILD-spec.**
- **Exit artifact:** `SPEC.md` committed and frozen; `spec-lock` gate live (the `spec_matches_code` test will assert `format.rs` `FORMAT_VERSION` + offsets byte-match a fixture parsed from `SPEC.md`).

### P1 — Rust probe: raw format + brute-force int8 cosine scan
- **Gate:** beats Qdrant REST p50 latency at N=10k on **real HIVEMIND memories**.
- **Build:** the `.mseg` writer/reader; the brute-force int8 cosine scan (~20 lines once vectors are mmap'd).
- **Reuse:** `memmap2` (map the file, wrapped), `zerocopy` (cast the slot header off bytes), `rayon` (parallelize the scan), `lz4_flex` (text blob), `criterion` (the latency number that **is** the gate).

### P2 — production crate: format + CRUD + tests 100% green
- **Build:** the CRUD/format crate (mneme's core IP).
- **Reuse:** `proptest` for byte-format round-trips / bitmap-AND / temporal-range invariants, plus `cargo test`. Keep `memmap2` behind the thin safe owner from P1.
- **Gate tooling:** `cargo +nightly fuzz` over the `.mseg` reader + `cargo +nightly miri test -p mseg-format` for the unsafe mmap path.

### P3 — HNSW overlay + entity bitmap O(1) filter
- **Gate:** recall@10 < 5ms @ 1M, < 3% quality loss vs Qdrant float32.
- **Reuse (mandated):** `usearch` for the HNSW graph + i8 scalar quant + mmap view + filter-during-traversal. **Do not rebuild HNSW** (`recon-check` denylist enforces the 150-LOC wrapper cap; `Cargo.toml` allowlist asserts `usearch` present).
- **Build:** the `entity_bitmap[8B]` bitwise-AND filter and the glue keeping `usearch`'s index as an **overlay alongside the append-only `.mseg` write-path** — the append path may never synchronously trigger an index rebuild (`writepath-isolation` gate: banned-call-edge `append → rebuild_hnsw` + `append_p99_under_concurrent_rebuild` bench).
- **Reference only:** `hnswlib`, `instant-distance`.

### P4 — real Product Quantization + codebook drift detection
- **Gate:** recall@10 overlap > 96% vs float32.
- **Build:** the PQ — `usearch` does **not** do PQ (scalar i8 only). The per-org codebook + drift-detect/retrain is novel mneme work with no off-the-shelf equivalent. PQ is read-only on the hot path; centroid drift is detected and retrain is **enqueued**, never run inline (`writepath-isolation` gate covers `retrain_codebook` too).
- **Reference:** `faiss/impl/ProductQuantizer.h` + arXiv:2401.08281 for the math; evaluate the pure-Rust `Vq` crate as a head start (`WRAP` if it clears the 96% gate, else port). `rayon` parallelizes k-means training.
- **Future (out of frozen scope):** RVQ (`ruvector`) as a codebook-quality upgrade.

### P5 — bi-temporal + 2-hop adjacency BFS over mmap
- **Build:** everything on mneme's own format — temporal range scan over the fixed `created_at`/`valid_from` header fields and BFS over the `adjacency[32B]` pointers, all served from the same mmap. No external lib.
- **Reuse:** `rayon` to fan out the 2-hop expansion.
- **Reference only:** Lance's time-travel as a design rhyme.
- **Gate tooling:** re-run `cargo +nightly fuzz` + Miri over the now-temporal reader.

### P6 — napi-rs Node bindings + swap into HIVEMIND `core/src/ingestion/indexer.js`
- **Gate:** eval-harness ≥ Qdrant baseline + 72h soak clean. This is the **one** phase where heavyweight live-box verification returns.
- **Reuse (mandated):** `napi-rs` v3 with async/Promise.
- **Build:** a thin async API surface (`recall`/`ingest`/`delete`) matching `indexer.js` call sites so the eval is apples-to-apples.
- **Gate tooling:** `criterion` + the existing HIVEMIND eval-harness; `writepath-isolation` append-p99 bench under concurrent rebuild during the soak.

### P7 — arXiv paper + xMEM benchmark + OSS launch
- **Reuse:** `criterion` for rigorous numbers.
- **Benchmark against:** Qdrant (the baseline) **and** Lance (closest memory-as-files peer) for the paper.
- **Build:** the paper, the xMEM harness, and integrations.

## The reuse spine (six direct dependencies)

`usearch` (HNSW + i8 quant + mmap view + filter) · `memmap2` (mmap, wrapped) · `zerocopy` (fixed-header cast) · `lz4_flex` (text compression) · `napi-rs` v3 (Node bridge) · plus `rayon` / `criterion` / `proptest` (parallelism / gate benchmarks / format property tests). Everything else in the table is `REFERENCE_ONLY` or `AVOID`. If a future need is not covered by this spine, add a row here with a verdict **before** writing code — do not let a new dependency or a hand-rolled module enter the tree silently.
