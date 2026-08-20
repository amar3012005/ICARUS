# Release pipeline — the exact repeatable sequence

This is not aspirational — it's the literal sequence used to ship every one
of the v0.3.27→v0.3.33 releases this session, refined as real problems were
hit along the way. Follow it in order; skipping a step is how a previous
session shipped an orphaned draft release and had `releases/latest` keep
resolving to stale code.

## The real repo topology you're working across

- **Source of truth**: a private monorepo, `ssh://singulance/root/hivemind-main`,
  branch `singulance-main`. The actual ICARUS source lives NESTED inside it at
  `mneme/crate/mneme-node/*.js` (the monorepo's own top-level folder is ALSO
  named `mneme/` — confirmed real via `git show --stat` on real commits, not
  a mistake to "fix").
- **Public mirror**: `github.com/amar3012005/ICARUS` (this repo). A script,
  `scripts/sync-icarus.sh` (lives in the monorepo, not here), one-way mirrors
  the monorepo's `mneme/` subtree onto this repo's root, tracked-files-only,
  scanning for secrets/internal references before every push and aborting on
  a hit.

## Step by step

1. **Clone/update the monorepo working copy** (a scratch clone is fine —
   `/tmp` gets cleared between machine restarts; don't treat it as durable):
   ```bash
   git clone --branch singulance-main --single-branch --depth 5 \
     ssh://singulance/root/hivemind-main mneme
   ```
   The real files to edit are at `mneme/mneme/crate/mneme-node/*.js` inside
   that clone.

2. **Edit the source.** Syntax-check immediately after every edit:
   ```bash
   node -c mneme/mneme/crate/mneme-node/tui.js
   node -c mneme/mneme/crate/mneme-node/cli-lib.js
   ```

3. **Real functional test — not just syntax.** This is a raw-mode alt-screen
   TUI; you cannot test it with plain piped stdin. Use Python's `pty` module
   to spawn the compiled binary (or `bun run mneme-cli.js` during iteration)
   in a real pseudo-terminal, write real keystrokes, and read the real
   rendered output back. See `06_KNOWN_GOTCHAS.md` for the read-timing
   mistakes that will otherwise waste your time here.

4. **Bump the version.** One literal, by hand:
   ```js
   // mneme/crate/mneme-node/cli-lib.js
   const ICARUS_VERSION = '0.3.34';  // bump this
   ```
   This is NOT read from git or package.json automatically — it IS the
   release version (package.json's own version tracks the separate napi
   addon package and is unrelated).

5. **Commit** (from inside the monorepo clone, `mneme/` subdirectory as repo
   root):
   ```bash
   git add mneme/crate/mneme-node/tui.js mneme/crate/mneme-node/cli-lib.js
   git commit -F /tmp/commit-msg.txt   # heredoc/file avoids shell-quoting pain with real prose
   ```

6. **Rebase onto latest and push:**
   ```bash
   git fetch origin
   git rebase origin/singulance-main
   git push origin HEAD:singulance-main
   ```

7. **Sync to the public repo.** The sync script's own secret-scanner walks
   the WHOLE `mneme/` tree including `node_modules/` if present — a real,
   repeated false-positive (matches inside `sql.js`/`jose`'s own bundled
   crypto/base64 blobs). Stash `node_modules` out of the way first:
   ```bash
   mv mneme/crate/mneme-node/node_modules /tmp/nm-stash
   ICARUS_DIR=/Users/amar/ICARUS bash scripts/sync-icarus.sh --push
   mv /tmp/nm-stash mneme/crate/mneme-node/node_modules
   ```

8. **Rebuild the native addon** (only if you touched Rust/`crate/mneme-node/src`
   — a pure-JS change like most of this session's fixes does NOT need this):
   ```bash
   cd mneme/crate/mneme-node && npx napi build --release
   ```

9. **Compile the release binary:**
   ```bash
   bun build --compile ./mneme-cli.js --outfile /tmp/icarus-darwin-arm64
   ```

10. **One more real pty functional test against the ACTUAL compiled binary**
    (not just the source) — Bun-compile has caused its own distinct, real
    bugs (see `06_KNOWN_GOTCHAS.md`).

11. **Cut the release:**
    ```bash
    gh release create v0.3.34 --repo amar3012005/ICARUS \
      --title "..." --notes "..." /tmp/icarus-darwin-arm64
    ```
    The asset MUST be literally named `icarus-darwin-arm64` (or the matching
    `icarus-<os>-<arch>` for the platform) — `gh release create file#label`
    only sets a display LABEL, not the actual uploaded filename. Getting this
    wrong breaks `releases/latest/download/icarus-darwin-arm64` silently; if
    you catch it after the fact, `gh release delete-asset` + re-upload the
    correctly-named file, don't delete and recreate the whole release.

12. **Immediately verify it's really published, not an orphaned draft** (a
    real failure mode: a timed-out `gh release create` once left a draft
    behind, and `releases/latest` kept resolving to the OLD release):
    ```bash
    gh release view v0.3.34 --repo amar3012005/ICARUS \
      --json isDraft,tagName,assets --jq '{isDraft, tagName, assets:[.assets[].name]}'
    ```

13. **Cold-verify: download the PUBLISHED asset fresh and hash-compare** it
    against your local build — proves the release actually contains what you
    think it does, not a stale cache or a half-uploaded asset:
    ```bash
    curl -fsSL https://github.com/amar3012005/ICARUS/releases/latest/download/icarus-darwin-arm64 \
      -o /tmp/icarus-cold && chmod +x /tmp/icarus-cold
    diff <(shasum -a 256 /tmp/icarus-darwin-arm64 | awk '{print $1}') \
         <(shasum -a 256 /tmp/icarus-cold          | awk '{print $1}') && echo MATCH
    ```

14. **Install — delete then copy, never overwrite in place.** A real,
    confirmed macOS bug: overwriting an existing executable file in place
    (same inode) can leave it permanently killed with SIGKILL/exit 137 even
    though the bytes on disk are correct — some per-inode execution-trust
    cache gets stuck. Always remove first, then copy fresh into a NEW inode:
    ```bash
    rm /Users/amar/.icarus/bin/icarus
    cp /tmp/icarus-cold /Users/amar/.icarus/bin/icarus
    chmod +x /Users/amar/.icarus/bin/icarus
    ```

15. **Real verification, not a green assumption:**
    ```bash
    icarus status   # or: timeout 5 icarus status 2>&1 | head -1
    ```

16. **Clean up** every scratch file/dir you created for this cycle
    (`/tmp/commit-msg.txt`, temp test scripts, temp compiled binaries). Don't
    leave a growing pile of `/tmp/icarus-*` artifacts across sessions.

## What almost NEVER changes between releases

- The public repo's own `git log` is a series of `sync: engine update from
  monorepo <sha>` commits — one per publish. Don't hand-edit files directly
  in `amar3012005/ICARUS`'s checkout expecting them to persist; the NEXT sync
  from the monorepo will overwrite anything not also changed at the source.
  **Always edit the monorepo clone, never this repo's checkout directly**,
  except for genuinely public-repo-only artifacts (this `DEV_NOTES/` folder
  is deliberately the one exception, since it's git-ignored and never synced
  either way).
