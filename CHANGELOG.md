# Changelog

Notable changes to mneme / the `.amr` format. Pre-1.0: pin a commit or a published
`singulance-amr` version.

The **format is frozen** — the 202-byte slot in `SPEC.md` has not changed a field since the
RFC, and a spec-lock test enforces it. Entries below are engine, binding and tooling.

## Unreleased

### Added
- **Python binding** (`mneme-python`, pyo3 + maturin, `abi3-py38` — one wheel across Python
  3.8-3.13+). Same engine and on-disk format the Node binding wraps, not a reimplementation:
  open, insert (plain and layered), vector recall (plain and layer-filtered), native BM25,
  typed graph edges/traversal, lifecycle (delete, flush, live_count). Verified with the SAME
  corpus and query as the Node binding's own test — both bindings produced the identical BM25
  score (0.9145), proving they share one scoring implementation rather than two that could
  drift. 12 pytest tests, all passing, run from a real built wheel (`maturin develop --release`),
  not mocked. `extension-module` is deliberately NOT a default Cargo feature — adding it broke
  `cargo test --workspace` for the whole repo when first tried; maturin supplies it at build
  time instead, so plain cargo commands keep working across the workspace.
- **`mneme-bm25`**: the BM25 scoring module extracted into its own crate, shared by both
  bindings. Written once as a copy inside `mneme-node`, immediately duplicated into
  `mneme-python` — recognized as the same drift risk documented elsewhere for this codebase
  (independently-maintained copies of one rule), and extracted before it could diverge.
- **LangChain and LlamaIndex integrations** (`mneme_integrations`, optional extras
  `mneme-python[langchain]` / `[llamaindex]`, lazy-imported). `MnemeRetriever` implements
  LangChain's `BaseRetriever`; `MnemeVectorStore` implements LlamaIndex's
  `BasePydanticVectorStore` (`add`/`query`/`delete`). Both tested against the real framework
  classes with a real store, not mocks — verified `retriever.invoke()` and
  `vector_store.query()` end to end, including delete. Known limitation stated in the
  LlamaIndex adapter's own docs: `delete(ref_doc_id)` resolves through an in-memory id map that
  is not persisted across a process restart; deleting by the engine's own slot id always works.
- **Native BM25 lexical search** (`MnemeStore.bm25Search(query, topK)`). The engine previously had
  vector recall, graph edges and temporal operations but no lexical search of any kind. Real
  document-frequency/IDF statistics (standard non-negative Robertson/Sparck-Jones variant),
  language-neutral Unicode tokenization (no stemming, no stopword list — those are per-language
  and exactly the brittle logic this engine avoids elsewhere), 9 unit tests covering ranking
  correctness, length normalization, and query-term deduplication. Corpus-wide scan per call
  (same cost shape as this engine's existing JS-side lexical lanes); a persistent postings index
  for large corpora is a natural follow-up, not part of this change. Known limitation: `Hit` does
  not yet surface a record's layer, so results are not layer-filterable — stated in the method's
  doc comment rather than silently assumed away.
- **Docs for open-source use**: `CONTRIBUTING.md`, `SECURITY.md`, `docs/API.md` (full Node
  API reference generated from `index.d.ts`), `examples/quickstart.mjs`, this changelog.

### Fixed
- `crate/Cargo.toml` `repository` pointed at the private monorepo; now points at this
  repository.

## 2026-08-05 — bi-temporal graph layer + layered recall

### Added
- `crate/mseg/src/graph.rs` — typed adjacency and 2-hop traversal held in-slot.
- `insertLayered(text, vector, validFrom, layer)` and `recallLayer(query, topK, layer)` —
  one shard holds memory / evidence / cognitive layers, queried separately (`-1` = all).
- `traverseTyped`, `asOf`, `insertAt`, `update` — typed graph walk and bi-temporal
  point-in-time recall (transaction time vs valid time).
- `crate/mseg/src/bin/bench_graph.rs`, `bench_real.rs` — graph + real-embedding benches.
- `crate/mseg/tests/memory_engine_probe.rs` — engine probe suite.

## 2026-07-04 — P8 production hardening

### Added
- Native id→slot index (~24 B/record in Rust) — `findById` is O(1) with no JS-side Map.
- `rewriteText(slotId, text)` — in-place record-text mutation for metadata-only updates
  (tags, recall counters, supersession) without touching vector/edges/temporal stamps.
- `recordsPage(fromSlot, limit)` — streaming scan, O(page) JS heap instead of O(shard).

### Changed
- Removes the JS-heap scale wall: 1M memories seeded at ~100k/s with RSS flat ~190 MB.

## 2026-07-03 — npm packaging

### Changed
- npm package renamed `mneme-node` → **`singulance-amr`**, multi-platform prebuilt binaries
  via the release workflow (`npm install singulance-amr`, zero toolchain, Node ≥ 18).
- `index.d.ts` + README shipped in the package.

### Fixed
- CI: install the `g++` aarch64-linux cross-compiler (usearch is C++).

## 2026-07-02 — format rename

### Changed
- On-disk format renamed `.mseg` → **`.amr`** (magic `MNEME` → `AMR`). Layout unchanged.

### Fixed
- Async indexer deadlock on capacity growth; steady-state soak now passes.
