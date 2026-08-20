# Session log — v0.3.27 → v0.3.33

Chronological, real bugs and real fixes, in the order they actually happened.
Each entry: the report/symptom, the root cause once actually found, and the
fix. This is deliberately more detailed than a changelog — the reasoning is
the point.

## v0.3.27 / v0.3.28 — brightness + two structural TUI bugs

**Report**: text looked dim/washed-out compared to a reference (grok-build's
own TUI), and the terminal felt "stuck"/"jerking"/slow.

Three separate real bugs, not one:

1. **Missing foreground baseline.** Every `RESET` (`\x1b[0m`) clears BOTH
   background AND foreground color state. The code re-asserted `BG_BLACK`
   after every internal reset, but never a foreground — so plain, unstyled
   text (a lot of `dispatch()`'s own output has none) fell through to the
   terminal's OWN default foreground instead of a deliberate bright white.
   Fix: added `FG_DEFAULT = '\x1b[38;2;255;255;255m'`, re-asserted alongside
   `BG_BLACK` everywhere, plus bolding the user's own command-echo line.

2. **Redraw cost scaled with total session history**, not the visible
   window — `redraw()` used to wrap/measure the ENTIRE transcript array on
   EVERY keystroke. Fix: slice to a bounded recent window
   (`Math.max(contentH * 4, 200)`, later bumped to 800 in v0.3.32) before
   wrapping. Benchmarked: 154ms → 5ms for 50 redraws over a simulated
   5000-line transcript.

3. **A permanent 14-row hero box silently starved scrollback** — on a common
   24-row terminal, `contentH` dropped to ~6 visible rows, so the bounded
   slice above (correctly, by its own logic) discarded anything older than
   the last ~6 lines, INCLUDING a command's own response moments after it
   was written. Fix at the time: only show the hero splash before the first
   command, then drop it. (This got reverted by explicit request in v0.3.32
   — see below — once real scrollback existed to compensate.)

## v0.3.29 — native picker was a real race, not flaky

**Report**: `/ingest` with no path opens "the native folder picker" per its
own log line, then immediately fails with "no file or folder selected" —
"worked for 2.8s", far too fast for a human to have seen and dismissed a
dialog.

**Root cause, confirmed by running the exact shipped osascript snippet twice
in a row with nothing else changed**: `NSOpenPanel.runModal` from a bare
`osascript` process (no app bundle, no prior activation) is a genuine race.
One run blocked correctly and showed the dialog; the very next run returned
instantly with a non-OK response and the panel never visibly appeared.

**Fix**: explicitly call `NSApplication.sharedApplication
.setActivationPolicy($.NSApplicationActivationPolicyRegular)` and
`.activateIgnoringOtherApps(true)` before creating/running the panel.
Verified 3/3 runs afterward blocked correctly. Also stopped silently
swallowing the underlying `execFile` error (surfaced behind `ICARUS_DEBUG=1`).

## v0.3.30 — flag-typo swallowed the real argument; org picker added

**Report**: `/ingest --amar /some/path` (a typo for `--org amar`) fell
through to "no path given" instead of using the obviously-intended path.

**Root cause**: `parseArgs()` treated ANY unrecognized `--foo` as a
value-taking flag and consumed the very next token as its value — so
`--amar` ate the real positional path into `out2.amar`, leaving `out2._`
empty. **Fix**: an explicit whitelist of the only flag names any command
actually reads as a value (`org`, `name`, `kind`, `repo`, `k`) — everything
else is now a harmless boolean, never touching positional args.

**Also added** (same release, related surface): `/ingest` with a path but no
`--org` no longer silently defaults to whatever org happens to be active —
it lists every existing org with real size + creation date, single keypress
picks + confirms.

## v0.3.31 — real scrollback added

**Report**: "why is scroll not working" — there was, on inspection, no scroll
feature at all. `redraw()` always sliced to
`wrapped.slice(wrapped.length - contentH)`, permanently pinned to the live
tail; no offset state existed anywhere for a key or wheel event to move even
if wired up.

**Fix**: `state.scrollOffset`, clamped every frame against real available
history (survives a terminal resize shrinking `contentH` mid-session).
PageUp/PageDown page a full screen; mouse wheel (SGR mouse reporting, modes
1000+1006, enabled on entering the alt-screen, disabled on exit) scrolls 3
lines/notch. `tokenize()` extended to recognize both escape sequences as
single tokens (otherwise they'd shred into raw bytes and leak into the input
line). A new submitted command always snaps back to the live tail.

## v0.3.32 — org lifecycle, storage-size bug, persistent header, setup notice

Four independent items, shipped together:

1. **Real "storage without memories" bug.** Every org, even brand-new with
   zero memories, reported a fake ~4.2 MB storage floor. Root cause,
   confirmed via `stat`: `shard.vec`/`shard.amr` are pre-allocated to a fixed
   1024-slot capacity at creation (`mseg/src/segment.rs`'s `INITIAL_SLOTS`),
   which is a genuinely SPARSE file on APFS/most filesystems — `st_size`
   reports the full logical capacity, `st_blocks` (real allocated disk) was
   `0` for an empty org. **Fix**: sum `st.blocks * 512` (real allocated
   bytes) instead of `st.size`.

2. **`/create <org> <path>`** — new org shard rooted at an arbitrary repo
   path, reusing `initRepoShard()` (the same mechanism `/setup` already
   used). `findRepoIcarusDataRoot()`'s existing upward walk means that repo
   auto-uses the new org from then on, no separate mapping needed.

3. **`/delete`** — lists every org with real size, single keypress picks
   one, then a genuine DOUBLE confirmation (two separate y/n prompts, the
   second restating the org name so a reflexive double-Enter can't satisfy
   both) before permanently deleting the shard directory. Refuses if a
   different LIVE `icarus` process still holds it open, reusing
   `openStore()`'s existing lock-retry-then-throw guidance rather than a
   second, differently-worded message for the same situation.

4. **Persistent hero box + `/setup` restart notice**, both by explicit user
   request. The hero/status box no longer disappears after the first
   command (reverting the v0.3.27 fix — safe now because real scrollback
   exists to compensate; `RECENT_RAW_LINES`'s floor bumped 200→800 for the
   same reason). `/setup` now explicitly tells the user to restart their
   Claude Code/Codex/Cursor session afterward — the written project
   instructions + MCP registration only take effect in a session that
   starts fresh, never the one still running (a real point of confusion:
   nothing about running `/setup` retroactively changes an already-loaded
   agent session).

## v0.3.33 — lock-aware /status, /copy

1. **`/status` used to hang ~6.7s and then error**, every time, whenever
   this project's own live MCP tool connections (correctly, by design) held
   an org open. **Root cause**: `richOrgStats()` unconditionally used the
   full CRUD-path lock retry (~6.3s backoff) even for a purely read-only
   stats display. **Fix**: `openStore(cfg, org, {retry: false})` — a
   no-retry mode that fails on the FIRST lock conflict — is now the DEFAULT
   for `richOrgStats()`, returning `{unavailable: true}` instead of
   throwing. Mutating callers (ingest/save/delete) explicitly keep the full
   retry path; a real write should still wait out a brief genuine overlap.

2. **`/copy [n]`** — copies the last command's output (or last `n` raw
   lines) to the system clipboard. Real reason it exists: v0.3.31's SGR
   mouse reporting (needed for wheel-scroll) makes most terminals stop doing
   native click-drag text selection unless you already know the terminal's
   own modifier-key escape hatch — an unintended side effect of adding wheel
   scroll, not a separate ask. Implementation writes to a temp file and
   reads it back via a plain shell `<` redirect rather than piping through
   `execFileSync`'s own `input` option — more robust for larger output, and
   (per real testing) sidesteps a multi-byte-UTF-8 corruption that appeared
   ONLY under a synthetic-pty test harness (isolated all the way to a bare
   `sh -c "pbcopy < file"` with zero JS involved — confirmed to be a
   test-harness artifact, not a real terminal or app-code bug — see
   `06_KNOWN_GOTCHAS.md`).

## Standing decision, reaffirmed this session

A user explicitly asked for a feature letting ICARUS "connect to Claude,
Codex or any other coding agent's auth subscription to use the agent's
models, just like [some other tool] does." **This was refused and must not
be built.** `cli-lib.js`'s own comments already documented why: "ICARUS never
attempts to read or reuse Claude Code's own login session, by design...
Anthropic's own terms explicitly prohibit third-party tools from offering a
'connect your Claude subscription' OAuth flow and routing calls through a
user's Free/Pro/Max quota." This is a real ToS/legal constraint, not a style
preference — it should keep being declined unless the user raises it again
with genuinely new justification that changes the legal analysis.
