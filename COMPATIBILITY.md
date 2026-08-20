# Compatibility baseline — v0.3.46

`HARNESS_V1_PLAN.md` Phase 0 requires recording v0.3.46 behaviour as the baseline every later
phase must not break, and its exit gate requires that "existing shards open without
migration". This file is that record: what exists at v0.3.46, verified against a real shard on
disk rather than read off the source.

Everything below is a **promise to existing users**, not a description of intent. A change that
violates any of it requires an RFC (`GOVERNANCE.md`) and an explicit, reversible migration.

## Verified at v0.3.46

Observed directly from a live install (`icarus status`, and the on-disk shard directory):

```
icarus v0.3.46   dim: 1024
HIVEMIND   connected
Signing    ML-DSA-65 (FIPS 204), on
Audit      SLH-DSA-SHA2-128s (FIPS 205), on
```

## The shard file set

One directory per tenant under `<dataRoot>/<org>/`. Observed file set:

| File | Written by | Guarantee |
|---|---|---|
| `shard.amr` | `crate/mseg` | The structured slot records. **The slot format is frozen** — it survived production contact without a field change and is the actual contract. |
| `shard.vec` | `crate/mseg` | Parallel raw-f32 vector array, one entry per slot. |
| `shard.txt` | `crate/mneme-bm25` | Lexical/BM25 index. |
| `shard.edg` | `crate/mseg` | Typed relationship edges. |
| `shard.mnsw` | `crate/mnsw-index` | Serialized usearch HNSW graph, built lazily. |
| `shard.lock` | `crate/mseg` | Empty; an `flock(LOCK_EX\|LOCK_NB)` on its descriptor is the lock. |
| `audit.jsonl` | Node layer | Append-only SLH-DSA-signed audit log. Present once HIVEMIND is connected. |
| `signatures.jsonl` | Node layer | Per-slot ML-DSA-65 signatures. Same condition. |

Notes that are part of the baseline, not incidental:

- `shard.amr` and `shard.vec` are **pre-allocated sparse files** (1024 slots up front, via
  `set_len`). Logical size therefore exceeds real disk usage on a fresh org — any "storage
  used" figure must read allocated blocks, not `st_size`.
- The lock is deliberately `flock`, not POSIX `fcntl` record locking, so a second open **in
  the same process** also conflicts. That is a stronger guarantee than the original spec and
  is relied upon.
- Embedding dimension is **1024** (`bge-m3`).

## Two dataRoot locations

- Global: `~/.icarus/data/<org>/`
- Repo-local: `<repo>/.icarus/data/<org>/`, discovered by walking up from the working
  directory and **stopping at the repository root**. A repo-local shard wins when both exist.

Stopping at the root is a tenant-isolation guarantee: an unrelated ancestor directory's
`.icarus/` must never be adopted. Covered by test.

## Org naming

An org name derived from a folder is `[a-zA-Z0-9_-]{1,64}`, lowercased, with runs of invalid
characters collapsed to a single `-`, falling back to `default`. Every agent adapter
(CLAUDE.md, AGENTS.md, the Cursor rule) must derive the **same** name for the same folder — if
they diverge, three agents in one repository silently write to three different shards. Covered
by test.

## Surfaces that must keep working

- **CLI** — `ingest, recall, save, status, compact, train-pq, connect, connect-embeddings,
  connect-llm, setup, mcp (install|serve), daemon, prune, hook session-end, graph
  (build|status|query), skill, verify, audit, update`.
- **TUI** — bare `icarus` on a TTY; `/ingest /recall /save /status /org /create /delete /copy
  /setup /graph /connect /update /help /quit` plus the memory-chat surface (`/chat`, `/model`,
  `/skill`, `/llm-api`, `/thinking`).
- **MCP** — 22 tools (`icarus_status`, `icarus_ingest`, `icarus_recall`, `icarus_save`,
  `icarus_train_pq`, `icarus_compact`, `icarus_save_memory`, `icarus_get_memory`,
  `icarus_list_memories`, `icarus_update_memory`, `icarus_delete_memory`,
  `icarus_save_conversation`, `icarus_traverse_graph`, `icarus_ingest_code`,
  `icarus_recall_bugs`, `icarus_log_decision`, `icarus_track_refactor`,
  `icarus_test_coverage`, `icarus_why_code`, `icarus_graph_build`, `icarus_graph_status`,
  `icarus_graph_query`).

## Behavioural guarantees

- **Recall is local, always.** It never queries a shared server-side recall index. This is not
  a preference: a real cross-tenant leak was found in a server recall path — queries scoped to
  one org returned other tenants' private content — and that path was removed. HIVEMIND, when
  connected, contributes only query embeddings and cross-encoder reranking on top of locally
  retrieved candidates.
- **Local-only by default.** `save` writes locally; `--cloud` is an explicit opt-in.
- **Works with no provider configured.** With no embedding provider, ingest and recall run
  lexical-only (BM25). That is a supported mode, not an error.
- **No subscription reuse, ever.** ICARUS does not read or reuse a coding agent's login
  session to route model calls through a user's Free/Pro/Max quota. Provider terms prohibit
  third-party tools from doing this. It is a permanent product boundary.
- **Signing on by default**, with keys generated transparently at `~/.icarus/keys` (0600).

## Exit codes (established in Phase 0.3)

| Situation | Code |
|---|---|
| Success | 0 |
| Explicit help (`help`, `--help`, `-h`), or bare invocation under a pipe | 0 |
| `--version` / `-v` / `version` (prints only the bare version) | 0 |
| Ran and failed | 1 |
| Unknown subcommand (wrong usage) | 2 |

## Known baseline defects

Recorded so they are not mistaken for later regressions:

- `chunk()` splits on **word** count, not characters, and discards any resulting piece of 20
  characters or fewer. A very short `save`/`ingest` can therefore report success while storing
  nothing. Pinned by test and tracked for a fix.
- `icarus-linux-arm64` and `icarus-win32-x64` prebuilt binaries do not exist; `install.sh`
  requests them, gets a 404, and falls back to a source build. Windows additionally has no
  shard-lock implementation (`mseg` fails loudly on non-unix rather than running unlocked).
  Full platform coverage is Phase 8.
