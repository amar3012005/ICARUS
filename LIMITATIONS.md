# Limitations, honestly

Every item here is real and currently true. This file exists so nobody discovers these the hard
way in production — if you hit something not listed here, please open an issue.

## Scale

- **~1M memories/tenant is comfortable; ~10M is a wall.** `usearch` (the HNSW backend) holds f32
  vectors in RAM — ~41GB at 10M×1024-dim. `MNEME_HNSW_QUANT=i8` cuts that 4x (~0.5% recall cost)
  and is one env var away, but not on by default. Full PQ (32x) is implemented and wired
  (`recall_pq`) but not the default at any scale — see `BENCHMARKS.md`'s PQ-vs-HNSW table for why.
- **PQ is not a universal upgrade over HNSW.** It builds faster always, queries faster only on
  small/medium shards. Above ~50-100k vectors, HNSW wins query latency at equal recall. Measure
  your own shard size before choosing one over the other — `icarus_train_pq`'s own tool
  description (in the MCP server) says the same thing to an agent calling it directly.

## Durability / operations

- **Compaction is not automatic in every deployment path.** The native `compact()` call exists and
  a scheduler exists for the HIVEMIND-integrated deployment (`shard-maintenance.js`), but a plain
  `MnemeStore`/`MnemeVectorStore` embedding used directly in your own app will accumulate dead
  bytes from deletes/rewrites until *you* call `.compact()` on a schedule.
- **No built-in backup/replication for the raw engine.** Shard snapshot/restore exists for the
  HIVEMIND integration (`shard-backup.js`) but is not part of the core `mneme-node`/`mneme-python`
  packages. If you embed the engine directly, back up the shard directory yourself (flush first,
  then a synchronous copy — see that file's own comments for why sync matters).
- **Multi-writer safety is per-open, not global.** A shard takes an exclusive `flock` for the
  lifetime of the open handle. Two processes opening the same shard is a bug in the caller (you'll
  get a clear "shard is locked" error), not something the format arbitrates.

## Security

- **No encryption at rest.** `.amr` files are plain — filesystem access is memory access. Use
  disk/volume encryption; shard files are created `0600` in a `0700` dir by reference tooling, but
  that's a permission, not a cipher.
- **No access control in the format.** Tenant isolation is "one shard per tenant," enforced by
  whatever opens the file, not by the file itself.
- **PQC signing (in the HIVEMIND integration, not the open-source engine) is fail-open.** If
  signing keys are absent, writes proceed unsigned rather than failing — an availability choice,
  documented in that integration's own security notes, not applicable to the standalone engine.

## Platform coverage

- **Single-binary install (`curl | bash`, zero Node/Rust/npm) only exists for linux-x64 and
  darwin-arm64.** darwin-x64, linux-arm64, and Windows fall back to the source-build path (needs
  Node ≥18 + git; Rust auto-installs via rustup). Real, not a placeholder — just not built yet.
- **`mneme-python`'s PQ/ADC methods (`train_pq`/`recall_pq`) exist and are tested**, but the
  MCP server and CLI `mcp install` auto-registration are Node-only today — no Python MCP server.

## Lexical search (BM25)

- **Not currently layer-filterable** (0=memory/1=evidence/2=cognitive) — the underlying `Hit`
  type doesn't surface a record's layer back out yet. Every BM25 hit across all layers, always.
- **No persistent postings index.** It's a real IDF-weighted corpus-wide scan, correct and fast at
  the scales this repo targets, but a dedicated index for very large corpora doesn't exist yet.

## Project maturity

- **Pre-1.0.** Fixes land on `main`; no backported release branches. Pin a commit or a published
  version and read `CHANGELOG.md` before upgrading.
- **CI is currently broken for reasons unrelated to code health** — a billing issue on the
  maintainer's GitHub account blocks all Actions runs (visible in the Actions tab, not hidden).
  Every change in this repo is still verified locally (`cargo test --workspace`,
  `cargo clippy -- -D warnings`, and for anything touching recall, a real measured benchmark) before
  merge — CI would catch regressions automatically going forward once unblocked, it doesn't
  currently.
