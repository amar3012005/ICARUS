'use strict';
// icarus TUI — launched by bare `icarus` (no subcommand) on a real TTY. Full alt-screen
// raw-mode redraw: a fixed top bar, a scrolling chat/output pane, and a bottom-pinned bordered
// prompt with live slash-command autocomplete — the real structural pattern grok-build's own
// Rust/ratatui pager uses (studied its actual source: welcome/mod.rs's fixed top-bar/content/
// prompt row layout, prompt_widget's bordered input). NOT a port of that code — ratatui is a
// full Rust TUI framework (tens of thousands of lines, session pickers/auth flows/mouse/credit
// balances icarus has no equivalent of); this is a right-sized, dependency-free reimplementation
// of the same LAYOUT SHAPE in Node, using raw ANSI directly.
//
// Deliberately no TUI library (blessed, etc.): confirmed live that blessed's own internals use
// dynamic `require()` calls Bun's bundler can't statically resolve, so it crashes at runtime
// inside a `bun build --compile` single binary ("Cannot find module './widgets/node'") — a hard
// blocker for icarus's actual distribution model. Raw ANSI has no such risk: it's only our own
// code, holding zero dynamic requires.
//
// All existing command logic (dispatch()'s /ingest, /recall, /save, /status, etc. cases) is
// UNCHANGED from the previous readline-based version — only the rendering shell around it is
// new. dispatch() still just calls console.log/console.error and writes progress ticks via
// process.stdout.write('\r...'); this file intercepts process.stdout.write globally for the
// whole session and routes it into the transcript pane instead of letting it hit the real
// terminal directly (which would corrupt the manually-controlled alt-screen layout). A bare `\r`
// -prefixed write (the spinner tick pattern already used by /ingest's progress callback) replaces
// the transcript's last line instead of appending a new one, so progress ticks still look like a
// single evolving status line, not a scroll of hundreds of ticks.
const { c, heading, ok, err, bullet, glyphs, rule, spinnerFrame } = require('./theme.js');
const {
  loadCfg, saveCfg, ingestDir, recallQuery, statusReport, richOrgStats, signingEnabled, embeddingsConfigured,
  hivemindConfigured, hivemindIngestDir, attemptHivemindOAuth,
  DEFAULT_HIVEMIND_AUTH_URL, DEFAULT_HIVEMIND_API_URL,
  ICARUS_VERSION, checkForUpdate, performSelfUpdate, noIngestableFilesReason, HIVEMIND_INGESTABLE_EXTS, pickFolderNative,
  hivemindSaveMemory, saveLocalMemory,
} = require('./cli-lib.js');

// ── ANSI primitives ─────────────────────────────────────────────────────────────────────────
const ENTER_ALT = '\x1b[?1049h';
const EXIT_ALT = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_HOME = '\x1b[2J\x1b[H';
const moveTo = (row, col) => `\x1b[${row};${col}H`;

// Monochrome night palette — the TUI is deliberately black/white only (an explicit design
// choice for this screen), so it does NOT use theme.js's colored accents. Everything here is a
// shade of gray on true black, which also means the layout reads correctly on any terminal
// whose own background differs from the app's.
const BG_BLACK = '\x1b[48;2;0;0;0m';
const BG_BAND = '\x1b[48;2;26;26;26m';   // user-row band — grok's own prompt_band_color_for()
const FG_BRIGHT = '\x1b[38;2;235;235;235m';
const FG_NORMAL = '\x1b[38;2;200;200;200m';
const FG_MUTED = '\x1b[38;2;120;120;120m';
const FG_FAINT = '\x1b[38;2;85;85;85m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const m = {
  bright: (s) => `${FG_BRIGHT}${s}${RESET}`,
  normal: (s) => `${FG_NORMAL}${s}${RESET}`,
  muted: (s) => `${FG_MUTED}${s}${RESET}`,
  faint: (s) => `${FG_FAINT}${s}${RESET}`,
  bold: (s) => `${BOLD}${FG_BRIGHT}${s}${RESET}`,
};

// Big block-letter ICARUS — the exact same art install.sh's own banner() prints, so the
// installer and the running TUI show one identical mark instead of two different logos.
const ICARUS_BIG = [
  ' ██╗ ██████╗ █████╗ ██████╗ ██╗   ██╗███████╗',
  ' ██║██╔════╝██╔══██╗██╔══██╗██║   ██║██╔════╝',
  ' ██║██║     ███████║██████╔╝██║   ██║███████╗',
  ' ██║██║     ██╔══██║██╔══██╗██║   ██║╚════██║',
  ' ██║╚██████╗██║  ██║██║  ██║╚██████╔╝███████║',
  ' ╚═╝ ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝',
];

function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }
// Real display width, not code-unit length: the block-letter logo and box-drawing chrome are
// multi-byte characters, and the ✓/✗/◆ glyphs elsewhere are too. String#length would count
// those correctly here (they're all BMP, width-1), but an emoji in recalled memory text is a
// real surrogate pair AND double-width — counting it as 2 code units / 1 column silently
// shifted every border on that row. Count by code POINT, and treat the real wide ranges as 2.
function visLen(s) {
  const plain = stripAnsi(s);
  let w = 0;
  for (const ch of plain) { // iterating a string yields code points, not UTF-16 units
    const cp = ch.codePointAt(0);
    const wide = (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf)
      || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f)
      || (cp >= 0x1f900 && cp <= 0x1f9ff);
    w += wide ? 2 : 1;
  }
  return w;
}

/** Exact port of grok-build's own format_duration (xai-grok-pager-render/src/util.rs) — the
 * "Worked for X" marker's real formatting contract, copied rather than approximated:
 *   <10s -> "5.2s" (one decimal) · 10-59s -> "32s" · 1-59m -> "2m5s" · 1h+ -> "1h2m" */
function formatDuration(ms) {
  const totalSecs = Math.floor(ms / 1000);
  // Divergence from grok's own formatter, on purpose: its one-decimal branch renders any
  // sub-100ms turn as a flat "0.0s". grok never hits that (its turns are LLM round-trips,
  // always >100ms); icarus's local recall genuinely completes in single-digit milliseconds, so
  // the same code would print a misleading "0.0s" for real work. Report ms below 100ms instead.
  if (ms < 100) return `${Math.max(1, Math.round(ms))}ms`;
  if (totalSecs < 10) return `${(ms / 1000).toFixed(1)}s`;
  if (totalSecs < 60) return `${totalSecs}s`;
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins < 60) return `${mins}m${secs}s`;
  return `${Math.floor(mins / 60)}h${mins % 60}m`;
}

function nowClock() {
  const d = new Date();
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
}

// Wraps a single (possibly ANSI-colored) line to `width` VISIBLE columns. Real terminals don't
// reset color state across a bare `\n` — a color escape stays active until explicitly reset —
// so this only needs to track visible-column count and break there; it never has to re-emit a
// color code after the break for the wrapped continuation to render correctly.
function wrapLine(line, width) {
  if (visLen(line) <= width) return [line];
  const out = [];
  let cur = '';
  let vis = 0;
  let i = 0;
  while (i < line.length) {
    const esc = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
    if (esc) { cur += esc[0]; i += esc[0].length; continue; }
    if (vis >= width) { out.push(cur); cur = ''; vis = 0; }
    cur += line[i]; vis++; i++;
  }
  out.push(cur);
  return out;
}

// ── Slash-command catalog (autocomplete source) ─────────────────────────────────────────────
const SLASH_COMMANDS = [
  { cmd: '/ingest', hint: '<dir> [--org name] [--local] [--force] [--keep-cloud]' },
  { cmd: '/recall', hint: '<query> [--org name] [--k 5] [--pq]' },
  { cmd: '/save', hint: '<text> [--org name] [--cloud]' },
  { cmd: '/status', hint: 'memories, evidence, relationships, shards' },
  { cmd: '/org', hint: '<name> — switch the default org for this session' },
  { cmd: '/connect', hint: 'browser sign-in to HIVEMIND' },
  { cmd: '/update', hint: 'download + verify the latest release' },
  { cmd: '/help', hint: 'full command list' },
  { cmd: '/quit', hint: 'ctrl+d also works' },
];

function printHelp(state) {
  out(state, '');
  out(state, heading('Commands'));
  out(state, `  ${c.command('/ingest')} [dir|file] [--org name] [--local] [--force] [--keep-cloud]  ingest a folder or a single file — leave the path off to open a native file/folder picker. HIVEMIND (when connected) is a stateless extraction pipeline only — segments mirror locally, then the cloud document icarus itself created is deleted (--keep-cloud to leave it there).`);
  out(state, `  ${c.command('/recall')} <query> [--org name] [--k 5] [--pq]     local recall, always. Real parallel hybrid (dense+lexical, RRF-merged); narrow-reranked if HIVEMIND connected, else the hybrid merge is final. Never HIVEMIND's shared recall (a real cross-tenant leak was found there).`);
  out(state, `  ${c.command('/save')} <text> [--org name] [--cloud]              LOCAL ONLY by default — real embedding, never touches HIVEMIND's cloud memory box on its own. --cloud opts in to a real, permanent, smart-routed HIVEMIND memory too — recallable via /recall either way.`);
  out(state, `  ${c.command('/status')}                                          org shards + real memory/evidence/relationship counts + signing/audit`);
  out(state, `  ${c.command('/connect')}                                         browser sign-in to HIVEMIND`);
  out(state, `  ${c.command('/org')} <name>                                      switch the default org for this session`);
  out(state, `  ${c.command('/update')}                                          download + verify the latest release, replace this binary`);
  out(state, `  ${c.command('/help')}                                             this list`);
  out(state, `  ${c.command('/quit')} / ${c.command('ctrl+d')}                                   exit`);
  out(state, '');
  out(state, 'Anything not starting with "/" is treated as ' + c.command('/recall <text>') + ' against the current org.');
}

function parseArgs(argStr) {
  const tokens = argStr.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const clean = tokens.map((t) => t.replace(/^["']|["']$/g, ''));
  const out2 = { _: [] };
  for (let i = 0; i < clean.length; i++) {
    if (clean[i].startsWith('--')) {
      const name = clean[i].slice(2);
      const boolFlags = new Set(['local', 'force', 'pq', 'no-mirror', 'keep-cloud', 'cloud']);
      if (boolFlags.has(name)) out2[name] = true;
      else out2[name] = clean[++i];
    } else out2._.push(clean[i]);
  }
  return out2;
}

// ── Output capture: routes dispatch()'s console.log/stdout.write into the transcript pane ──
function out(state, text) { writeToTranscript(state, String(text) + '\n'); }

/** A user turn — a full-width BANDED row (darker background across the whole line) with the
 * `❯ ` prefix and a right-justified clock, exactly the shape grok-build's own user block
 * renders (scrollback/blocks/user.rs: prompt_band_color_for() paints a semantic line background
 * behind the prefix + text, so the user's own turns read as distinct cards in the transcript).
 * Pre-padded to the terminal width HERE, at push time, because the band is a background color
 * that has to cover the full row — redraw()'s own generic padding happens outside the escape
 * and would leave the tail of the row unbanded. */
function userRow(state, text) {
  const cols = process.stdout.columns || 80;
  const clock = nowClock();
  const left = `❯ ${text}`;
  const pad = Math.max(1, cols - visLen(left) - visLen(clock) - 1);
  const banded = `${BG_BAND}${FG_BRIGHT}${left}${' '.repeat(pad)}${FG_MUTED}${clock}${RESET}`;
  state.transcript.push('');
  state.transcript.push(banded);
  state.transcript.push('');
  state._spinnerActive = false;
  scheduleRedraw(state);
}

/** The turn-completion marker — `Worked for X` on the left, `stop  [hooks: N]` right-justified
 * to the full width. Exact port of grok-build's own contract (scrollback/blocks/session_event.rs:
 * append_stop_hooks() right-justifies the summary against the marker text on a single-line
 * marker; message() formats it as "Worked for {format_duration}"). icarus has no hook system of
 * its own, so the count is a REAL count of what this turn actually did — currently always the
 * one dispatch call — rather than a decorative number copied from grok's screenshot. */
function markerRow(state, elapsedMs) {
  const cols = process.stdout.columns || 80;
  const left = `Worked for ${formatDuration(elapsedMs)}`;
  const right = 'stop';
  const pad = Math.max(2, cols - visLen(left) - visLen(right));
  state.transcript.push(`${FG_FAINT}${left}${' '.repeat(pad)}${right}${RESET}`);
  state._spinnerActive = false;
  scheduleRedraw(state);
}

function writeToTranscript(state, chunk) {
  const text = (state._pendingPartial || '') + chunk;
  state._pendingPartial = '';
  const endsWithNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (!endsWithNewline) state._pendingPartial = lines.pop();
  for (const line of lines) {
    if (line.startsWith('\r')) {
      const content = line.slice(1);
      if (state._spinnerActive && state.transcript.length) state.transcript[state.transcript.length - 1] = content;
      else { state.transcript.push(content); state._spinnerActive = true; }
    } else {
      state.transcript.push(line);
      state._spinnerActive = false;
    }
  }
  scheduleRedraw(state);
}

let redrawScheduled = false;
function scheduleRedraw(state) {
  if (redrawScheduled) return;
  redrawScheduled = true;
  setImmediate(() => { redrawScheduled = false; redraw(state); });
}

// ── Frame rendering ──────────────────────────────────────────────────────────────────────────

/** The hero box — SHARP corners (┌┐└┘), not rounded, containing the big block-letter ICARUS
 * mark plus the version/subtitle/connection lines. Fixed at the top of the screen, above the
 * scrolling transcript, matching grok-build's own welcome-screen composition (a bordered hero
 * card pinned above the conversation area). */
function heroBoxLines(cfg, state, cols) {
  const inner = Math.max(20, cols - 2); // full terminal width, matching the input box below
  const top = m.faint('┌' + '─'.repeat(inner) + '┐');
  const bot = m.faint('└' + '─'.repeat(inner) + '┘');
  const row = (content) => {
    const pad = Math.max(0, inner - 1 - visLen(content));
    return `${m.faint('│')} ${content}${' '.repeat(pad)}${m.faint('│')}`;
  };
  const hm = cfg.hivemind?.connected
    ? m.normal('connected' + (cfg.hivemind.userEmail ? ` as ${cfg.hivemind.userEmail}` : ''))
    : m.faint('not connected');
  const body = [
    row(''),
    ...ICARUS_BIG.map((l) => row(m.bright(l))),
    row(''),
    row(`${m.muted('memory filesystem for AI agents')}`),
    row(`${m.faint('one mmap\'d file per tenant, no server')}`),
    row(''),
    row(`${m.muted('v' + ICARUS_VERSION)}   ${m.muted('org:')} ${m.normal(state.org)}   ${m.muted('HIVEMIND:')} ${hm}`),
    row(''),
  ];
  return [top, ...body, bot];
}

function inputBoxFrame(state, cols) {
  const inner = cols - 2; // visible columns strictly between the two border glyphs
  const top = m.faint('┌' + '─'.repeat(inner) + '┐');
  const bot = m.faint('└' + '─'.repeat(inner) + '┘');
  const prefixPlain = '❯ ';
  const prefix = m.bright(prefixPlain);
  const prefixW = visLen(prefixPlain);
  // Content area inside the box: one leading space after '│', then the prefix, then the text.
  const maxTextWidth = Math.max(1, inner - 1 - prefixW - 1);
  let viewStart = 0;
  if (state.cursor > maxTextWidth) viewStart = state.cursor - maxTextWidth;
  const visibleText = state.input.slice(viewStart, viewStart + maxTextWidth);
  const pad = Math.max(0, maxTextWidth - visLen(visibleText));
  const mid = `${m.faint('│')} ${prefix}${m.bright(visibleText)}${' '.repeat(pad)} ${m.faint('│')}`;
  // Cursor column, 1-indexed, counted the SAME way the row above is built:
  //   col 1 = '│', col 2 = the space, cols 3.. = prefix, then the text.
  // A previous version added a stray +1 here (borrowed from an earlier layout that had a
  // different left inset) and parked the caret one column right of the character it was
  // actually editing — visible as an off-by-one gap on every keystroke.
  const cursorCol = 1 + 1 + prefixW + (state.cursor - viewStart) + 1;
  return { lines: [top, mid, bot], cursorCol };
}

function autocompleteMatches(input) {
  if (!input.startsWith('/') || input.includes(' ')) return [];
  return SLASH_COMMANDS.filter((s) => s.cmd.startsWith(input));
}

function redraw(state) {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const matches = autocompleteMatches(state.input);
  const dropdown = matches.slice(0, 6);
  const dropdownH = dropdown.length;
  const cfg = loadCfg();

  const hero = heroBoxLines(cfg, state, cols);
  const inputH = 3;
  const tipH = 1;
  // The hero box is fixed chrome, but must never squeeze the transcript to nothing on a short
  // terminal — drop it entirely rather than render a screen with no room for output.
  const heroH = (rows - hero.length - dropdownH - inputH - tipH) >= 4 ? hero.length : 0;
  const contentH = Math.max(1, rows - heroH - dropdownH - inputH - tipH);

  const pending = state._pendingPartial ? [state._pendingPartial] : [];
  const allLines = state.transcript.concat(pending);
  const wrapped = allLines.flatMap((l) => wrapLine(l, cols));
  const visible = wrapped.slice(Math.max(0, wrapped.length - contentH));
  const padCount = Math.max(0, contentH - visible.length);

  const frame = [];
  if (heroH) frame.push(...hero);
  frame.push(...visible);
  frame.push(...Array(padCount).fill(''));
  for (const d of dropdown) frame.push(`  ${m.bright(d.cmd)} ${m.faint(d.hint)}`);
  frame.push(m.faint('Type a command, or plain text to recall. Tab completes, ↑/↓ browse history.'));
  const { lines: inputLines, cursorCol } = inputBoxFrame(state, cols);
  frame.push(...inputLines);

  // Every row is padded to the FULL terminal width and painted on the black background, so no
  // stale glyph from a previous longer frame survives underneath (the alternative — clearing
  // the whole screen each frame — flickers visibly on a real terminal).
  const body = frame.map((l) => {
    const pad = Math.max(0, cols - visLen(l));
    // Every m.xxx() span ends with a bare RESET (\x1b[0m), which clears the background too —
    // so any content built from more than one styled span (or followed by trailing pad spaces)
    // would fall through to the terminal's OWN default background between/after them. Real bug
    // caught from an actual screenshot: white rectangles behind short lines (the tip hints) where
    // their content's own reset landed well before the padding that fills out the rest of the
    // row. Re-assert the black background after every internal reset, not just once at the very
    // start of the line.
    const forced = l.split(RESET).join(RESET + BG_BLACK);
    return BG_BLACK + forced + ' '.repeat(pad) + RESET;
  }).join('\r\n');

  // Input row = the box's MIDDLE line: everything above it, plus its own top border, plus 1
  // to convert the 0-indexed count into a 1-indexed terminal row.
  const inputRowIndex = heroH + visible.length + padCount + dropdownH + tipH + 1 + 1;
  realWrite(HIDE_CURSOR + moveTo(1, 1) + body + moveTo(inputRowIndex, cursorCol) + SHOW_CURSOR);
}

// ── Raw stdout interception (installed for the whole session) ──────────────────────────────
let realWrite = process.stdout.write.bind(process.stdout);
function installOutputCapture(state) {
  realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { writeToTranscript(state, chunk.toString()); return true; };
  process.stderr.write = (chunk, ...rest) => { writeToTranscript(state, chunk.toString()); return true; };
}
function restoreOutput() {
  process.stdout.write = realWrite;
}

// ── Terminal lifecycle ───────────────────────────────────────────────────────────────────────
function enterScreen() { realWrite(ENTER_ALT + CLEAR_HOME); }
let exited = false;
function exitScreen() {
  if (exited) return;
  exited = true;
  restoreOutput();
  try { process.stdin.setRawMode(false); } catch (_) { /* not a TTY / already restored */ }
  realWrite(SHOW_CURSOR + EXIT_ALT);
}

async function run() {
  const cfg = loadCfg();
  const state = {
    org: 'default', transcript: [], input: '', cursor: 0, history: [], historyIdx: -1,
    _pendingPartial: '', _spinnerActive: false,
  };

  enterScreen();
  installOutputCapture(state);
  out(state, m.faint(`◆ ${process.cwd().replace(process.env.HOME || '', '~')}`));
  out(state, '');
  out(state, m.faint('Type /help for the full command list.'));

  process.on('exit', exitScreen);
  process.on('SIGINT', () => { exitScreen(); process.exit(0); });
  process.on('SIGTERM', () => { exitScreen(); process.exit(0); });
  process.on('uncaughtException', (e) => { exitScreen(); console.error(e); process.exit(1); });
  process.stdout.on && process.stdout.columns; // touch to ensure columns is read at least once
  try { process.stdout.on('resize', () => scheduleRedraw(state)); } catch (_) { /* non-TTY stdout in a test harness */ }

  if (!process.stdin.isTTY) {
    // Non-interactive stdin (piped/test harness) — no raw-mode key loop possible. Fail loud
    // rather than hang forever waiting for keys that will never arrive.
    exitScreen();
    console.error('icarus: the TUI needs an interactive TTY on stdin. For scripted/piped use, call icarus\'s one-shot subcommands instead (icarus recall/save/ingest/status).');
    process.exitCode = 1;
    return;
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  let running = true;
  let dispatching = false;
  const submitQueue = [];

  async function drainQueue() {
    if (dispatching) return;
    dispatching = true;
    while (submitQueue.length) {
      const line = submitQueue.shift();
      userRow(state, line);
      const t0 = Date.now();
      try { await dispatch(line, state, cfg); } catch (e) { out(state, err(e.message || String(e))); }
      markerRow(state, Date.now() - t0);
      if (!running) break;
    }
    dispatching = false;
    scheduleRedraw(state);
  }

  function submit() {
    const line = state.input.trim();
    state.input = ''; state.cursor = 0;
    if (!line) return;
    state.history.push(line);
    state.historyIdx = state.history.length;
    if (line === '/quit' || line === '/exit') { running = false; scheduleRedraw(state); setTimeout(() => process.exit(0), 30); return; }
    submitQueue.push(line);
    drainQueue();
  }

  function acceptAutocomplete() {
    const matches = autocompleteMatches(state.input);
    if (matches.length) { state.input = matches[0].cmd + ' '; state.cursor = state.input.length; }
  }

  // Parses a raw stdin chunk into individual key tokens — a chunk can contain more than one key
  // (fast typing, paste, or a multi-byte escape sequence bundled with a following printable char).
  function tokenize(chunk) {
    const tokens = [];
    let i = 0;
    while (i < chunk.length) {
      if (chunk[i] === '\x1b' && chunk[i + 1] === '[') {
        const m = /^\x1b\[[A-D]/.exec(chunk.slice(i));
        if (m) { tokens.push(m[0]); i += m[0].length; continue; }
      }
      tokens.push(chunk[i]); i++;
    }
    return tokens;
  }

  process.stdin.on('data', (chunk) => {
    if (!running) return;
    for (const key of tokenize(chunk)) {
      if (key === '') { running = false; process.exit(0); return; } // ctrl+c
      if (key === '') { if (!state.input) { running = false; process.exit(0); return; } continue; } // ctrl+d on empty line
      if (key === '\r' || key === '\n') { submit(); continue; }
      if (key === '' || key === '\b') {
        if (state.cursor > 0) { state.input = state.input.slice(0, state.cursor - 1) + state.input.slice(state.cursor); state.cursor--; }
        continue;
      }
      if (key === '\t') { acceptAutocomplete(); continue; }
      if (key === '\x1b[D') { if (state.cursor > 0) state.cursor--; continue; }
      if (key === '\x1b[C') { if (state.cursor < state.input.length) state.cursor++; continue; }
      if (key === '\x1b[A') {
        if (autocompleteMatches(state.input).length) continue; // reserved for future dropdown-select; history for now falls through below when no dropdown
        if (state.historyIdx > 0) { state.historyIdx--; state.input = state.history[state.historyIdx]; state.cursor = state.input.length; }
        continue;
      }
      if (key === '\x1b[B') {
        if (state.historyIdx < state.history.length - 1) { state.historyIdx++; state.input = state.history[state.historyIdx]; state.cursor = state.input.length; }
        else { state.historyIdx = state.history.length; state.input = ''; state.cursor = 0; }
        continue;
      }
      if (key.length === 1 && key >= ' ') {
        state.input = state.input.slice(0, state.cursor) + key + state.input.slice(state.cursor);
        state.cursor++;
        continue;
      }
      // unrecognized control sequence — ignore rather than insert garbage into the input line
    }
    scheduleRedraw(state);
  });

  scheduleRedraw(state);
}

async function dispatch(line, state, cfg) {
  if (!line.startsWith('/')) return dispatch(`/recall ${line}`, state, cfg);
  const spaceIdx = line.indexOf(' ');
  const cmd = (spaceIdx === -1 ? line.slice(1) : line.slice(1, spaceIdx)).toLowerCase();
  const argStr = spaceIdx === -1 ? '' : line.slice(spaceIdx + 1);
  const flags = parseArgs(argStr);
  const org = flags.org || state.org;

  switch (cmd) {
    case 'ingest': {
      let dir = flags._[0];
      if (!dir) {
        // Both supported, per the exact ask: a typed path works as before, and pressing enter
        // on bare "/ingest" opens the OS's real native folder picker (Finder's own "choose
        // folder" dialog on macOS via osascript, zenity/kdialog on Linux) instead of forcing
        // everyone to paste a path. Async, not execFileSync — the redraw loop and stdin
        // handling keep running while the dialog is open, so the TUI doesn't freeze on it.
        console.log(c.dim('  no path given — opening the native folder picker...'));
        dir = await pickFolderNative(`icarus: select a folder to ingest into org "${org}"`);
        if (!dir) { console.log(err('no file or folder selected — usage: /ingest <dir|file> [--org name] [--local] [--force] [--no-mirror] [--keep-cloud]')); break; }
        console.log(ok(`selected ${c.path(dir)}`));
      }
      const viaHivemind = hivemindConfigured(cfg) && !flags.local;
      const skipReason = noIngestableFilesReason(dir, viaHivemind ? HIVEMIND_INGESTABLE_EXTS : undefined);
      if (skipReason) { console.log(err(skipReason)); break; }
      if (viaHivemind) {
        console.log(bullet(c.system(`ingesting into HIVEMIND, org "${c.path(org)}"...`)));
        let tick = 0;
        const result = await hivemindIngestDir(dir, org, cfg, (n) => process.stdout.write(`\r  ${c.running(spinnerFrame(tick++))} ${n} files`), { force: !!flags.force, mirrorLocal: !flags['no-mirror'], purgeCloud: !flags['keep-cloud'] });
        const notes = [];
        if (result.duplicates) notes.push(`${result.duplicates} already in your knowledge base`);
        if (result.pending) notes.push(`${result.pending} still processing`);
        if (result.failed) notes.push(`${result.failed} failed — see errors above`);
        if (result.mirrored) notes.push(`${result.mirrored} segments mirrored locally`);
        if (result.purged) notes.push(`${result.purged} cloud doc(s) purged after mirroring`);
        if (result.skippedImages) notes.push(`${result.skippedImages} image(s) skipped — no fetchable HIVEMIND document for images`);
        console.log(`\n${ok(`ingested ${result.files} files → ${result.live} memories, ${result.chunks} segments`)}${notes.length ? c.dim(` — ${notes.join(', ')}`) : ''}`);
      } else {
        let tick = 0;
        const result = await ingestDir(dir, org, cfg, (n) => process.stdout.write(`\r  ${c.running(spinnerFrame(tick++))} ${n} chunks`));
        console.log(`\n${ok(`ingested ${result.chunks} chunks from ${result.files} files (mode=${result.mode})`)}`);
      }
      break;
    }
    case 'recall': {
      const q = argStr.trim();
      if (!q) { console.log(err('usage: /recall <query> [--org name] [--k 5]')); break; }
      const k = Number(flags.k || 5);
      const hits = await recallQuery(q, org, cfg, k, !!flags.pq);
      const modeLabel = hits[0]?.rerankFailed
        ? c.command(` (rerank failed — showing raw RRF scores, not calibrated: ${hits[0].rerankError})`)
        : hits[0]?.mode === 'hybrid-reranked' ? c.dim(' (parallel hybrid, reranked)')
        : hits[0]?.mode === 'lexical' ? c.dim(' (lexical/BM25 only)')
        : hits[0]?.mode === 'hybrid' ? c.dim(' (parallel hybrid, RRF-merged — too few candidates to rerank)')
        : '';
      console.log(`\n${heading(`top ${hits.length}`)}${modeLabel}\n`);
      hits.forEach((h, i) => console.log(`  ${c.dim(String(i + 1).padStart(2))} ${c.assistant(glyphs.promptArrow)} ${c.model(`[${h.score.toFixed(4)}]`)} ${h.text.replace(/\s+/g, ' ').slice(0, 140)}`));
      break;
    }
    case 'save': {
      const text = argStr.trim();
      if (!text) { console.log(err('usage: /save <text> [--org name] [--cloud]')); break; }
      if (hivemindConfigured(cfg) && flags.cloud) {
        const r = await hivemindSaveMemory(text, org, cfg);
        await saveLocalMemory(text, org, cfg, { viaCloud: true });
        console.log(ok(`saved as a real memory (id ${r.memoryId || r.memoryIds?.[0] || '?'}) — goes through embedding, smart-router, contradiction checks, mirrored locally. Recallable via /recall alongside evidence.`));
      } else {
        await saveLocalMemory(text, org, cfg);
        console.log(ok(`saved as a local memory in "${c.path(org)}"'s shard (embedded${embeddingsConfigured(cfg) ? '' : ' lexically — no embedding provider configured'}).`));
      }
      break;
    }
    case 'status': {
      const s = statusReport(cfg);
      console.log(`${heading('icarus')}  data: ${c.path(s.dataRoot)}  dim: ${s.dim}`);
      console.log(`HIVEMIND: ${s.hivemindConnected ? c.success('connected') : c.dim('not connected')}   Signing: ${signingEnabled(cfg) ? c.success('on') : c.dim('off')}`);
      if (!s.shards.length) { console.log(c.dim('no shards yet')); break; }
      for (const sh of s.shards) {
        let rich = null, richErr = null;
        try { rich = richOrgStats(sh.org, cfg); } catch (e) { richErr = e.message.split('\n')[0]; }
        console.log(`  ${c.path(sh.org.padEnd(20))} ${c.dim((sh.bytesOnDisk / 1e6).toFixed(2) + ' MB')}`);
        if (rich) {
          console.log(`    ${c.dim('memories:')} ${c.bold(rich.memoriesLatest)}${rich.memories !== rich.memoriesLatest ? c.dim(` (${rich.memories - rich.memoriesLatest} superseded)`) : ''}   ${c.dim('relationships:')} ${c.bold(rich.relationships)}   ${c.dim('evidence/other:')} ${c.bold(rich.evidenceAndOther)}`);
          console.log(`    ${c.dim('entities: not tracked locally (no local entity extraction — a real HIVEMIND server-side capability)')}`);
        } else {
          console.log(`    ${c.command(`(memory/relationship counts unavailable — ${richErr})`)}`);
        }
      }
      break;
    }
    case 'org': {
      if (flags._[0]) { state.org = flags._[0]; console.log(ok(`default org set to "${c.path(state.org)}"`)); }
      else console.log(c.dim(`current org: ${state.org}`));
      break;
    }
    case 'connect': {
      const authUrl = process.env.HIVEMIND_URL || cfg.hivemind?.url || DEFAULT_HIVEMIND_AUTH_URL;
      const restUrl = process.env.HIVEMIND_API_URL || cfg.hivemind?.apiUrl || DEFAULT_HIVEMIND_API_URL;
      console.log(c.running('  Opening your browser...'));
      const oauth = await attemptHivemindOAuth(authUrl);
      if (oauth) {
        cfg.hivemind = { connected: true, url: authUrl, token: oauth.token, userEmail: oauth.userEmail, apiUrl: restUrl, connectedAt: new Date().toISOString() };
        saveCfg(cfg);
        console.log(ok(`HIVEMIND connected${oauth.userEmail ? ` as ${oauth.userEmail}` : ''}.`));
      } else {
        console.log(err('browser sign-in didn\'t complete — run `icarus connect` outside the TUI for the manual-token fallback.'));
      }
      break;
    }
    case 'update': {
      console.log(c.dim(`  checking latest version (current: v${ICARUS_VERSION})...`));
      const { current, latest, upToDate } = await checkForUpdate();
      if (upToDate) { console.log(ok(`already up to date (${current}).`)); break; }
      if (upToDate === null) console.log(c.dim('  couldn\'t check the latest version — trying the update anyway.'));
      else console.log(c.system(`  updating ${c.dim(current)} → ${c.bold(latest)}...`));
      console.log(bullet(c.system('downloading and verifying the new binary...')));
      const bytes = await performSelfUpdate();
      console.log(ok(`updated to ${c.bold(latest || 'the latest release')} (${(bytes / 1e6).toFixed(1)} MB).`));
      console.log(c.dim('  this running session is still on the old build — /quit and restart icarus to use the new one.'));
      break;
    }
    case 'help': printHelp(state); break;
    case 'quit': case 'exit': break; // handled in submit() before reaching dispatch
    default: console.log(err(`unknown command: /${cmd} — try /help`));
  }
}

module.exports = { run };
