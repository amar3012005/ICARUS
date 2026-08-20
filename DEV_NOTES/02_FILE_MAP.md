# File map

Everything below is real — read directly from the actual files in this repo
at the time this was written (v0.3.33). Line counts are from `wc -l` on this
exact checkout; they will drift as the code evolves, treat them as "rough
sense of size", not a contract.

## `crate/mneme-node/` — the Node layer (all plain JS, Bun-compiled for release)

| File | Lines | What it is |
|---|---|---|
| `cli-lib.js` | ~1990 | **The shared brain.** Config load/save, embeddings, ingest/recall/save primitives, signing (ML-DSA-65) + audit (SLH-DSA), structured-memory CRUD + typed-edge graph traversal, HIVEMIND OAuth + cloud ingest/save, self-update, org lifecycle (`listOrgsWithMeta`, `deleteOrgShard`, `initRepoShard`, `repoOrgName`, `findRepoIcarusDataRoot`), the native folder/file picker (`pickFolderNative`, JXA/osascript on macOS, zenity/kdialog on Linux), lock-aware store opening (`openStore`, with a `{retry: false}` fast-fail mode for read-only callers). `mneme-cli.js`, `tui.js`, and `mcp-serve.js` ALL `require()` this — it is the one place real logic should live. |
| `tui.js` | ~1000 | The interactive REPL (`icarus` with no subcommand). Hand-rolled raw-ANSI alt-screen TUI: fixed persistent hero/status box, scrolling transcript pane (real PageUp/PageDown/mouse-wheel scrollback via `state.scrollOffset`), bottom bordered input box with slash-command autocomplete. Owns `dispatch()` — the big `switch (cmd)` that implements every `/slash` command by calling into `cli-lib.js`. See `03_COMMANDS_REFERENCE.md` for the full command list. |
| `mneme-cli.js` | ~900 | One-shot, non-interactive subcommands (`icarus ingest/recall/save/status/...`) — for scripting/piping, where the raw-mode TUI can't run (`!process.stdin.isTTY` in `tui.js` fails loud and points here instead of hanging). Also the actual entrypoint that decides "bare `icarus`, real TTY → launch tui.js; anything else → dispatch a subcommand here." |
| `mcp-serve.js` | ~560 | The MCP server (`icarus mcp serve` / `icarus mcp-serve`) — a stdio JSON-RPC process an agent (Claude Code/Codex/Cursor) launches itself, one per agent session. Exposes 22 tools (`icarus_status`, `icarus_ingest`, `icarus_recall`, `icarus_save`, `icarus_save_memory`, `icarus_get_memory`, `icarus_list_memories`, `icarus_update_memory`, `icarus_delete_memory`, `icarus_save_conversation`, `icarus_traverse_graph`, `icarus_ingest_code`, `icarus_recall_bugs`, `icarus_log_decision`, `icarus_track_refactor`, `icarus_test_coverage`, `icarus_why_code`, `icarus_graph_build`, `icarus_graph_status`, `icarus_graph_query`, `icarus_train_pq`, `icarus_compact`). Long-lived — holds shard handles open via `cli-lib.js`'s `_storeCache` for its entire session (see `01_ARCHITECTURE.md` and `06_KNOWN_GOTCHAS.md`). |
| `mcp-install.js` | ~480 | Everything `/setup` and `icarus mcp install` do: per-agent installers (`AGENT_INSTALLERS = { claude, codex, cursor }`, each with an `mcp` step writing that agent's MCP config, an optional `global` step for standing/system instructions, and a `project` step writing that repo's own instruction file — `CLAUDE.md`/`AGENTS.md`/a `.cursor` rule — with the repo's derived org name baked in). `installClaudeCode()` writes `~/.claude.json`'s `mcpServers.icarus`; `installCursor()` writes `~/.cursor/mcp.json`. Also detection/removal (`detectRemovable`, `removeAll`) for `icarus mcp uninstall`. |
| `graph-native.js` | ~430 | ICARUS's own native symbol/call-graph indexer (`/graph build|status|query`) — Tree-sitter (via web-tree-sitter/WASM, deliberately NOT the native tree-sitter bindings, whose per-grammar native ABI versions conflict with each other) + better-sqlite3, no Python dependency. Scope: JS/TS + Rust, nodes + call/import edges + query (`callers_of`/`callees_of`/`imports_of`/`find`) — not a full communities/flows/visualize suite. |
| `graph.js` | 36 | Thin CLI-flag parser/dispatcher for `icarus graph <build\|status\|query>`, delegates to `graph-native.js`. |
| `theme.js` | ~100 | Zero-dependency truecolor ANSI theme (24-bit `\x1b[38;2;r;g;bm`), ported from grok-build's own GrokNight palette. Degrades automatically (`NO_COLOR`, non-TTY, `TERM=dumb`). Exports the `c.*` helpers (`c.dim`, `c.path`, `c.success`, `c.command`, …) used everywhere for consistent coloring, plus `heading`/`ok`/`err`/`bullet`/`spinnerFrame`. |
| `daemon.js` | ~190 | An OPTIONAL persistent local HTTP service (`icarus daemon`) — a shared long-running process multiple tools could talk to instead of each spawning their own short-lived `icarus`. Deliberately distinct from `mcp-serve.js` (stdio, one per agent session) — this is a plain HTTP server on a local port, calling straight into `cli-lib.js`. Foundational/optional, not required for normal CLI/TUI/MCP usage. |
| `native.js` | 66 | Resolves and loads the compiled Rust addon: tries a local build first (`singulance-amr.<platform-triple>.node`, then bare `singulance-amr.node`), falls back to the per-platform npm package. `triple()` maps `process.platform`/`process.arch` to napi's naming convention (`darwin-arm64`, `linux-x64-gnu`, `win32-x64-msvc`, …). |
| `index.js` | 71 | `MnemeVectorStore` — a drop-in replacement for HIVEMIND's own `QdrantVectorStore` interface (`upsert(collection, points)` / `search(collection, vector, topK)`), backed by the native `MnemeStore` addon instead of a real Qdrant server. One shard per "collection". This is what lets HIVEMIND's `core/src/ingestion/indexer.js` switch backends with zero call-site changes. |
| `mcp-install.js`, `mcp-serve.js` | — | (described above) |
| `eval_mneme.js`, `soak.js`, `test_wrapper.js` | 65 / 109 / 22 | Dev-only harnesses: `eval_mneme.js` runs recall-quality eval passes; `soak.js` is the concurrent-load soak test that originally caught the real reserve-guard segfault fixed in the HNSW indexing path (see `05_SESSION_LOG.md`'s P6 gate); `test_wrapper.js` is a tiny helper for ad-hoc in-repo tests. None of these ship in the compiled binary's actual code path — they're maintainer tooling. |

## Rust crates (`crate/*`, compiled via `napi build` into the one addon `mneme-node` loads)

| Crate | Owns |
|---|---|
| `mseg` | `Shard`/`Segment` — the actual `.amr`/`.vec` file format, `flock`-based locking (`shard.rs`), slot insert/get/delete/update/compact, the id→slot index. |
| `mseg-format` | Shared wire types/error enum (`MsegError`) used by `mseg` and callers. |
| `mnsw-index` | The usearch HNSW overlay (`shard.mnsw`) — approximate nearest-neighbor recall on top of the raw vectors. |
| `mpq` | Product Quantization codebooks — `train_pq()`/`recall_pq()`, the 128-byte `vector_pq` field inside each `.amr` slot (32× compression vs. the raw 1024-dim f32 vector). |
| `mneme-bm25` | Lexical/BM25 index (`shard.txt`) — the fallback/complement to vector recall when no embedding provider is configured. |
| `mneme-node` | The napi binding crate itself — `src/lib.rs`'s `#[napi] MnemeStore`, the ONE place Rust meets JS. |
| `mneme-probe` | A standalone Rust-only diagnostic/benchmark binary against the core engine, independent of the Node binding. |
| `mneme-python` | A parallel Python binding (maturin-built) — same core engine, different host language; not part of the Node/TUI/MCP path described in this handoff, but shares the exact same `.amr` file format. |

## Top-level docs (already in the repo, NOT this folder)

`README.md`, `INSTRUCTIONS.md`, `RELEASE.md`, `CHANGELOG.md`, `ROADMAP.md`,
`LIMITATIONS.md`, `FUTURE.md`, `BENCHMARKS.md`, `GLOBAL_PLAN.md`,
`CONTRIBUTING.md` — these are the PUBLIC docs, already maintained, already
git-tracked. This `DEV_NOTES/` folder is deliberately separate and
git-ignored: it's allowed to be blunter, more "here's exactly what broke and
why" than a public README should be.

## `install.sh` (repo root)

The published installer (`curl -fsSL .../install.sh | bash`). Tries the
prebuilt-binary path first (`try_binary_install()` — downloads
`icarus-<os>-<arch>` from the latest GitHub release, sanity-checks it with
a real `icarus status` invocation before committing to it), falls back to a
full source build (`ensure_toolchain` → `fetch_src` → `build_addon` →
`install_cli`) on any platform without a prebuilt asset or if the download
fails. `ensure_path()` appends the install dir to the right shell rc file
based on `$SHELL` (not `$BASH_VERSION` — a real fixed bug, since `curl | bash`
always runs the script itself under bash regardless of the user's actual
login shell). `guided_setup()` walks through MCP registration + LLM/embedding
provider + HIVEMIND connection right after install, reading `/dev/tty`
directly (not stdin) so it still works under a `curl | bash` pipe.
