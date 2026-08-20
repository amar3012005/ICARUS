# Commands reference

Three surfaces, one shared implementation (`cli-lib.js`). This is the real,
current list — pulled directly from `mneme-cli.js`'s dispatch switch and
`tui.js`'s `SLASH_COMMANDS`/`dispatch()` switch at the time of writing.

## 1. `icarus <subcommand>` — one-shot CLI (`mneme-cli.js`)

For scripting/piping/CI — no TTY needed. Bare `icarus` on a real TTY launches
the TUI instead (see section 2); on a non-TTY it fails loud pointing you here.

| Subcommand | Handler | Purpose |
|---|---|---|
| `icarus ingest <dir\|file> [--org] [--local] [--force] [--keep-cloud]` | `cmdIngest` | Ingest a folder/file. HIVEMIND-routed by default when connected (stateless extraction, segments mirror locally, cloud doc then deleted unless `--keep-cloud`); `--local` forces the local-only lexical/vector path. |
| `icarus recall <query> [--org] [--k] [--pq]` | `cmdRecall` | Local recall ALWAYS — real parallel hybrid (dense+lexical, RRF-merged), narrow-reranked if HIVEMIND connected. Never HIVEMIND's own shared recall index (a real cross-tenant leak was found and removed there — see `05_SESSION_LOG.md`... actually see `cli-lib.js`'s own doc comment above `hivemindRecallQuery`'s removal). |
| `icarus save <text> [--org] [--cloud]` | `cmdSave` | Local-only by default; `--cloud` also writes a real HIVEMIND memory (embedding + smart-router + contradiction checks). |
| `icarus status` | `cmdStatus` | Org shards + real memory/evidence/relationship counts + signing/audit state. |
| `icarus compact` | `cmdCompact` | Reclaim space from tombstoned/deleted slots. |
| `icarus train-pq` | `cmdTrainPq` | Train this shard's PQ codebook (enables `recall_pq`/128-byte compressed vectors). |
| `icarus connect [--token] [--oauth-only]` | `cmdConnect` | HIVEMIND account link — real browser OAuth (`GET /auth/cli/start`, like `gh auth login`) or a pasted token fallback. |
| `icarus connect-embeddings --key <k>` | `cmdConnectEmbeddings` | Wire an embedding provider (OpenRouter `bge-m3` by default). |
| `icarus connect-llm --provider <openrouter\|anthropic\|skip> --key <k>` | `cmdConnectLlm` | Wire an LLM provider for memory-generation/distillation. |
| `icarus setup` | `cmdSetup` | The CLI-level guided setup (distinct from `/setup` in the TUI, though they overlap — see section 2). |
| `icarus skill <...>` | `cmdSkill` | Extract/save/list skills (`.md` files under `~/.icarus/skills/`, also recallable as memories via `LAYER_SKILL`). |
| `icarus verify` | `cmdVerify` | Verify the ML-DSA signature chain over a shard's memories. |
| `icarus audit` | `cmdAudit` | Inspect/checkpoint the SLH-DSA audit log. |
| `icarus update` | `cmdUpdate` | Self-update: downloads + verifies the latest release, replaces the running binary in place. |
| `icarus mcp install [agent\|--all]` | `cmdMcpInstall` → `mcp-install.js` | Registers MCP + writes project instructions for one/all agents. |
| `icarus mcp serve` (alias `mcp-serve`) | `cmdMcpServe` → `mcp-serve.js` | Runs the stdio MCP server — this is the command Claude Code/Codex/Cursor actually launch as a child process. |
| `icarus daemon` | `cmdDaemon` → `daemon.js` | Runs the optional persistent local HTTP daemon. |
| `icarus prune` | `cmdPrune` | Removes stale/orphaned state. |
| `icarus hook session-end` | `cmdHookSessionEnd` | Reads Claude Code's `SessionEnd` JSON payload from stdin — a hook integration point. |
| `icarus graph build\|status\|query [--repo]` | → `graph.js`/`graph-native.js` | Native symbol/call graph. `query` needs `--kind <callers_of\|callees_of\|imports_of\|find> --name <symbol>`. |

## 2. TUI `/slash` commands (bare `icarus`, real TTY — `tui.js`'s `dispatch()`)

Anything typed WITHOUT a leading `/` is treated as `/recall <text>` against
the current org.

| Command | Usage | Notes |
|---|---|---|
| `/ingest` | `[dir\|file] [--org name] [--local] [--force] [--no-mirror] [--keep-cloud]` | No path → opens the OS's real native picker (macOS: JXA/`osascript` driving `NSOpenPanel`; Linux: `zenity`/`kdialog`). No `--org` → lists every existing org (real size + creation date), single keypress picks + confirms, before ingesting (added v0.3.30). |
| `/recall` | `<query> [--org name] [--k 5] [--pq]` | |
| `/save` | `<text> [--org name] [--cloud]` | |
| `/status` | (no args) | Read-only stats; on a genuinely locked org, fails INSTANTLY (`unavailable`) rather than the old ~6.7s retry-then-error (v0.3.33). |
| `/org` | `<name>` | Switches the session's default org (no args → prints current). |
| `/create` | `<org> <path>` | New org shard rooted at `<path>` (added v0.3.32) — same `initRepoShard()` mechanism `/setup` uses, just explicit name+path instead of always cwd+derived-name. |
| `/delete` | (no args) | Lists orgs, single-keypress pick, then a REAL double confirmation (two separate y/n prompts) before permanently deleting the shard directory. Refuses if a different live `icarus` process still holds it open (added v0.3.32). |
| `/copy` | `[n]` | Copies the last command's output (or the last `n` raw transcript lines) to the system clipboard — `pbcopy`/`wl-copy`/`xclip`/`xsel` (added v0.3.33). |
| `/setup` | `<claude\|codex\|cursor\|--all>` | Registers that agent's MCP server + writes its project instruction file + creates the repo shard, then offers to build the code graph, then explicitly tells you to RESTART that agent session — none of this takes effect in an already-running session (added v0.3.32). |
| `/graph` | `build\|status\|query [--repo <dir>]` | Same shape as the CLI's `icarus graph`. |
| `/connect` | (no args) | Browser sign-in to HIVEMIND. |
| `/update` | (no args) | Self-update (note: the CURRENTLY RUNNING session stays on the old build — quit and restart to use the new one). |
| `/help` | (no args) | Full command list. |
| `/quit` (or Ctrl+D) | | Exit. |

Non-command interactions: **PageUp/PageDown** and **mouse wheel** scroll the
transcript (v0.3.31); a new submitted command always snaps the view back to
the live tail. Tab autocompletes a partial `/command`. ↑/↓ browse input
history (when no autocomplete dropdown is showing).

## 3. MCP tools (`icarus mcp serve`, `mcp-serve.js`)

22 tools, all delegating to `cli-lib.js`:

`icarus_status`, `icarus_ingest`, `icarus_recall`, `icarus_save`,
`icarus_train_pq`, `icarus_compact` — core primitives, same semantics as the
CLI equivalents, `org` passed explicitly per call (no session-default
concept at this layer).

`icarus_save_memory`, `icarus_get_memory`, `icarus_list_memories`,
`icarus_update_memory`, `icarus_delete_memory`, `icarus_save_conversation`,
`icarus_traverse_graph` — structured-memory CRUD + typed-edge traversal
(`REL_TYPE`: update/extend/derive/contradict/partof/mentions).

`icarus_ingest_code`, `icarus_recall_bugs`, `icarus_log_decision`,
`icarus_track_refactor`, `icarus_test_coverage`, `icarus_why_code` — the
coding-agent-specific memory-discipline tools (what an agent calls after an
edit, before touching unfamiliar code, when logging an architectural choice).

`icarus_graph_build`, `icarus_graph_status`, `icarus_graph_query` — the
native code-graph, exposed as MCP tools so an agent calls it exactly like
`/graph`/`icarus graph` would, without shelling out.

## 4. Setup-time surfaces

- `icarus mcp install <claude\|codex\|cursor\|--all>` / TUI `/setup` — see
  `mcp-install.js` in `02_FILE_MAP.md`.
- `install.sh` (repo root) — the actual `curl \| bash` installer; see its own
  entry in `02_FILE_MAP.md`.
