# Phase status — ICARUS Harness v1.0

Live tracker for `HARNESS_V1_PLAN.md`. The plan itself is the specification and is not edited;
this file records what is actually done, what is proven, and what is blocked.

Rule for this file: an item is **DONE** only when its verification is real — a test that fails
against the unfixed code, an observed command output, a cold-verified artifact. "Implemented"
is not "done". Anything unverified says so.

Last updated at CLI version **0.3.46**.

---

## Phase 0 — Stabilize the product and the open-source workflow

Target: v0.3.47–v0.3.x

| Item | State | Evidence |
|---|---|---|
| Public repo canonical; monorepo no longer overwrites public development | **DONE** | `scripts/sync-icarus.sh` rewritten in the monorepo (commit `90def98`). Six properties tested live: dirty-clone abort preserves work; blanket `add -A` removed (untracked local files survive a full sync unstaged); digest-based divergence detection aborts naming the file; a public-only edit is KEPT and skipped rather than overwritten; `--force-monorepo` overrides; `pull-icarus.sh` reports 15 added / 1 modified in dry run and writes nothing. |
| Private-to-public scanner preserved as a pre-publish security check | **DONE** | Retained and made *correct*: it scanned the whole tree including `node_modules/` (false positives from `jose`'s literal `-----BEGIN PRIVATE KEY-----` and `sql.js`'s base64 blob), which forced a manual "move node_modules aside" step every publish. Now scans exactly the tracked publish set — 170 files, clean, no stash. |
| Root `VERSION` source used by binary, tags, update checks | **DONE** | `VERSION` + `scripts/version.mjs` (print / `--check` / `--write` / `--set`). 12 tests in `tests/unit/version.test.mjs` run against sandboxed copies. Engine package `singulance-amr` deliberately keeps its own version, per plan. |
| Node-layer CI (CLI, TUI, MCP, installers, recall, ingestion, skills, binary smoke) | **PARTIAL** | 82 tests green in ~0.55s, no toolchain required: `args`, `tui-render`, `cli-lib`, `mcp-install`, `version`, `smoke/cli`. A `node` job on ubuntu + macos is wired into `ci.yml`. **Not yet covered:** shard-backed ingest/recall/save round-trips (needs a `napi build` in CI → `tests/engine/`), MCP stdio protocol conformance, and compiled-binary smoke. |
| Automated release: asset naming, checksums, draft detection, cold download, version execution | **IMPLEMENTED, UNVERIFIED** | `.github/workflows/release-cli.yml`: version/tag agreement gate before any build minutes; per-platform build; asserts the built binary executes and reports the expected version; sha256; uploads by path only (never `path#label`); asserts `isDraft == false`; asserts exact asset names exist; cold-downloads through the public URL and compares digest + runs it; asserts `releases/latest` resolves to this tag. **Cannot be executed** — see the blocker below. |
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
| CI is green on macOS and Linux | **BLOCKED** — not a code failure. See below. |
| A release is built from the public commit and cold-verified automatically | **BLOCKED** by the same cause; the workflow exists and is complete. |
| Existing shards open without migration | **PASS** — `icarus status` on a live v0.3.46 install opens the real shard set (`shard.amr/.vec/.txt/.edg/.mnsw/.lock` + `audit.jsonl` + `signatures.jsonl`) with signing and audit active. |

### 🚫 Blocker: GitHub Actions is disabled at the account level

Every job across all six matrix entries fails in ~2 seconds with **zero steps executed**. The
run annotation gives the exact cause:

> `The job was not started because your account is locked due to a billing issue.`

This predates the Phase 0 work (runs `d611da5` and `d800234` failed identically before any of
it landed). It is not fixable from the repository — it needs the account owner to resolve
GitHub billing. Until then:

- The CI workflows are authored and structurally valid (`ci.yml`, `release.yml`,
  `release-cli.yml` all parse; job graphs verified).
- The Node suite is the interim gate and is run locally before every commit
  (`npm --prefix crate/mneme-node test`, plus `node scripts/version.mjs --check`).
- **No release should be cut until the release workflow has actually executed once.** Cutting
  one by hand is precisely what produced the wrong-asset-name and orphaned-draft failures this
  workflow exists to prevent.

---

## Phases 1–9

Not started. Phase 1 (`icarus harness init`, manifest + schemas, hash-chained runtime event
log, `icarus doctor`) is next once the Phase 0 gate can close.
