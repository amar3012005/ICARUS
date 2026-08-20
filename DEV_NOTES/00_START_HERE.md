# ICARUS dev handoff — start here

This folder is a **git-ignored** developer handoff written for whoever picks up
ICARUS development next. It is not part of the shipped product, not linked from
the README, and never gets committed (see `.gitignore` — `DEV_NOTES/` is
excluded). It exists purely so a new agent/session can get productive in one
read instead of re-deriving everything from source.

Companion files in this folder:

- `01_ARCHITECTURE.md` — the whole system, layer by layer (Rust core → napi
  binding → Node CLI/TUI/MCP), and how the pieces actually talk to each other.
- `02_FILE_MAP.md` — every file that matters, one by one: what it is, its
  format if it's a data file, what functions/exports it holds if it's code,
  and how it's actually used.
- `03_COMMANDS_REFERENCE.md` — every CLI subcommand, every TUI `/slash`
  command, every MCP tool, with real usage and what each one actually does
  under the hood.
- `04_RELEASE_PIPELINE.md` — the exact, repeatable sequence used to ship a
  change: edit → build → pty-verify → version bump → commit → push → sync to
  the public repo → release → cold-verify → install. Follow this exactly; it
  encodes several real, previously-hit failure modes.
- `05_SESSION_LOG.md` — a chronological account of every real bug found and
  fixed, and every feature added, this session (v0.3.27 → v0.3.33), with the
  actual root cause and actual fix for each — not a changelog summary, the
  reasoning.
- `06_KNOWN_GOTCHAS.md` — standalone traps that will bite you again if you
  don't know about them: Bun-compile quirks, macOS TCC/activation quirks,
  flock semantics, sparse-file accounting, pty testing pitfalls.

## The one-paragraph mental model

ICARUS is a **memory filesystem for AI agents**: one small set of files per
tenant (`shard.amr` + `.vec` + `.txt` + `.edg` + `.mnsw` + `.lock`, under
`data/<org>/`), memory-mapped directly, no server, no database. A Rust core
(`crate/mseg`, `crate/mnsw-index`, `crate/mpq`, `crate/mneme-bm25`) implements
the actual storage/search; `crate/mneme-node` is a napi binding exposing that
core as a Node addon (`MnemeStore`); everything a user actually runs —
`mneme-cli.js` (one-shot subcommands), `tui.js` (the interactive `icarus` REPL
you get with no args), `mcp-serve.js` (the MCP server Claude Code/Codex/Cursor
talk to) — is a thin Node layer on top of that addon, sharing its real logic
through `cli-lib.js` so the CLI, the TUI, and the MCP server never have two
separate implementations of the same operation.

## If you only read one other file

Read `05_SESSION_LOG.md`. It's the actual decision history — every real bug,
its real root cause, and why the fix looks the way it does. Skipping it means
re-discovering (and re-fixing, badly) things that are already solved.
