# Known gotchas — standalone traps

Each of these is real, independently confirmed this session. They're not
tied to one specific fix in `05_SESSION_LOG.md` — they'll bite you again on
a totally different change if you don't know about them up front.

## Testing a raw-mode alt-screen TUI

Plain piped stdin does NOT work — `tui.js` checks `process.stdin.isTTY` and
fails loud on a non-TTY. You MUST spawn it in a real pseudo-terminal.
Python's `pty` module is what this session used throughout:

```python
import pty, os, time, select

pid, fd = pty.fork()
if pid == 0:
    os.execvp('/path/to/icarus', ['/path/to/icarus'])
else:
    def read_for(seconds):
        end = time.time() + seconds
        out = b''
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.2)
            if fd in r:
                try:
                    chunk = os.read(fd, 65536)
                    if not chunk: break
                    out += chunk
                except OSError:
                    break
        return out
    read_for(2)
    os.write(fd, b'/status\r')
    out = read_for(2)          # <-- read spans the ENTIRE wait window
    os.kill(pid, 9)
```

**The one mistake that will waste real time**: `time.sleep(N); read_for(0.1)`
— sleeping first and only reading a short flush AFTER discards everything
that arrived DURING the sleep. Always make `read_for()` itself span the full
wait window, never sleep-then-read. This exact mistake produced several
false "nothing happened" results this session before being caught.

Also: strip ANSI before eyeballing captured output
(`re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', text)`), and don't slice too small a
tail — a full redraw can be several KB; slicing `[-800:]` once genuinely cut
off the exact line being tested for, producing a false negative.

## Bun-compile-specific bugs (real, distinct from the Bun runtime interpreted)

- `bun build --compile`'s bundler can't statically resolve dynamic
  `require()` calls — this is WHY `tui.js` doesn't use `blessed` or any
  similar TUI library; it crashes at runtime inside the compiled binary with
  "Cannot find module './widgets/node'" even though it works fine under
  plain `bun run`.
- Bun's `console.log` does NOT route through a monkey-patched
  `process.stdout.write` at all under a compiled binary (confirmed via
  isolated repro: patch `process.stdout.write`, call `console.log` twice,
  the patch never fires). This is why every `dispatch()` case writes via
  `out(state, ...)` (pushing straight into `state.transcript`) instead of
  `console.log` — the old `console.log` calls were leaking straight past
  the TUI's own redraw the whole time.
- A UTF-8 multi-byte-character corruption was chased for a long time this
  session and eventually proven to be a TEST-HARNESS artifact (Python's
  `pty.fork()` specifically), not a Bun-compile bug, not a Node bug, not an
  app-code bug: a bare `sh -c "pbcopy < file"` with ZERO JavaScript involved
  reproduced the exact same corruption when run through `pty.fork()`, but
  NOT when run through this session's own interactive shell. If you ever see
  a multi-byte character get mangled specifically when testing through a
  synthetic pty, suspect the pty layer itself before the app.

## macOS-specific

- `NSOpenPanel.runModal` (the native folder/file picker, invoked via JXA
  `osascript -l JavaScript`) is a genuine RACE without explicit activation.
  Always call `NSApplication.sharedApplication
  .setActivationPolicy($.NSApplicationActivationPolicyRegular)` and
  `.activateIgnoringOtherApps(true)` before creating/running the panel, or
  it will intermittently return instantly with no dialog ever shown.
- Overwriting an existing EXECUTABLE binary in place (same inode) can leave
  it permanently killed with SIGKILL/exit 137, even though the bytes on disk
  are byte-for-byte correct — some per-inode execution-trust cache gets
  stuck. Always `rm` then fresh `cp` into a new inode when installing an
  updated binary, never `cp` over the running/previous one directly.
- Plain AppleScript has NO single dialog that accepts either a file OR a
  folder — `choose folder` is folder-only, `choose file` is file-only, and
  `choose file or folder` is not a real AppleScript command (confirmed by
  trying it and getting a genuine syntax error). JXA driving `NSOpenPanel`
  directly with `canChooseFiles`/`canChooseDirectories` both `true` is the
  real way to get one dialog that does both.

## Sparse files and disk-usage accounting

`fs.Stats.size` (Node/JS) is the LOGICAL file size — for a file created via
`set_len()`/`ftruncate` to a capacity larger than what's actually been
written (which is exactly what `mseg`'s `Segment::create` does for
`shard.amr`/`shard.vec`, pre-allocating 1024 slots up front), this reports
the full pre-allocated capacity, NOT real disk usage. `fs.Stats.blocks * 512`
is the real allocated footprint. Any "storage used" figure MUST use
`.blocks`, not `.size`, or every fresh/near-empty org will report a fake
multi-MB floor. (Confirmed via `stat -f "size=%z blocks=%b"` directly: an
empty org's `shard.vec` showed `size=4194304 blocks=0`.)

## flock semantics and the `_storeCache`

- `flock(LOCK_EX|LOCK_NB)` was deliberately chosen over POSIX `fcntl` record
  locks (which SPEC §4.3 originally specified) because `fcntl` locks are
  owned by the PROCESS — a second open of the same shard within the SAME
  process would not conflict, defeating the guard for the common
  same-process double-open bug. `flock` gives the same cross-process
  exclusion AND detects a second open file description in the same process.
  This is a strictly STRONGER guarantee than the original spec; the on-disk
  format is unchanged.
- Because of that same-process-conflict property, `cli-lib.js`'s
  `_storeCache` (one open handle per org per PROCESS, held for that
  process's entire lifetime) exists specifically to avoid re-opening —
  without it, a long-lived process (the TUI, or `mcp-serve`) calling
  `icarus_ingest` then `icarus_recall` on the SAME org back to back would
  self-collide with its own still-open handle (a real bug hit before the
  cache existed).
- The consequence: a long-lived MCP server session (which this project's own
  Claude Code MCP connection is, for its entire lifetime) legitimately holds
  an org's exclusive lock the whole time. Any OTHER process (the TUI, a
  separate CLI invocation) trying to `openStore()` the SAME org will hit
  "shard is locked by another process" — this is CORRECT, expected behavior
  for a genuinely different live process, not a bug to "fix" by weakening
  the lock. What WAS a real bug (fixed in v0.3.33): a purely read-only
  status/stats display retrying the SAME ~6.3s backoff a real write would
  need, instead of just failing fast and saying "unavailable, in use
  elsewhere."
- There is currently NO exposed `close()`/`drop()` on the native `MnemeStore`
  binding — once opened in a process, a shard stays open (and locked) for
  that process's life, no way to explicitly release early short of the
  process exiting. If you ever want per-operation lock scoping (open → use →
  release, rather than open-once-per-process), that requires an ACTUAL Rust
  change (`src/lib.rs`, adding a real `close()` napi method that drops the
  inner `Shard`), not just a JS-side workaround — this was scoped out this
  session as too large/risky a change to make casually; the JS-side fix that
  shipped instead (v0.3.33) just makes read-only callers fail fast on a
  conflict rather than trying to avoid the conflict altogether.

## The nested `mneme/mneme/` path in the monorepo clone

Not a bug, a real point of confusion worth flagging explicitly: cloning the
monorepo (`ssh://singulance/root/hivemind-main`) gives you a repo whose OWN
top-level folder is also named `mneme/`. So the actual ICARUS source lives
at `<clone-root>/mneme/crate/mneme-node/*.js` — nested, not
`<clone-root>/crate/mneme-node/*.js`. Confirmed correct (not a cloning
mistake) via `git show --stat <sha>` on real commits, and by
`scripts/sync-icarus.sh`'s own `MNEME_DIR="$(git rev-parse
--show-toplevel)/mneme"` computation.
