# Changelog

Notable changes to mneme / the `.amr` format. Pre-1.0: pin a commit or a published
`singulance-amr` version.

The **format is frozen** — the 202-byte slot in `SPEC.md` has not changed a field since the
RFC, and a spec-lock test enforces it. Entries below are engine, binding and tooling.

## Unreleased

### Added
- **Mandatory agent-session bootstrap:** project instruction installers now require every new
  agent session to initialize a missing repository harness through the new native-backed
  `icarus_harness_init` MCP tool before search, planning, or edits. The rule is idempotent,
  blocks on initialization failure, then requires graph/context use for coding work.
- **Packaged graph-builder gate:** every compiled CLI artifact now builds and queries a
  JavaScript, TypeScript, and Rust fixture before release publication. This prevents a missing
  Tree-sitter WASM grammar from reaching macOS users as a runtime-only graph-build failure.
- **Provenance-bound learning capture:** a sealed task can now produce a receipt-derived memory
  candidate. A coding agent must explicitly review and approve a concise structured draft before
  ICARUS stores it in the local AMR shard with immutable task/capture provenance tags and an
  audit-chain receipt.
- **Release provenance attestations:** each published CLI platform binary is now accompanied by
  a GitHub/Sigstore build-provenance attestation bound to its exact digest, public source commit,
  and release workflow. Consumers can independently inspect it with
  `gh attestation verify <binary> -R amar3012005/ICARUS`; this is intentionally additive to the
  published SHA-256 sidecar, not a claim that offline signature verification is complete.
- **Signed SPDX SBOMs:** every published CLI platform binary now has a platform-named SPDX JSON
  release asset and a GitHub/Sigstore SBOM attestation bound to that binary. Consumers can verify
  the SBOM predicate with `gh attestation verify <binary> -R amar3012005/ICARUS --predicate-type
  https://spdx.dev/Document/v2.3`.
- **Update checksum enforcement:** `/update` now fetches the release `.sha256` sidecar and refuses
  a missing, ambiguous, wrong-platform, or mismatched digest before executing or atomically
  replacing the current binary.
- **Rollback-safe first install/update:** the `install.sh` binary path now retains one
  last-known-good executable, restores it after an interrupted handoff, and restores it
  immediately if the final candidate move fails. This is verified in an isolated temporary
  ICARUS home; it never operates on a developer's real installation during tests.
- **Rust atomic-snapshot interruption regression:** a feature-gated child-process test now exits
  after the snapshot candidate is fsync'd and atomically renamed, before directory fsync returns.
  The parent proves the post-interruption snapshot remains complete JSON and can be safely
  rewritten. This is process-crash coverage, not a claim to emulate physical power loss.
- **Managed-agent conformance process:** public native-addon CI now launches a disposable fake
  Claude-compatible process through the real CLI, Rust task lifecycle, documented pre/post hooks,
  path authorization, scope reconciliation, and verification handoff. It is evidence for the
  compatibility path only, not a certification claim for Claude or Codex.
- **Independent binary and MCP acceptance gates:** normal public CI now builds the Rust addon
  and drives the real MCP stdio process through local evidence ingest, structured memory save,
  lexical recall, and get-by-ID against a disposable shard with no network or credentials. A
  separate macOS/Linux job compiles the Bun executable outside the release workflow, then proves
  that the resulting binary can open its embedded native shard, save a memory, and recall it.
- **Artifact-evidence containment:** Rust now validates artifact criteria through the managed
  workspace containment check before probing existence. An in-repository symlink to a path
  outside the checkout cannot create a criterion receipt or be used as sealing evidence.
- **NUL-delimited Git scope proofs:** Rust now derives changed-path lists for checkpoints,
  current-workspace reconciliation, and sealing from `git status --porcelain=v1 -z`, including
  both sides of renames/copies. A forbidden source cannot be hidden by renaming it to an allowed
  destination, and whitespace/newline filenames are never reinterpreted by line parsing.
- **Rust-owned current-workspace scope reconciliation:** managed runs now snapshot only the
  hashes of pre-existing dirty/untracked Git entries at launch, then compare the post-run delta
  in Rust. Existing user work remains untouched; a newly changed out-of-contract path is
  durably recorded and blocks lifecycle advancement before verification or sealing. The Node
  CLI only displays the native result. Non-Git current workspaces explicitly record that this
  scope proof is unavailable and remain compatibility-only.
- **Rust-owned managed-run wall-time budgets:** a task contract may set
  `budgets.wall_time_minutes` (1–1,440). Rust validates and fixes the deadline in the prepared
  execution; the launcher only terminates the child at that deadline, records the lifecycle
  boundary, and blocks the task with a durable checkpoint. An expired deadline also rejects a
  new adapter start or verification handoff, so Node cannot extend it.
- **Managed Claude completion gate:** an executing managed task must explicitly hand off to
  Rust-owned verification before Claude's documented `Stop` hook can end the session. The
  handoff is audited and does not claim successful verification or permit sealing; current
  ICARUS receipts remain required.
- **Claude managed-run evidence hooks:** task-scoped Claude settings now capture completed
  `Edit`/`Write` calls (`PostToolUse`) and stop requests (`Stop`) in ICARUS's Rust-owned,
  tamper-evident audit chain. Pre-action authorization remains the only blocking hook; post and
  stop receipts are deliberately observational and do not falsely claim verification, sealing,
  or full command interception.
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
- **Windows release checksum:** the cross-platform artifact job now hashes with Node's built-in
  crypto instead of macOS/Linux-only `shasum`, so the Windows binary can reach publication.
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
