# Changelog

Notable changes to mneme / the `.amr` format. Pre-1.0: pin a commit or a published
`singulance-amr` version.

The **format is frozen** — the 202-byte slot in `SPEC.md` has not changed a field since the
RFC, and a spec-lock test enforces it. Entries below are engine, binding and tooling.

## Unreleased

### Added
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
