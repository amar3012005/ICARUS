# Architecture

## Layers, top to bottom

```
┌─────────────────────────────────────────────────────────────────┐
│ User-facing surfaces (all in crate/mneme-node/, plain Node/Bun)  │
│                                                                   │
│  mneme-cli.js   tui.js          mcp-serve.js      mcp-install.js │
│  (one-shot      (interactive    (MCP server:      (writes MCP    │
│   subcommands)   REPL, no args)  22 tools over      config +      │
│                                   stdio)            project        │
│                                                      instructions) │
│         \            |                |                  |        │
│          \___________|________________|__________________|        │
│                          all call into                             │
│                       cli-lib.js (shared logic)                    │
│                              |                                     │
│                        index.js / native.js                        │
│                     (napi addon loader + MnemeVectorStore           │
│                      drop-in-for-Qdrant wrapper)                    │
│                              |                                     │
│                    crate/mneme-node/src/lib.rs                     │
│                     (#[napi] MnemeStore — the actual                │
│                      Rust<->JS boundary)                            │
│                              |                                     │
│         ┌────────────────────┼────────────────────┐                │
│         |                    |                     |               │
│    crate/mseg          crate/mnsw-index        crate/mpq            │
│  (Shard/Segment:        (usearch HNSW           (Product            │
│   the .amr slot          overlay for             Quantization       │
│   format, flock,         approximate             codebooks —        │
│   mmap I/O)               recall)                 vector_pq field)  │
│                                                                     │
│                    crate/mneme-bm25 (lexical/BM25 index, .txt)      │
└─────────────────────────────────────────────────────────────────┘
```

## The shard — one directory per tenant

`data/<org>/` holds (see `crate/mseg/src/shard.rs`'s own top-of-file doc
comment — the file-SET design has been the spec since day one, not a later
compromise):

| File | Written by | What it is |
|---|---|---|
| `shard.amr` | `crate/mseg` (`Segment`) | The 202-byte-per-slot structured record format (frozen since the v1 RFC — see `06_KNOWN_GOTCHAS.md`). Header + `INITIAL_SLOTS` (1024) capacity, pre-allocated via `set_len()` → genuinely SPARSE on APFS/most filesystems. |
| `shard.vec` | `crate/mseg` | Parallel raw f32 vector array, one entry per slot, same 1024-slot pre-allocated capacity. Also sparse until written. |
| `shard.txt` | `crate/mneme-bm25` | Lexical/BM25 inverted index over the same slots. |
| `shard.edg` | `crate/mseg` | Typed relationship edges (`REL_TYPE`: Mentions/Updates/Derives/Contradicts/PartOf/Extends). |
| `shard.mnsw` | `crate/mnsw-index` | Serialized usearch HNSW graph, built lazily via `enable_hnsw()`. |
| `shard.lock` | `crate/mseg` | Empty file; existence + an `flock(LOCK_EX\|LOCK_NB)` on its fd is the ONLY thing that matters (see `06_KNOWN_GOTCHAS.md` for the flock-vs-fcntl reasoning). |
| `audit.jsonl` | `cli-lib.js` (Node layer, NOT the Rust core) | Append-only SLH-DSA-signed audit log. Only appears once HIVEMIND is connected. |
| `signatures.jsonl` | `cli-lib.js` | Per-slot ML-DSA-65 signatures. Also HIVEMIND-connected-only. |

Two more sibling concepts worth knowing:

- **Two possible `dataRoot`s.** Global: `~/.icarus/data/<org>/`. Per-repo:
  `<repo>/.icarus/data/<org>/`, auto-detected by `findRepoIcarusDataRoot()`
  (`cli-lib.js`) walking UP from cwd, stopping at the first `.git` it
  crosses. Per-repo wins when both exist. `/setup` and `/create` are the two
  ways a per-repo shard gets created (`initRepoShard()`).
- **`_storeCache`** (`cli-lib.js`, module-level `Map`): one open `MnemeStore`
  handle is cached per `${dataRoot}::${org}` key, per PROCESS. This is why a
  long-lived process (the TUI, or `mcp-serve`) holds an org's flock for its
  ENTIRE lifetime once it's touched that org once — by design (re-opening on
  every call would be wasteful AND, per a real bug hit early on, would
  self-collide within the same process since `flock` — unlike `fcntl` locks —
  also blocks a second open file description in the SAME process). See
  `06_KNOWN_GOTCHAS.md` for the exact consequence (why `/status` used to hang).

## Why the napi binding exists at all

`crate/mneme-node/src/lib.rs` is a `#[napi] pub struct MnemeStore` — every
public method on it (`insert`, `recall`, `recall_pq`, `delete`, `records_page`,
`bm25_search`, `slot_edges`, `compact`, `flush`, `live_count`, …) is a
`#[napi]` fn, auto-bound to JS by `napi-rs`. It's built via `npx napi build
--release` inside `crate/mneme-node/`, producing a platform-triple-named
`.node` file (e.g. `singulance-amr.node` — the napi package name, NOT
"mneme", a real gotcha the install script's own comment calls out: "napi
build names the addon from package.json's napi.name, not mneme — glob for
whatever .node napi actually produced instead of hardcoding a name that was
never right"). `native.js` is the resolver that finds and loads it.

## Why there's a `cli-lib.js` at all

Before it existed, the CLI and the MCP server had two separate copies of
ingest/recall/embedding logic that drifted apart (a real regression cited in
`cli-lib.js`'s own top comment: "the flag-parsing regression earlier in this
repo's history — one path fixed, the other forgotten"). Now `mneme-cli.js`,
`tui.js`, and `mcp-serve.js` all `require('./cli-lib.js')` and share the exact
same functions. If you add a new capability, it almost always belongs in
`cli-lib.js`, with all THREE surfaces calling it — not duplicated three ways.

## Why the TUI is hand-rolled raw ANSI, not a library

`tui.js`'s own top comment: `blessed` (the obvious npm choice) uses dynamic
`require()` internally that Bun's `bun build --compile` bundler can't
statically resolve, so it crashes at runtime inside the single-binary
distribution format ("Cannot find module './widgets/node'"). Since
single-binary distribution (no Node/npm required on the target machine) is
the actual shipped product, `tui.js` reimplements just the needed layout shape
(fixed top bar / scrolling content / bottom input box) directly over raw ANSI
escapes, with zero dynamic requires anywhere in its own code.

## Distribution: source build vs. prebuilt binary

`install.sh` tries a prebuilt binary first (`icarus-<os>-<arch>` from GitHub
Releases — the ONLY thing `bun build --compile` on a maintainer's machine
needs to produce), falling back to source build (clone + `npm install` +
`napi build` + a thin `#!/usr/bin/env bash exec node mneme-cli.js "$@"`
wrapper) only on unsupported platforms or if the download fails. The
compiled binary bundles the Rust addon AND a full Node/Bun runtime — nothing
external needed on the end-user's machine at all.
