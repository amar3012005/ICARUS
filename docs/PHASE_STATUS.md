# Phase status — ICARUS Harness v1.0

Live tracker for `HARNESS_V1_PLAN.md`. The plan itself is the specification and is not edited;
this file records what is actually done, what is proven, and what is blocked.

Rule for this file: an item is **DONE** only when its verification is real — a test that fails
against the unfixed code, an observed command output, a cold-verified artifact. "Implemented"
is not "done". Anything unverified says so.

Last updated at CLI version **0.3.58** (release in progress).

---

## Phase 0 — Stabilize the product and the open-source workflow

Target: v0.3.47–v0.3.x

| Item | State | Evidence |
|---|---|---|
| Public repo canonical; monorepo no longer overwrites public development | **DONE** | `scripts/sync-icarus.sh` rewritten in the monorepo (commit `90def98`). Six properties tested live: dirty-clone abort preserves work; blanket `add -A` removed (untracked local files survive a full sync unstaged); digest-based divergence detection aborts naming the file; a public-only edit is KEPT and skipped rather than overwritten; `--force-monorepo` overrides; `pull-icarus.sh` reports 15 added / 1 modified in dry run and writes nothing. |
| Private-to-public scanner preserved as a pre-publish security check | **DONE** | Retained and made *correct*: it scanned the whole tree including `node_modules/` (false positives from `jose`'s literal `-----BEGIN PRIVATE KEY-----` and `sql.js`'s base64 blob), which forced a manual "move node_modules aside" step every publish. Now scans exactly the tracked publish set — 170 files, clean, no stash. |
| Root `VERSION` source used by binary, tags, update checks | **DONE** | `VERSION` + `scripts/version.mjs` (print / `--check` / `--write` / `--set`). 12 tests in `tests/unit/version.test.mjs` run against sandboxed copies. Engine package `singulance-amr` deliberately keeps its own version, per plan. |
| Node-layer CI (CLI, TUI, MCP, installers, recall, ingestion, skills, binary smoke) | **PARTIAL** | Public CI runs on macOS and Linux. A native-addon MCP job drives the actual stdio process through local lexical ingest, structured save, recall, and get-by-id against a disposable shard, with no credentials or network. A separate normal-CI job compiles the Bun executable, opens its embedded native shard, saves a record, and recalls it. The framing suite separately rejects non-JSON stdout. **Still missing:** real PTY coverage and broader upgrade/rollback coverage. |
| Automated release: asset naming, checksums, draft detection, cold download, version execution | **DONE for v0.3.56** | Public release run `32434963782` passed version validation, Linux x64 + macOS ARM64/x64 builds, exact binary version execution, checksums, non-draft publishing, expected asset checks, cold download/hash/execution, and `releases/latest` routing. |
| Contributor docs, governance, security reporting, code of conduct, RFC template | **DONE** | `GOVERNANCE.md` (new), `.github/ISSUE_TEMPLATE/rfc.md` (new), plus existing `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CODEOWNERS`, PR template. |
| Record v0.3.46 as the compatibility baseline | **DONE** | `COMPATIBILITY.md`, written from a live install and the real on-disk shard set — not from source. Includes the sparse-file accounting rule, the `flock`-not-`fcntl` decision, org-name charset, the local-recall-always guarantee, exit codes, and two honestly-recorded baseline defects. |

### Also fixed in Phase 0 (surfaced by the new tests)

- An unknown subcommand printed help and **exited 0**, so a typo in a script or CI step
  silently "succeeded". Now exits **2** and names the command on stderr; help stays on stdout;
  `help`/`--help`/`-h` and a bare piped invocation still exit 0.
- There was **no `--version` flag** — it fell through to the full help banner. Release
  automation must be able to ask a built binary what it is and compare it to the tag, so
  `--version`/`-v`/`version` now print only the bare version, answered before `loadCfg()` so
  the check cannot be defeated by config, a missing shard, or a missing addon.

### Phase 0 exit gate

| Gate | State |
|---|---|
| A public PR can be merged without being overwritten by private synchronization | **PASS** — proven by test, including a simulated contributor edit surviving a full sync. |
| CI is green on macOS and Linux | **PASS** — public CI `32434961725` is green. |
| A release is built from the public commit and cold-verified automatically | **PASS** — release run `32434963782` built and cold-verified v0.3.56. |
| Existing shards open without migration | **PASS** — `icarus status` on a live v0.3.46 install opens the real shard set (`shard.amr/.vec/.txt/.edg/.mnsw/.lock` + `audit.jsonl` + `signatures.jsonl`) with signing and audit active. |

---

## Current harness phases

| Phase | State | Current evidence and remaining gate |
|---|---|---|
| 1 — identity, policy, events, doctor | **IMPLEMENTED** | Rust-owned manifest, policy validation, append-only hash-chained events, runtime snapshots, migration, and doctor have runtime coverage. Full migration fixtures from every public preview remain a Phase 8 requirement. |
| 2 — task contracts and lifecycle | **IMPLEMENTED** | Immutable contracts, amendments, approvals, checkpoints, transitions, resume divergence checks, and task-scoped context have Rust tests. Crash/restart coverage for every lifecycle phase remains open. |
| 3 — context compiler | **IMPLEMENTED, PARTIAL GATE** | Deterministic, bounded JSON/Markdown packs, graph freshness and delta context are tested. The published evaluation corpus and measured 50% startup-token reduction are not yet proven. |
| 4 — managed launcher and adapters | **IMPLEMENTED, COMPATIBILITY ONLY** | Isolated worktrees by default, current-workspace acknowledgement/baselines, Rust scope reconciliation, wall-time deadlines, and Claude edit/stop hooks are covered. Claude and Codex are **not certified**: Codex structured app-server capture and complete pre-action/stop enforcement are still unfinished. |
| 5 — deterministic verification and sealing | **IMPLEMENTED, HARDENING IN PROGRESS** | Machine receipts, required criteria, expiry-bound approvals, stale-evidence invalidation, scope checks and final receipts are tested. NUL-delimited Git path enforcement is being added in v0.3.57. |
| 6 — governed skills | **IMPLEMENTED, PARTIAL GATE** | Proposed/verified/active/retired lifecycle, secret scan, source-task linkage, replay evidence, and demotion are implemented. Three independent source runs, replay comparison baselines, and the full auto-promotion proof remain open. |
| 7 — optional HIVE-MIND authority | **NOT STARTED** | Local-only behavior is the current authority boundary; no remote sync may be represented as production-ready. |
| 8 — production hardening / RC | **PARTIAL HARDENING** | NUL-path, rename, symlink-artifact, and MCP-stdio regressions are covered. It still requires the public corpus, full fake-agent conformance, crash/restart, installer rollback, SBOM/provenance/signature, and release-candidate gates. |
| 9 — v1.0 | **NOT STARTED** | Requires certified Claude + Codex, all open gates, and the 30-day/100-managed-task dogfood record. |
