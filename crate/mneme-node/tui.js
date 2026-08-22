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
// All existing command logic (dispatch()'s /ingest, /recall, /save, /status, etc. cases) calls
// out(state, ...) directly rather than console.log — a REAL bug caught live, not theoretical:
// under a bun-compiled binary (icarus's actual distribution format), Bun's console.log does NOT
// go through the JS-visible process.stdout.write at all — confirmed by a minimal isolated repro
// (monkey-patch process.stdout.write, call console.log twice, the patched function never fires,
// both lines leak straight to the real terminal). Every dispatch() case originally used
// console.log, meaning EVERY command's output was leaking raw past the alt-screen redraw the
// whole time, not just a rare edge case — it just often LOOKED right because the leaked text
// happened to land near the correct spot for a lone first command. process.stdout.write IS still
// intercepted globally (progress-tick writes like `\r...` from /ingest's callback still go
// through it fine, and it protects against a stray direct write from anywhere else), but dispatch
// output itself now bypasses console.log/process.stdout.write entirely via out(state, ...) —
// pushing straight into the transcript array, the same mechanism userRow/markerRow already used
// successfully. A bare `\r`-prefixed write into that path still replaces the transcript's last
// line instead of appending, so progress ticks still read as one evolving status line.
const fs = require('fs');
const path = require('path');
const { c, heading, ok, err, bullet, glyphs, rule, spinnerFrame } = require('./theme.js');
const {
  loadCfg, saveCfg, ingestDir, recallQuery, statusReport, richOrgStats, signingEnabled, embeddingsConfigured,
  openRouterApiKey, setOpenRouterApiKey, resolveSynthesisModel, fetchOpenRouterModels, fetchOpenRouterModel, selectOpenRouterModels, classifyChatFailure, chatWithOpenRouter, createPersonaSkill, selectPersonaSkill, clearPersonaSkill, skillList,
  hivemindConfigured, hivemindIngestDir, formatHivemindProgress, attemptHivemindOAuth,
  DEFAULT_HIVEMIND_AUTH_URL, DEFAULT_HIVEMIND_API_URL,
  ICARUS_VERSION, checkForUpdate, performSelfUpdate, noIngestableFilesReason, HIVEMIND_INGESTABLE_EXTS, pickFolderNative,
  hivemindSaveMemory, saveLocalMemory, saveIntelligentMemory, initRepoShard, listOrgsWithMeta, deleteOrgShard,
} = require('./cli-lib.js');

// ── ANSI primitives ─────────────────────────────────────────────────────────────────────────
const ENTER_ALT = '\x1b[?1049h';
const EXIT_ALT = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
// SGR mouse reporting (mode 1000 = button events, 1006 = SGR extended coordinate encoding) —
// the same combo every terminal coding agent enables so mouse-wheel scroll works inside an
// alt-screen app. Without this the terminal's own OWN scrollback would apply, but alt-screen
// apps have no real scrollback buffer of their own, which is exactly why plain wheel-scrolling
// silently did nothing before this: there was no scroll STATE anywhere to move, and no listener
// to move it. Enabled on entering the TUI, disabled on exit so a plain terminal afterward isn't
// left in mouse-reporting mode.
const ENABLE_MOUSE = '\x1b[?1000h\x1b[?1006h';
const DISABLE_MOUSE = '\x1b[?1000l\x1b[?1006l';
const CLEAR_HOME = '\x1b[2J\x1b[H';
const moveTo = (row, col) => `\x1b[${row};${col}H`;

// Monochrome night palette — the TUI is deliberately black/white only (an explicit design
// choice for this screen), so it does NOT use theme.js's colored accents. Everything here is a
// shade of gray on true black, which also means the layout reads correctly on any terminal
// whose own background differs from the app's.
const BG_BLACK = '\x1b[48;2;0;0;0m';
const BG_BAND = '\x1b[48;2;26;26;26m';   // user-row band — grok's own prompt_band_color_for()
// Real baseline foreground for the WHOLE frame — plain, unstyled text (a lot of dispatch()'s
// recall-result body content has no color function wrapping at all) used to inherit the
// terminal's own default foreground once a RESET cleared any prior color, instead of a real
// bright white. Applied everywhere BG_BLACK is, for the same reason.
const FG_DEFAULT = '\x1b[38;2;255;255;255m';
// Brightened from the original 200/120/85 — real user complaint on a real terminal: too dark to
// read comfortably, especially FG_FAINT (used for borders, the tip hint line, and the "Worked
// for..." marker — a lot of persistent, always-visible chrome, not rare text).
const FG_BRIGHT = '\x1b[38;2;235;235;235m';
const FG_NORMAL = '\x1b[38;2;212;212;212m';
const FG_MUTED = '\x1b[38;2;158;158;158m';
const FG_FAINT = '\x1b[38;2;128;128;128m';
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

/** Copies plain text to the system clipboard via whatever clipboard tool actually exists on
 * this machine — pbcopy (macOS), then wl-copy/xclip/xsel (Linux, Wayland vs X11). Real reason
 * this exists at all: enabling SGR mouse reporting for wheel-scroll (ENABLE_MOUSE, added
 * alongside real scrollback) makes most terminals stop doing their OWN click-drag text
 * selection unless the user already knows the terminal's own modifier-key escape hatch (e.g.
 * holding Option on macOS Terminal/iTerm2) — so losing native copy-select was a real, if
 * unintended, side effect of adding wheel scroll, not a separate ask. This gives back a working
 * copy path that doesn't depend on the terminal's mouse-capture state at all. Resolves null if
 * no clipboard tool is found, so the caller can say so plainly instead of failing silently. */
function copyToClipboard(text) {
  const { execFileSync } = require('child_process');
  const fs2 = require('fs');
  const os2 = require('os');
  const candidates = process.platform === 'darwin'
    ? ['pbcopy']
    : ['wl-copy', 'xclip -selection clipboard', 'xsel --clipboard --input'];
  // Writes to a real temp file and lets the target command read it via a plain shell `<`
  // redirect, rather than piping the text straight through execFileSync's own `input` option —
  // more robust for large output (no pipe-buffer-size edge cases) and, per real testing this
  // session, sidesteps a multi-byte-UTF-8 corruption that showed up when piping through certain
  // synthetic pty layers (isolated all the way down to a bare `sh -c "pbcopy < file"` with zero
  // JS involved, reproducible only under a test harness's own synthetic pty allocation — not a
  // real terminal, and not this app's own code). This path is unaffected either way.
  const tmp = path.join(os2.tmpdir(), `icarus-clip-${process.pid}-${Date.now()}.txt`);
  try {
    fs2.writeFileSync(tmp, text, 'utf8');
    for (const cmd of candidates) {
      try {
        execFileSync('sh', ['-c', `${cmd} < ${JSON.stringify(tmp)}`], { stdio: ['ignore', 'ignore', 'ignore'] });
        return cmd.split(' ')[0];
      } catch (_) { /* not installed / not on PATH — try the next candidate */ }
    }
    return null;
  } finally {
    try { fs2.unlinkSync(tmp); } catch (_) { /* already gone, or never created — fine either way */ }
  }
}
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

function transcriptViewport(transcript, { contentH, cols, scrollOffset = 0, pending = [] }) {
  // Keep redraw cheap at the live tail, but extend the source window as the user scrolls up.
  // The old fixed 800-line slice made scrollOffset faithfully move only inside its tail window;
  // beyond that it clamped and looked like the viewport was stuck on the latest user card.
  const retainedRawLines = Math.max(contentH * 4, 800, scrollOffset + contentH * 4);
  const wrapped = transcript.slice(-retainedRawLines).concat(pending).flatMap((line) => wrapLine(line, cols));
  const maxScroll = Math.max(0, wrapped.length - contentH);
  const offset = Math.min(Math.max(0, scrollOffset), maxScroll);
  const start = Math.max(0, wrapped.length - contentH - offset);
  return { visible: wrapped.slice(start, start + contentH), maxScroll, offset };
}

// ── Slash-command catalog (autocomplete source) ─────────────────────────────────────────────
const SLASH_COMMANDS = [
  { cmd: '/ingest', hint: '<dir> [--org name] [--full] [--local] [--force] [--keep-cloud]' },
  { cmd: '/recall', hint: '<query> [--org name] [--k 5] [--pq]' },
  { cmd: '/save', hint: '<text> [--org name] [--cloud]' },
  { cmd: '/llm-api', hint: '<openrouter-api-key> — save in macOS Keychain' },
  { cmd: '/model', hint: '[search|model-id] — browse or choose OpenRouter model' },
  { cmd: '/thinking', hint: 'off|minimal|low|medium|high|xhigh|max' },
  { cmd: '/chat', hint: '<query> [--org name] — grounded recall + synthesis' },
  { cmd: '/skill', hint: 'create <persona brief> | select [name] | default' },
  { cmd: '/status', hint: 'memories, evidence, relationships, shards' },
  { cmd: '/org', hint: '<name> — switch the default org for this session' },
  { cmd: '/create', hint: '<org> <path> — new org shard rooted at that repo path' },
  { cmd: '/delete', hint: 'pick an org and permanently delete its shard (double confirm)' },
  { cmd: '/copy', hint: '[n] — copy the last command\'s output (or last n lines) to the clipboard' },
  { cmd: '/setup', hint: '<claude|codex|cursor|--all> — register MCP + project instructions + repo shard' },
  { cmd: '/graph', hint: 'build|status|query — native symbol/call graph for this repo' },
  { cmd: '/connect', hint: 'browser sign-in to HIVEMIND' },
  { cmd: '/update', hint: 'download + verify the latest release' },
  { cmd: '/help', hint: 'full command list' },
  { cmd: '/quit', hint: 'ctrl+d also works' },
];

function printHelp(state) {
  out(state, '');
  out(state, heading('Commands'));
  out(state, `  ${c.command('/ingest')} [dir|file] [--org name] [--full] [--local] [--force] [--keep-cloud]  ingest a folder or a single file — leave the path off to open a native file/folder picker. Connected ingest asks for evidence-only (fast, default) or both (adds memory/entity generation); --full chooses both non-interactively.`);
  out(state, `  ${c.command('/recall')} <query> [--org name] [--k 5] [--pq]     local recall, always. Real parallel hybrid (dense+lexical, RRF-merged); narrow-reranked if HIVEMIND connected, else the hybrid merge is final. Never HIVEMIND's shared recall (a real cross-tenant leak was found there).`);
  out(state, `  ${c.command('/save')} <text> [--org name] [--cloud]              uses the save_memory schema (tags/entities/verified relationships) when an LLM key is set; otherwise saves plain local text. --cloud also writes the canonical HIVEMIND memory.`);
  out(state, `  ${c.command('/llm-api')} <openrouter-api-key>                     save an OpenRouter key in macOS Keychain; it is never written to config or echoed.`);
  out(state, `  ${c.command('/model')} [search|model-id]                           browse text models or set the synthesis model.`);
  out(state, `  ${c.command('/thinking')} <off|minimal|low|medium|high|xhigh|max> set only an effort supported by the selected model.`);
  out(state, `  ${c.command('/chat')} <query> [--org name]                        local recall first, then source-cited OpenRouter synthesis. /recall remains raw.`);
  out(state, `  ${c.command('/status')}                                          org shards + real memory/evidence/relationship counts + signing/audit`);
  out(state, `  ${c.command('/connect')}                                         browser sign-in to HIVEMIND`);
  out(state, `  ${c.command('/org')} <name>                                      switch the default org for this session`);
  out(state, `  ${c.command('/create')} <org> <path>                             create a NEW org shard rooted at <path> (its own repo-local .icarus/data/<org> — this becomes that repo's org automatically, same auto-detection /setup uses).`);
  out(state, `  ${c.command('/delete')}                                           lists every org, pick one, then a real double confirmation before permanently deleting its whole shard — refuses if another live icarus process still has it open.`);
  out(state, `  ${c.command('/copy')} [n]                                        copy the LAST command's output to the system clipboard (pbcopy/xclip/xsel) — or the last n raw lines with a number. Mouse-wheel scrolling puts most terminals into a mode where click-drag no longer does native text selection; holding the terminal's own modifier key (often Option on macOS) still works, but this doesn't depend on that at all.`);
  out(state, `  ${c.command('/setup')} <claude|codex|cursor|--all>                run from this project's own folder: registers that agent's MCP server, writes its project instruction file (CLAUDE.md/AGENTS.md/.cursor rule) with this repo's own org name, creates a real .icarus/data/<org> shard here, then offers to build the code graph too.`);
  out(state, `  ${c.command('/graph')} build|status|query [--repo <dir>]         native symbol/call graph (Tree-sitter, no Python dep) for this repo — query needs --kind <callers_of|callees_of|imports_of|find> --name <symbol>.`);
  out(state, `  ${c.command('/update')}                                          download + verify the latest release, replace this binary`);
  out(state, `  ${c.command('/help')}                                             this list`);
  out(state, `  ${c.command('/quit')} / ${c.command('ctrl+d')}                                   exit`);
  out(state, '');
  out(state, 'Anything not starting with "/" is treated as ' + c.command('/chat <text>') + ' against the current org (streamed, grounded synthesis).');
}

function parseArgs(argStr) {
  const tokens = argStr.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const clean = tokens.map((t) => t.replace(/^["']|["']$/g, ''));
  const out2 = { _: [] };
  // Real bug this whitelist fixes: `/ingest --amar /some/path` (a plain typo for `--org amar`)
  // used to treat ANY unrecognized `--foo` as a value-flag and swallow the very next token as
  // its value — so the real positional path argument silently vanished into out2.amar, leaving
  // out2._ empty and the command falling through to "no path given" / the folder picker instead
  // of the obviously-intended path. Only flag names every command actually reads as a value
  // (grep-verified against every `flags.xxx`/`flags['xxx']` in this file) consume the next
  // token; anything else is treated as a harmless boolean so positional args stay intact.
  const boolFlags = new Set(['local', 'force', 'pq', 'no-mirror', 'keep-cloud', 'cloud', 'full']);
  const valueFlags = new Set(['org', 'name', 'kind', 'repo', 'k']);
  for (let i = 0; i < clean.length; i++) {
    if (clean[i].startsWith('--')) {
      const name = clean[i].slice(2);
      if (boolFlags.has(name)) out2[name] = true;
      else if (valueFlags.has(name)) out2[name] = clean[++i];
      else out2[name] = true; // unknown flag -- boolean, never eats the next positional token
    } else out2._.push(clean[i]);
  }
  return out2;
}

// ── Output capture: routes dispatch()'s console.log/stdout.write into the transcript pane ──
function out(state, text) { writeToTranscript(state, String(text) + '\n'); }

// A progress tick is a terminal control update, not an incomplete chat token. In particular, it
// arrives as one `\r...` write with no newline. Preserve that replacement meaning before the
// generic partial-token buffering below; otherwise each tick is held until the next one and the
// old status becomes a literal prefix of the new status (the repeated `.docxdocx...` corruption
// seen during multi-file ingest).
function recordProgressTick(state, chunk) {
  const content = String(chunk).slice(1);
  state._pendingPartial = '';
  if (state._spinnerActive && state.transcript.length) state.transcript[state.transcript.length - 1] = content;
  else state.transcript.push(content);
  state._spinnerActive = true;
}

function writeProgressTick(state, chunk) {
  recordProgressTick(state, chunk);
  scheduleRedraw(state);
}

function shortenProgressFile(file, cols) {
  if (!file) return file;
  const max = Math.max(24, Math.floor((cols || 80) * 0.34));
  if (file.length <= max) return file;
  const left = Math.ceil((max - 1) * 0.62);
  return `${file.slice(0, left)}…${file.slice(-(max - left - 1))}`;
}

function tuiProgressLine(event, spinner, cols = process.stdout.columns || 80) {
  return formatHivemindProgress({ ...event, file: shortenProgressFile(event.file, cols) }, spinner);
}

const INGEST_PHASE = { uploading: 1, queued: 2, processing: 3, mirroring: 4, purging: 5, complete: 6, duplicate: 3, unavailable: 6, pending: 6, failed: 6 };
const INGEST_PHASE_LABEL = { uploading: 'uploading', queued: 'queued', processing: 'extracting', mirroring: 'mirroring locally', purging: 'verifying', complete: 'complete', duplicate: 'already exists', unavailable: 'duplicate unavailable to mirror', pending: 'processing later', failed: 'failed' };

// A folder ingest is sequential, so make that truth visible: one durable row per file. The bar
// represents observed lifecycle stages rather than pretending to know an extractor percentage.
function tuiIngestQueueLine(event, spinner, cols = process.stdout.columns || 80) {
  const phase = event.phase || 'uploading';
  const stage = INGEST_PHASE[phase] || 1;
  const width = 14;
  const filled = Math.min(width, Math.floor((stage / 6) * width));
  const bar = `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
  const terminal = phase === 'complete' || phase === 'pending' || phase === 'failed';
  const mark = phase === 'failed' ? c.error('✕') : terminal ? c.success('✓') : spinner;
  const file = shortenProgressFile(event.file, cols);
  return `  ${mark} [${bar}] ${event.current || event.completed || 0}/${event.total || 0}  ${INGEST_PHASE_LABEL[phase] || phase}  ${file || ''}`;
}

function tuiUpdateProgressLine({ received = 0, total = null, phase = 'downloading' }, spinner) {
  const width = 24;
  const knownTotal = Number.isFinite(total) && total > 0;
  const ratio = knownTotal ? Math.max(0, Math.min(1, received / total)) : 0;
  const filled = phase === 'verifying' ? width : Math.floor(ratio * width);
  const bar = `${c.success('█'.repeat(filled))}${c.dim('░'.repeat(width - filled))}`;
  const amount = knownTotal ? `${(received / 1e6).toFixed(1)}/${(total / 1e6).toFixed(1)} MB` : `${(received / 1e6).toFixed(1)} MB`;
  const label = phase === 'verifying' ? 'verifying SHA-256' : `downloading${knownTotal ? ` ${Math.floor(ratio * 100)}%` : ''}`;
  return `  ${spinner} [${bar}] ${amount}  ${label}`;
}

function chatRecallLines(hits, cols = process.stdout.columns || 80) {
  const modeLabel = hits[0]?.rerankFailed
    ? 'parallel hybrid · rerank fallback'
    : hits[0]?.mode === 'hybrid-reranked' ? 'parallel hybrid · reranked'
    : hits[0]?.mode === 'hybrid' ? 'parallel hybrid · RRF merged'
    : hits[0]?.mode === 'lexical' ? 'lexical / BM25'
    : 'local recall';
  const snippetWidth = Math.max(60, Math.min(220, cols - 18));
  return [
    '',
    heading(`recalled evidence · ${hits.length}`) + c.dim(`  ${modeLabel}`),
    ...hits.map((hit, index) => {
      const text = String(hit.text || '').replace(/\s+/g, ' ').trim();
      const snippet = text.length > snippetWidth ? `${text.slice(0, snippetWidth - 1)}…` : text;
      return `  ${c.dim(`[${index + 1}]`)} ${c.model(`[${Number(hit.score || 0).toFixed(4)}]`)} ${snippet}`;
    }),
    '',
  ];
}

function recordIngestQueue(state, event, spinner, cols = process.stdout.columns || 80) {
  const current = event.current || event.completed || 1;
  const isFirst = current === 1 && Number(event.completed || 0) === 0 && event.phase === 'uploading';
  if (!state._ingestQueue || isFirst) state._ingestQueue = { current: null, row: -1 };
  const queue = state._ingestQueue;
  const line = tuiIngestQueueLine(event, spinner, cols);
  if (queue.current === current && queue.row >= 0) state.transcript[queue.row] = line;
  else {
    state.transcript.push(line);
    queue.current = current;
    queue.row = state.transcript.length - 1;
  }
  if (['complete', 'pending', 'failed'].includes(event.phase)) queue.current = null;
}

function updateIngestQueue(state, event, spinner) {
  recordIngestQueue(state, event, spinner);
  scheduleRedraw(state);
}

// The status view is an index dashboard, not a log. Each org gets one compact card so the eye
// can compare its memory, evidence, and relationship inventory on a single scan.
function statusCardLines(shard, rich, richErr = null) {
  const size = `${(shard.bytesOnDisk / 1e6).toFixed(2)} MB`;
  const title = `${m.faint('┌─')} ${m.bold(shard.org)} ${m.faint('·')} ${m.muted(size)}`;
  if (rich && !rich.unavailable) {
    const memory = rich.memories !== rich.memoriesLatest ? `${rich.memoriesLatest} current` : String(rich.memoriesLatest);
    return [
      title,
      ` ${m.faint('│')} ${m.faint('MEMORY')} ${m.bold(memory.padStart(8))}   ${m.faint('EVIDENCE')} ${m.bold(String(rich.evidenceAndOther).padStart(8))}   ${m.faint('RELATIONS')} ${m.bold(String(rich.relationships).padStart(5))}`,
      m.faint('└────────────────────────────────────────'),
    ];
  }
  const reason = rich?.unavailable ? 'counts busy — shard open in another ICARUS session' : `counts unavailable — ${richErr || 'unknown error'}`;
  return [title, ` ${m.faint('│')} ${m.muted(reason)}`, m.faint('└────────────────────────────────────────')];
}

/** A real y/n prompt from INSIDE a command handler (e.g. /setup asking "build the graph too?")
 * — the main stdin 'data' listener checks state._modalResolver first and routes the next
 * keypress here instead of the normal input-editing path, so no listener detach/reattach is
 * needed. Anything but y/n/enter is ignored (keeps waiting) rather than silently defaulting. */
function askYesNo(state, question) {
  return new Promise((resolve) => {
    out(state, `${question} ${c.dim('[y/n]')}`);
    scheduleRedraw(state);
    state._modalResolver = (key) => {
      if (key === 'y' || key === 'Y') { state._modalResolver = null; out(state, c.dim('y')); resolve(true); }
      else if (key === 'n' || key === 'N' || key === '\r' || key === '\n') { state._modalResolver = null; out(state, c.dim('n')); resolve(false); }
      // any other key: keep waiting, don't resolve
    };
  });
}

/** Ask which org an ingest should go into when the user didn't pass --org, instead of silently
 * dropping it into whatever org happens to be active that session — a real reported confusion
 * ("/ingest <path>" landed in org "default" with no indication that's what would happen). Lists
 * every org that already exists, with its real on-disk size and a real creation date (never
 * fabricated), then a single numeric keypress both picks and confirms via the same one-keystroke
 * modal pattern askYesNo already uses. Typing a brand-new org name isn't handled here (that
 * would need a second, full line-editing input path this TUI doesn't have yet) — that case is
 * pointed at the existing `--org <name>` flag instead. Returns the chosen org, or null if the
 * user backed out (caller must treat null as "abort the ingest", not "use the default"). */
async function chooseOrgInteractive(state, cfg) {
  const orgs = listOrgsWithMeta(cfg);
  if (!orgs.length) return state.org; // nothing to choose between yet -- first-ever ingest
  out(state, c.system('which org should this go into?'));
  orgs.forEach((o, i) => {
    const mb = (o.bytesOnDisk / (1024 * 1024)).toFixed(2);
    const created = o.createdAt ? new Date(o.createdAt).toLocaleDateString() : 'unknown date';
    out(state, `  ${c.command(`[${i + 1}]`)} ${c.path(o.org)}  ${c.dim(`${mb} MB, created ${created}`)}`);
  });
  out(state, c.dim(`  [n] a different org — cancel and re-run: /ingest <path> --org <name>`));
  const picked = await new Promise((resolve) => {
    scheduleRedraw(state);
    state._modalResolver = (key) => {
      if (key === 'n' || key === 'N') { state._modalResolver = null; resolve(null); return; }
      const n = parseInt(key, 10);
      if (Number.isInteger(n) && n >= 1 && n <= orgs.length) { state._modalResolver = null; resolve(orgs[n - 1].org); }
      // any other key: keep waiting, don't resolve
    };
  });
  if (!picked) { out(state, c.dim('  cancelled — re-run: /ingest <path> --org <name>')); return null; }
  out(state, c.dim(`  → ${picked}`));
  const confirmed = await askYesNo(state, `Ingest into org "${picked}"?`);
  return confirmed ? picked : null;
}

// Connected ingest has two real server modes. Make the slower memory/entity promotion an
// explicit choice instead of silently charging it to every document upload. `e` is deliberately
// the default-looking first option: evidence remains searchable through the same hybrid recall.
async function chooseIngestMode(state) {
  out(state, heading('ingest mode'));
  out(state, `  ${c.command('[e]')} evidence only  ${c.dim('fast — lexical + semantic evidence, no memories/entities')}`);
  out(state, `  ${c.command('[b]')} both           ${c.dim('slower — evidence plus memory/entity/relationship generation')}`);
  out(state, c.dim('  choose e or b'));
  return new Promise((resolve) => {
    scheduleRedraw(state);
    state._modalResolver = (key) => {
      if (key === 'e' || key === 'E' || key === '\r' || key === '\n') { state._modalResolver = null; resolve('evidence'); }
      else if (key === 'b' || key === 'B') { state._modalResolver = null; resolve('both'); }
    };
  });
}

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
  const banded = `${BG_BAND}${BOLD}${FG_DEFAULT}${left}${' '.repeat(pad)}${FG_MUTED}${clock}${RESET}`;
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
  if (chunk.startsWith('\r') && !chunk.includes('\n')) {
    writeProgressTick(state, chunk);
    return;
  }
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

function modelPickerMatches(picker) {
  return selectOpenRouterModels(picker.models, picker.query, 8);
}
function modelPickerLines(state) {
  const picker = state._modelPicker;
  if (!picker) return [];
  const matches = modelPickerMatches(picker);
  const selected = Math.min(picker.selected, Math.max(0, matches.length - 1));
  picker.selected = selected;
  const lines = [heading('Choose synthesis model'), `${m.faint('Search:')} ${m.bright(picker.query || 'all OpenRouter text models')}`];
  if (!matches.length) lines.push(err('no matching text model — keep typing or Esc to cancel'));
  matches.forEach((model, i) => {
    const active = i === selected;
    const mark = active ? c.success('›') : m.faint(' ');
    const detail = `${model.name || ''}${model.reasoning ? ' · thinking' : ''}`;
    lines.push(` ${mark} ${active ? c.command(model.id) : m.normal(model.id)}  ${m.faint(detail)}`);
  });
  lines.push(m.faint('↑/↓ choose · type to search · Enter selects · Esc cancels'));
  return lines;
}
function openModelPicker(state, cfg, models, query = '') {
  state._modelPicker = { models, query, selected: 0 };
  state._modalResolver = (key) => {
    const picker = state._modelPicker;
    if (!picker) return;
    const matches = modelPickerMatches(picker);
    if (key === '\x1b') { state._modelPicker = null; state._modalResolver = null; out(state, c.dim('  model selection cancelled.')); scheduleRedraw(state); return; }
    if (key === '\r' || key === '\n') {
      const chosen = matches[picker.selected];
      if (!chosen) return;
      cfg.llm = { ...(cfg.llm || {}), disabled: false, provider: 'openrouter', endpoint: 'https://openrouter.ai/api/v1', model: chosen.id, modelSelected: true };
      saveCfg(cfg);
      state._modelPicker = null; state._modalResolver = null;
      out(state, ok(`synthesis model set to ${chosen.id}.`)); scheduleRedraw(state); return;
    }
    if (key === '\x1b[A') { picker.selected = Math.max(0, picker.selected - 1); scheduleRedraw(state); return; }
    if (key === '\x1b[B') { picker.selected = Math.min(Math.max(0, matches.length - 1), picker.selected + 1); scheduleRedraw(state); return; }
    if (key === '\x7f' || key === '\b') { picker.query = picker.query.slice(0, -1); picker.selected = 0; scheduleRedraw(state); return; }
    if (key.length === 1 && key >= ' ') { picker.query += key; picker.selected = 0; scheduleRedraw(state); }
  };
  scheduleRedraw(state);
}
function skillPickerLines(state) {
  const picker = state._skillPicker;
  if (!picker) return [];
  const selected = Math.min(picker.selected, Math.max(0, picker.skills.length - 1)); picker.selected = selected;
  return [heading(`Choose persona skill · ${picker.org}`), ...picker.skills.map((skill, i) => ` ${i === selected ? c.success('›') : m.faint(' ')} ${i === selected ? c.command(skill.slug) : m.normal(skill.slug)}  ${m.faint(skill.description || '')}`), m.faint('↑/↓ choose · Enter activates · Esc cancels')];
}
function openSkillPicker(state, cfg, org, skills) {
  state._skillPicker = { org, skills, selected: 0 };
  state._modalResolver = (key) => {
    const p = state._skillPicker; if (!p) return;
    if (key === '\x1b') { state._skillPicker = null; state._modalResolver = null; out(state, c.dim('  skill selection cancelled.')); scheduleRedraw(state); return; }
    if (key === '\r' || key === '\n') { const chosen = p.skills[p.selected]; if (!chosen) return; selectPersonaSkill(chosen.slug, org, cfg); state._skillPicker = null; state._modalResolver = null; out(state, ok(`persona skill "${chosen.slug}" is now active for org "${org}".`)); scheduleRedraw(state); return; }
    if (key === '\x1b[A') p.selected = Math.max(0, p.selected - 1);
    if (key === '\x1b[B') p.selected = Math.min(p.skills.length - 1, p.selected + 1);
    scheduleRedraw(state);
  }; scheduleRedraw(state);
}

function redraw(state) {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const matches = autocompleteMatches(state.input);
  const dropdown = matches.slice(0, 6);
  const dropdownH = dropdown.length;
  const picker = [...modelPickerLines(state), ...skillPickerLines(state)];
  const pickerH = picker.length;
  const cfg = loadCfg();

  const inputH = 3;
  const tipH = 1;
  // Persistent, by explicit request: the hero box (the big ASCII logo + version/status lines)
  // stays on screen for the WHOLE session, not just the pre-first-command splash a prior fix
  // made it. That prior fix existed because a permanent hero shrinks contentH and therefore the
  // scrollback window — but real PageUp/PageDown/mouse-wheel scrolling exists now (state.scrollOffset,
  // added alongside this change), so "less of it visible at once" no longer means "silently gone
  // forever" the way it did before scrolling existed. RECENT_RAW_LINES below is bumped with a
  // higher fixed floor for the same reason: a smaller, permanent contentH should still leave real
  // depth to scroll back into, not just the same few screens worth. Only degrades to no hero at
  // all on a genuinely tiny terminal (the same >=4-visible-content-row floor as before) rather
  // than rendering a broken/negative layout.
  const hero = heroBoxLines(cfg, state, cols);
  const heroH = (rows - hero.length - pickerH - dropdownH - inputH - tipH) >= 4 ? hero.length : 0;
  const contentH = Math.max(1, rows - heroH - pickerH - dropdownH - inputH - tipH);

  const pending = state._pendingPartial ? [state._pendingPartial] : [];
  // Real perf bug caught live ("jerking", "stuck", "slow" on a real terminal after a long
  // session): this used to wrap/measure EVERY line ever written to the transcript, on EVERY
  // redraw — called on every single keystroke. Cost grew with total session history, not with
  // what's actually on screen, so a session with hundreds of lines of accumulated ingest/recall
  // output made every keystroke redo work proportional to the WHOLE session so far. Only the
  // last few dozen raw lines can ever end up visible in contentH rows (wrapping only ever
  // SPLITS a line into more rows, never fewer) — slice to a bounded recent window before
  // wrapping, so redraw cost stays roughly constant regardless of how long the session has run.
  // Floor bumped from 200 -> 800: with the hero box now persistent (shrinking contentH for the
  // whole session, not just before the first command), a smaller contentH would otherwise also
  // shrink the retained scrollback window right when real depth to scroll into matters most.
  // scrollOffset is measured in wrapped display rows, not source lines, so long answers and
  // narrow terminals retain correct page movement.
  const viewport = transcriptViewport(state.transcript, { contentH, cols, scrollOffset: state.scrollOffset || 0, pending });
  state.scrollOffset = viewport.offset;
  const visible = viewport.visible;
  const padCount = Math.max(0, contentH - visible.length);

  const frame = [];
  if (heroH) frame.push(...hero);
  frame.push(...visible);
  frame.push(...Array(padCount).fill(''));
  frame.push(...picker);
  for (const d of dropdown) frame.push(`  ${m.bright(d.cmd)} ${m.faint(d.hint)}`);
  frame.push(state.scrollOffset > 0
    ? m.faint(`↑ scrolled up ${state.scrollOffset} lines — PgDn or scroll down to return to live output`)
    : m.faint('Type a command, or plain text to chat. Tab completes, ↑/↓ browse history, PgUp/wheel scrolls back.'));
  const { lines: inputLines, cursorCol } = inputBoxFrame(state, cols);
  frame.push(...inputLines);

  // Every row is padded to the FULL terminal width and painted on the black background, so no
  // stale glyph from a previous longer frame survives underneath (the alternative — clearing
  // the whole screen each frame — flickers visibly on a real terminal).
  const body = frame.map((l) => {
    const pad = Math.max(0, cols - visLen(l));
    // Every m.xxx() span ends with a bare RESET (\x1b[0m), which clears BOTH the background AND
    // the foreground — so any content built from more than one styled span (or followed by
    // trailing pad spaces, or plain UNSTYLED text like a lot of recall-result body content that
    // dispatch() writes with no color function at all) falls through to the terminal's OWN
    // default colors between/after them. Two real bugs from this: white rectangles behind short
    // lines (background), and washed-out/dim-looking plain text that was actually inheriting
    // the terminal's own default foreground instead of a real bright white — caught from a real
    // screenshot next to grok-build's own crisp white-on-black look. Re-assert BOTH the black
    // background and a bright white foreground after every internal reset, not just once at the
    // very start of the line.
    const forced = l.split(RESET).join(RESET + BG_BLACK + FG_DEFAULT);
    return BG_BLACK + FG_DEFAULT + forced + ' '.repeat(pad) + RESET;
  }).join('\r\n');

  // Input row = the box's MIDDLE line: everything above it, plus its own top border, plus 1
  // to convert the 0-indexed count into a 1-indexed terminal row.
  const inputRowIndex = heroH + visible.length + padCount + pickerH + dropdownH + tipH + 1 + 1;
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
function enterScreen() { realWrite(ENTER_ALT + CLEAR_HOME + ENABLE_MOUSE); }
let exited = false;
function exitScreen() {
  if (exited) return;
  exited = true;
  restoreOutput();
  try { process.stdin.setRawMode(false); } catch (_) { /* not a TTY / already restored */ }
  realWrite(DISABLE_MOUSE + SHOW_CURSOR + EXIT_ALT);
}

async function run() {
  const cfg = loadCfg();
  const state = {
    org: 'default', transcript: [], input: '', cursor: 0, history: [], historyIdx: -1,
    _pendingPartial: '', _spinnerActive: false, scrollOffset: 0,
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
      userRow(state, line.startsWith('/llm-api ') ? '/llm-api [redacted]' : line);
      const outputStart = state.transcript.length; // bookmark for /copy — see its own doc comment
      const t0 = Date.now();
      try { await dispatch(line, state, cfg); } catch (e) { out(state, err(e.message || String(e))); }
      state._lastOutputRange = [outputStart, state.transcript.length];
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
    state.scrollOffset = 0; // a new command always jumps back to the live tail, like any chat UI
    state.history.push(line.startsWith('/llm-api ') ? '/llm-api [redacted]' : line);
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
  // Also recognizes PageUp/PageDown (`\x1b[5~`/`\x1b[6~`) and SGR mouse-wheel reports
  // (`\x1b[<64;...M` / `\x1b[<65;...M`, enabled via ENABLE_MOUSE at screen entry) as single
  // tokens — without this they'd get shredded into their raw bytes (`\x1b`, `[`, `5`, `~`, ...)
  // and leak straight into the input line as garbage characters, since nothing recognized them
  // as one unit.
  function tokenize(chunk) {
    const tokens = [];
    let i = 0;
    while (i < chunk.length) {
      if (chunk[i] === '\x1b' && chunk[i + 1] === '[') {
        const rest = chunk.slice(i);
        let m2 = /^\x1b\[<\d+;\d+;\d+[Mm]/.exec(rest);
        if (m2) { tokens.push(m2[0]); i += m2[0].length; continue; }
        m2 = /^\x1b\[[56]~/.exec(rest);
        if (m2) { tokens.push(m2[0]); i += m2[0].length; continue; }
        m2 = /^\x1b\[[A-D]/.exec(rest);
        if (m2) { tokens.push(m2[0]); i += m2[0].length; continue; }
      }
      tokens.push(chunk[i]); i++;
    }
    return tokens;
  }

  process.stdin.on('data', (chunk) => {
    if (!running) return;
    for (const key of tokenize(chunk)) {
      // A pending yes/no prompt (askYesNo(), used by /setup's graph-build offer) intercepts the
      // very next keypress instead of the normal input-editing logic below — no need to detach/
      // reattach this listener, just route around it while a modal is active.
      if (state._modalResolver) { state._modalResolver(key); continue; }
      // Scrollback: PageUp/PageDown and mouse-wheel both move state.scrollOffset (redraw() clamps
      // it to the real available history every frame). SCROLL_STEP for keys is a full page so
      // PageUp/PageDown feel like an actual page flip; WHEEL_STEP is smaller since a single wheel
      // notch is one of several rapid-fire events, not one deliberate keypress.
      if (key === '\x1b[5~') { state.scrollOffset = (state.scrollOffset || 0) + 10; scheduleRedraw(state); continue; } // PageUp
      if (key === '\x1b[6~') { state.scrollOffset = Math.max(0, (state.scrollOffset || 0) - 10); scheduleRedraw(state); continue; } // PageDown
      if (key.startsWith('\x1b[<')) {
        const mm = /^\x1b\[<(\d+);\d+;\d+[Mm]/.exec(key);
        const btn = mm ? parseInt(mm[1], 10) : -1;
        if (btn === 64) { state.scrollOffset = (state.scrollOffset || 0) + 3; scheduleRedraw(state); } // wheel up
        else if (btn === 65) { state.scrollOffset = Math.max(0, (state.scrollOffset || 0) - 3); scheduleRedraw(state); } // wheel down
        continue; // any other mouse report (clicks, drags) — ignore, never fall into text-input handling
      }
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
        if (!state.input) { state.scrollOffset = (state.scrollOffset || 0) + 3; scheduleRedraw(state); continue; }
        if (autocompleteMatches(state.input).length) continue; // reserved for future dropdown-select; history for now falls through below when no dropdown
        if (state.historyIdx > 0) { state.historyIdx--; state.input = state.history[state.historyIdx]; state.cursor = state.input.length; }
        continue;
      }
      if (key === '\x1b[B') {
        if (!state.input && state.scrollOffset > 0) { state.scrollOffset = Math.max(0, state.scrollOffset - 3); scheduleRedraw(state); continue; }
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
  if (!line.startsWith('/')) return dispatch(`/chat ${line}`, state, cfg);
  const spaceIdx = line.indexOf(' ');
  const cmd = (spaceIdx === -1 ? line.slice(1) : line.slice(1, spaceIdx)).toLowerCase();
  const argStr = spaceIdx === -1 ? '' : line.slice(spaceIdx + 1);
  const flags = parseArgs(argStr);
  const org = flags.org || state.org;

  switch (cmd) {
    case 'llm-api': {
      const key = argStr.trim();
      if (!key) { out(state, err('usage: /llm-api <openrouter-api-key>')); break; }
      setOpenRouterApiKey(key, cfg);
      out(state, ok('OpenRouter API key saved in macOS Keychain. Run /model to choose a synthesis model.'));
      break;
    }
    case 'model': {
      if (!openRouterApiKey(cfg)) { out(state, err('no LLM API key set — use /llm-api <openrouter-api-key> and then try again')); break; }
      const models = await fetchOpenRouterModels();
      openModelPicker(state, cfg, models, argStr.trim());
      break;
    }
    case 'thinking': {
      if (!openRouterApiKey(cfg)) { out(state, err('no LLM API key set — use /llm-api <openrouter-api-key> and then try again')); break; }
      const effort = argStr.trim().toLowerCase();
      if (!effort) { out(state, c.dim(`thinking: ${cfg.llm?.thinking || 'off'} — set with /thinking <off|minimal|low|medium|high|xhigh|max>`)); break; }
      if (effort === 'off' || effort === 'none') {
        cfg.llm = { ...(cfg.llm || {}), thinking: 'off' }; saveCfg(cfg); out(state, ok('thinking disabled.')); break;
      }
      const model = resolveSynthesisModel(cfg);
      const meta = await fetchOpenRouterModel(model);
      if (!meta.reasoning?.supported_efforts?.includes(effort)) { out(state, err(`${model} does not support thinking effort "${effort}". Supported: ${(meta.reasoning?.supported_efforts || []).join(', ') || 'none'}`)); break; }
      cfg.llm = { ...(cfg.llm || {}), thinking: effort }; saveCfg(cfg); out(state, ok(`thinking set to ${effort} for ${model}.`));
      break;
    }
    case 'chat': {
      const query = argStr.replace(/\s--org\s+[^\s]+/, '').trim();
      if (!query) { out(state, err('usage: /chat <query> [--org name]')); break; }
      out(state, c.running('  recalling local evidence and synthesizing...'));
      const hits = await recallQuery(query, org, cfg, 8);
      chatRecallLines(hits).forEach((line) => out(state, line));
      out(state, `\n${heading(`chat · ${resolveSynthesisModel(cfg)}`)}\n`);
      let result;
      try {
        result = await chatWithOpenRouter(query, org, cfg, { hits, onToken: (token) => writeToTranscript(state, token) });
      } catch (e) {
        const failure = classifyChatFailure(e);
        out(state, '');
        out(state, err(failure.message));
        out(state, c.dim(`  synthesis outcome: ${failure.kind}`));
        break;
      }
      // Flush the final partial token buffer before printing the grounding footer.
      out(state, '');
      out(state, c.dim(`\n  grounded in ${result.hits.length} local recall result(s); source markers [n] refer to that recalled evidence.`));
      break;
    }
    case 'skill': {
      const [sub, ...rest] = flags._;
      if (sub === 'create') {
        const brief = rest.join(' ').trim();
        if (!brief) { out(state, err('usage: /skill create <describe the persona in natural language>')); break; }
        out(state, c.running('  writing persona skill with the selected model...'));
        const saved = await createPersonaSkill(brief, org, cfg);
        out(state, saved ? ok(`persona skill "${saved.slug}" created and active for org "${org}".`) : err('could not create persona skill — set an LLM API key first'));
      } else if (sub === 'select') {
        const slug = rest.join(' ').trim();
        const skills = skillList(org).filter((s) => s.slug.startsWith('persona-')).map((s) => ({ ...s, slug: s.slug.replace(/\.persona$/, '') }));
        if (!slug) { if (!skills.length) out(state, c.dim('  no persona skills yet — create one with /skill create <persona brief>')); else openSkillPicker(state, cfg, org, skills); break; }
        out(state, selectPersonaSkill(slug, org, cfg) ? ok(`persona skill "${slug}" is now active for org "${org}".`) : err(`no persona skill named "${slug}" in org "${org}"`));
      } else if (sub === 'default') { clearPersonaSkill(org, cfg); out(state, ok(`ICARUS default persona restored for org "${org}".`)); }
      else out(state, err('usage: /skill create <persona brief> | /skill select [name] | /skill default'));
      break;
    }
    case 'ingest': {
      let dir = flags._[0];
      if (!dir) {
        // Both supported, per the exact ask: a typed path works as before, and pressing enter
        // on bare "/ingest" opens the OS's real native folder picker (Finder's own "choose
        // folder" dialog on macOS via osascript, zenity/kdialog on Linux) instead of forcing
        // everyone to paste a path. Async, not execFileSync — the redraw loop and stdin
        // handling keep running while the dialog is open, so the TUI doesn't freeze on it.
        out(state, c.dim('  no path given — opening the native folder picker...'));
        dir = await pickFolderNative(`icarus: select a folder to ingest into org "${flags.org || state.org}"`);
        if (!dir) { out(state, err('no file or folder selected — usage: /ingest <dir|file> [--org name] [--local] [--force] [--no-mirror] [--keep-cloud]')); break; }
        out(state, ok(`selected ${c.path(dir)}`));
      }
      // Real reported confusion: a bare "/ingest <path>" (no --org) silently landed in whatever
      // org happened to be active, with no indication that's what would happen. When --org is
      // actually given, skip straight past this — no reason to interrupt an explicit choice.
      let ingestOrg = flags.org;
      if (!ingestOrg) {
        ingestOrg = await chooseOrgInteractive(state, cfg);
        if (!ingestOrg) { out(state, err('ingest cancelled — no org selected')); break; }
      }
      const viaHivemind = hivemindConfigured(cfg) && !flags.local;
      const skipReason = noIngestableFilesReason(dir, viaHivemind ? HIVEMIND_INGESTABLE_EXTS : undefined);
      if (skipReason) { out(state, err(skipReason)); break; }
      if (viaHivemind) {
        const ingestMode = flags.full ? 'both' : await chooseIngestMode(state);
        out(state, c.dim(`  → ${ingestMode === 'evidence' ? 'evidence only' : 'evidence + memory generation'}`));
        out(state, bullet(c.system(`ingesting into HIVEMIND, org "${c.path(ingestOrg)}"...`)));
        let tick = 0;
        const result = await hivemindIngestDir(dir, ingestOrg, cfg, (event) => updateIngestQueue(state, event, c.running(spinnerFrame(tick++))), { force: !!flags.force, mirrorLocal: !flags['no-mirror'], purgeCloud: !flags['keep-cloud'], ingestMode });
        state._ingestQueue = null;
        const notes = [];
        if (result.duplicates) notes.push(`${result.duplicates} already in your knowledge base`);
        if (result.unavailableDuplicates) notes.push(`${result.unavailableDuplicates} duplicate document(s) unavailable to mirror — server repair required`);
        if (result.pending) notes.push(`${result.pending} still processing`);
        if (result.failed) notes.push(`${result.failed} failed — see errors above`);
        if (result.mirrored) notes.push(`${result.mirrored} segments mirrored locally`);
        if (result.remoteSegments) notes.push(`${result.remoteSegments} new server segments`);
        if (result.purged) notes.push(`${result.purged} cloud doc(s) purged after mirroring`);
        if (result.skippedImages) notes.push(`${result.skippedImages} image(s) skipped — no fetchable HIVEMIND document for images`);
        const outcome = ingestMode === 'evidence'
          ? `${result.chunks} local evidence segments`
          : `${result.live} memories, ${result.chunks} segments`;
        const action = result.unavailableDuplicates ? `incomplete: ${result.files} files checked` : result.duplicates === result.files ? `checked ${result.files} existing files` : `ingested ${result.files} files`;
        out(state, `\n${ok(`${action} → ${outcome} (${ingestMode})`)}${notes.length ? c.dim(` — ${notes.join(', ')}`) : ''}`);
      } else {
        let tick = 0;
        const result = await ingestDir(dir, ingestOrg, cfg, (n) => process.stdout.write(`\r  ${c.running(spinnerFrame(tick++))} ${n} chunks`));
        out(state, `\n${ok(`ingested ${result.chunks} chunks from ${result.files} files (mode=${result.mode})`)}`);
      }
      break;
    }
    case 'recall': {
      const q = argStr.trim();
      if (!q) { out(state, err('usage: /recall <query> [--org name] [--k 5]')); break; }
      const k = Number(flags.k || 5);
      const hits = await recallQuery(q, org, cfg, k, !!flags.pq);
      const modeLabel = hits[0]?.rerankFailed
        ? c.command(` (rerank failed — showing raw RRF scores, not calibrated: ${hits[0].rerankError})`)
        : hits[0]?.mode === 'hybrid-reranked' ? c.dim(' (parallel hybrid, reranked)')
        : hits[0]?.mode === 'lexical' ? c.dim(' (lexical/BM25 only)')
        : hits[0]?.mode === 'hybrid' ? c.dim(' (parallel hybrid, RRF-merged — too few candidates to rerank)')
        : '';
      out(state, `\n${heading(`top ${hits.length}`)}${modeLabel}\n`);
      hits.forEach((h, i) => out(state, `  ${c.dim(String(i + 1).padStart(2))} ${c.assistant(glyphs.promptArrow)} ${c.model(`[${h.score.toFixed(4)}]`)} ${h.text.replace(/\s+/g, ' ').slice(0, 140)}`));
      break;
    }
    case 'save': {
      const text = flags._.join(' ').trim();
      if (!text) { out(state, err('usage: /save <text> [--org name] [--cloud]')); break; }
      const saved = await saveIntelligentMemory(text, org, cfg, { cloud: !!flags.cloud });
      if (saved.mode === 'structured') {
        out(state, ok(`saved with save_memory schema (id ${saved.id}) — ${saved.draft.entities.length} entities, ${saved.draft.tags.length} tags${saved.edge ? `, ${saved.edge.type} relationship` : ''}${saved.remote ? ', cloud canonical save' : ''}.`));
      } else {
        out(state, ok(`saved as a local memory in "${c.path(org)}"'s shard (embedded${embeddingsConfigured(cfg) ? '' : ' lexically — no LLM metadata available'}).`));
      }
      break;
    }
    case 'copy': {
      const n = flags._[0] ? parseInt(flags._[0], 10) : null;
      let lines;
      if (Number.isInteger(n) && n > 0) {
        lines = state.transcript.slice(-n);
      } else if (state._lastOutputRange) {
        // The range drainQueue() bookmarked around the PRECEDING dispatch call — /copy's own
        // call hasn't overwritten it yet at this point, so this is exactly "what the last real
        // command printed", not this /copy invocation's own (empty) output.
        const [start, end] = state._lastOutputRange;
        lines = state.transcript.slice(start, end);
      } else {
        out(state, err('nothing to copy yet — run a command first, or /copy <n> for the last n raw lines'));
        break;
      }
      const text = lines.map(stripAnsi).join('\n');
      if (!text.trim()) { out(state, err('nothing to copy — last output was empty')); break; }
      const tool = copyToClipboard(text);
      if (tool) out(state, ok(`copied ${lines.length} line(s) to the clipboard (via ${tool}).`));
      else out(state, err('no clipboard tool found (looked for pbcopy/wl-copy/xclip/xsel) — nothing copied.'));
      break;
    }
    case 'status': {
      const s = statusReport(cfg);
      out(state, `\n${heading('memory atlas')}  ${m.faint('local .amr index')}`);
      out(state, `${m.faint('root')} ${c.path(s.dataRoot)}  ${m.faint('dimension')} ${s.dim}`);
      out(state, `${m.faint('HIVEMIND')} ${s.hivemindConnected ? c.success('● connected') : c.dim('○ not connected')}   ${m.faint('SIGNING')} ${signingEnabled(cfg) ? c.success('● enabled') : c.dim('○ off')}`);
      out(state, m.faint('────────────────────────────────────────────────'));
      if (!s.shards.length) { out(state, c.dim('no shards yet')); break; }
      for (const sh of s.shards) {
        let rich = null, richErr = null;
        // richOrgStats() defaults to a single, no-retry attempt for /status -- an org actively
        // held open by a live MCP server (this project's own icarus tool connections, most of
        // the time, by design) used to mean a real ~6.7s freeze on EVERY /status just to render
        // one line of counts. unavailable:true is the instant, expected outcome now, not an
        // error -- the plain try/catch below still guards a genuinely different failure.
        try { rich = richOrgStats(sh.org, cfg); } catch (e) { richErr = e.message.split('\n')[0]; }
        statusCardLines(sh, rich, richErr).forEach((line) => out(state, line));
      }
      break;
    }
    case 'org': {
      if (flags._[0]) { state.org = flags._[0]; out(state, ok(`default org set to "${c.path(state.org)}"`)); }
      else out(state, c.dim(`current org: ${state.org}`));
      break;
    }
    case 'create': {
      // "the organisation is for that path root repo" -- initRepoShard() is the exact same
      // mechanism /setup already uses to create a repo-local shard, just exposed directly with
      // an explicit org name and an arbitrary path instead of always cwd + a derived name. Once
      // created, findRepoIcarusDataRoot() (loadCfg's own repo-walk) picks it up automatically the
      // next time icarus runs from inside that path -- no separate mapping to maintain.
      const newOrg = flags._[0];
      const repoPath = flags._[1];
      if (!newOrg || !repoPath) { out(state, err('usage: /create <org> <path>  — creates a new org shard rooted at <path>')); break; }
      const resolved = path.resolve(repoPath);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) { out(state, err(`not a directory: ${resolved}`)); break; }
      try {
        const { dataRoot, org: createdOrg } = initRepoShard(resolved, newOrg, cfg.dim);
        out(state, ok(`created org "${createdOrg}" rooted at ${c.path(resolved)} — shard: ${c.path(dataRoot)}. Running icarus from inside that path uses this org automatically.`));
      } catch (e) { out(state, err(e.message || String(e))); }
      break;
    }
    case 'delete': {
      // Real double confirmation, per the exact ask ("confirm twice surely want to delete") --
      // two SEPARATE y/n modals, the second restating the org name and byte count again rather
      // than just re-asking the same question, so a reflexive double-Enter doesn't accidentally
      // satisfy both checks with no real second look at what's being destroyed.
      const orgs = listOrgsWithMeta(cfg);
      if (!orgs.length) { out(state, err('no orgs exist yet — nothing to delete')); break; }
      out(state, c.system('which org should be permanently deleted?'));
      orgs.forEach((o, i) => {
        const mb = (o.bytesOnDisk / (1024 * 1024)).toFixed(2);
        out(state, `  ${c.command(`[${i + 1}]`)} ${c.path(o.org)}  ${c.dim(`${mb} MB`)}`);
      });
      out(state, c.dim('  [n] cancel'));
      const target = await new Promise((resolve) => {
        scheduleRedraw(state);
        state._modalResolver = (key) => {
          if (key === 'n' || key === 'N') { state._modalResolver = null; resolve(null); return; }
          const n = parseInt(key, 10);
          if (Number.isInteger(n) && n >= 1 && n <= orgs.length) { state._modalResolver = null; resolve(orgs[n - 1]); }
        };
      });
      if (!target) { out(state, c.dim('  cancelled — nothing deleted')); break; }
      const mb = (target.bytesOnDisk / (1024 * 1024)).toFixed(2);
      const stats = richOrgStats(target.org, cfg);
      const statsText = stats.unavailable
        ? '(memory count unavailable — actively open by another icarus process)'
        : `${stats.memories} memories, ${stats.relationships} relationships`;
      const firstOk = await askYesNo(state, `Delete org "${target.org}" — ${mb} MB, ${statsText}. This cannot be undone. Continue?`);
      if (!firstOk) { out(state, c.dim('  cancelled — nothing deleted')); break; }
      const secondOk = await askYesNo(state, `FINAL CONFIRMATION — permanently delete "${target.org}" and everything in it right now?`);
      if (!secondOk) { out(state, c.dim('  cancelled — nothing deleted')); break; }
      try {
        deleteOrgShard(cfg, target.org);
        if (state.org === target.org) state.org = 'default';
        out(state, ok(`deleted org "${target.org}"`));
      } catch (e) { out(state, err(e.message || String(e))); }
      break;
    }
    case 'connect': {
      const authUrl = process.env.HIVEMIND_URL || cfg.hivemind?.url || DEFAULT_HIVEMIND_AUTH_URL;
      const restUrl = process.env.HIVEMIND_API_URL || cfg.hivemind?.apiUrl || DEFAULT_HIVEMIND_API_URL;
      out(state, c.running('  Opening your browser...'));
      const oauth = await attemptHivemindOAuth(authUrl);
      if (oauth) {
        cfg.hivemind = { connected: true, url: authUrl, token: oauth.token, userEmail: oauth.userEmail, apiUrl: restUrl, connectedAt: new Date().toISOString() };
        saveCfg(cfg);
        out(state, ok(`HIVEMIND connected${oauth.userEmail ? ` as ${oauth.userEmail}` : ''}.`));
      } else {
        out(state, err('browser sign-in didn\'t complete — run `icarus connect` outside the TUI for the manual-token fallback.'));
      }
      break;
    }
    case 'update': {
      out(state, c.dim(`  checking latest version (current: v${ICARUS_VERSION})...`));
      const { current, latest, upToDate } = await checkForUpdate();
      if (upToDate) { out(state, ok(`already up to date (${current}).`)); break; }
      if (upToDate === null) out(state, c.dim('  couldn\'t check the latest version — trying the update anyway.'));
      else out(state, c.system(`  updating ${c.dim(current)} → ${c.bold(latest)}...`));
      out(state, bullet(c.system('downloading and verifying the new binary...')));
      let progressTick = 0;
      const update = await performSelfUpdate((progress) => writeProgressTick(state, `\r${tuiUpdateProgressLine(progress, c.running(spinnerFrame(progressTick++)))}`));
      out(state, ok(`updated to ${c.bold(latest || 'the latest release')} (${(update.bytes / 1e6).toFixed(1)} MB).`));
      out(state, c.dim(update.restartRequired
        ? '  Windows will replace the binary after this session exits — /quit, then restart icarus.'
        : '  this running session is still on the old build — /quit and restart icarus to use the new one.'));
      break;
    }
    case 'setup': {
      const arg = argStr.trim().toLowerCase();
      const mi = require('./mcp-install.js');
      const cwd = process.cwd();
      const icarusCmd = mi.resolveIcarusCommand();
      const validAgents = Object.keys(mi.AGENT_INSTALLERS);
      if (!arg || (arg !== '--all' && arg !== 'all' && !validAgents.includes(arg))) {
        out(state, err(`usage: /setup <${validAgents.join('|')}|--all>`));
        break;
      }
      async function setupOne(agentName) {
        const { mcp, global, project } = mi.AGENT_INSTALLERS[agentName];
        out(state, heading(agentName));
        const mcpResult = mcp(icarusCmd);
        out(state, mcpResult.installed ? ok(`registered: ${mcpResult.path}`) : c.dim(`skipped: ${mcpResult.reason}`));
        if (global) {
          const g = global();
          out(state, g.installed ? ok(`standing instructions: ${g.path}`) : c.dim(`standing instructions: ${g.reason}`));
        }
        const p = project(cwd);
        out(state, p.installed ? ok(`project instructions: ${p.path} (org "${p.orgName}")`) : c.dim(`project instructions: ${p.reason} (org "${p.orgName}")`));
        try {
          const shard = initRepoShard(cwd, p.orgName);
          out(state, ok(`shard: ${shard.dataRoot}/${shard.org}`));
        } catch (e) { out(state, err(`shard creation skipped: ${e.message}`)); }
        return p.orgName;
      }
      const agents = (arg === '--all' || arg === 'all') ? validAgents : [arg];
      for (const name of agents) await setupOne(name);
      out(state, ok(`setup done for ${agents.join(', ')} — restart the agent(s) above to pick up the MCP server.`));
      const buildGraph = await askYesNo(state, 'Build the native symbol/call graph for this repo too?');
      if (buildGraph) await dispatch('/graph build', state, cfg);
      // Real point of confusion this addresses: setup writes the project instruction file
      // (CLAUDE.md/AGENTS.md/.cursor rule) and registers the MCP server, but neither takes
      // effect in an agent session that's ALREADY running — a running Claude Code/Codex/Cursor
      // session read its instructions and MCP config once, at its own startup, before any of
      // this existed on disk. Nothing here changes that session retroactively; it has to actually
      // restart (or a fresh one has to open) to pick up the new project instructions and the MCP
      // server registration, after which its own baseline behavior is "brief with icarus usage"
      // automatically -- every prompt in that session already carries the instructions this setup
      // just wrote, with no separate step required per-conversation.
      out(state, '');
      out(state, heading('next step — restart required'));
      out(state, `  The instructions and MCP registration just written only take effect in a ${c.bold('new')} agent session.`);
      out(state, `  ${c.bold('Restart your current Claude Code / Codex / Cursor session, or open a new one')}, in this same project.`);
      out(state, `  From then on it reads the project instructions this setup wrote and already has icarus's MCP tools registered — no per-conversation step needed, it just works from the first prompt.`);
      break;
    }
    // Parent + subcommand, matching the CLI's own `icarus graph build/status/query --repo <dir>`
    // shape exactly (not a flat /graph-build) — one consistent convention across every icarus
    // surface (CLI, TUI, MCP tool names icarus_graph_build/status/query) so it stays predictable
    // wherever an agent or a person encounters it.
    case 'graph': {
      const sub = flags._[0];
      const gn = require('./graph-native.js');
      const repo = flags.repo || process.cwd();
      if (sub === 'build') {
        out(state, bullet(c.system(`building graph for ${c.path(repo)}...`)));
        const r = await gn.buildAndStore(repo);
        out(state, ok(`graph built: ${r.files} files, ${r.nodes} nodes, ${r.edges} edges`));
      } else if (sub === 'status') {
        const s = await gn.status(repo);
        out(state, s ? ok(`${s.files} files, ${s.nodes} nodes, ${s.edges} edges — last updated ${s.lastUpdated || '?'}`) : c.dim('no graph built yet for this repo — run /graph build'));
      } else if (sub === 'query') {
        const kind = flags.kind;
        const name = flags.name || argStr.split(' ').slice(1).join(' ');
        if (!kind || !name) { out(state, err('usage: /graph query --kind <callers_of|callees_of|imports_of|find> --name <symbol> [--repo <dir>]')); break; }
        out(state, JSON.stringify(await gn.query(repo, kind, name), null, 2));
      } else {
        out(state, err('usage: /graph <build|status|query> [--repo <dir>] [--kind <...> --name <...>]'));
      }
      break;
    }
    case 'help': printHelp(state); break;
    case 'quit': case 'exit': break; // handled in submit() before reaching dispatch
    default: out(state, err(`unknown command: /${cmd} — try /help`));
  }
}

// parseArgs and visLen are exported for tests, not for callers: parseArgs carries a real
// regression (an unrecognized --flag used to swallow the following positional argument, so
// `/ingest --typo /some/path` lost the path entirely) and visLen underpins every layout
// calculation. Untested, both are exactly the kind of quiet logic that breaks a release.
module.exports = { run, transcriptViewport, tuiProgressLine, shortenProgressFile, recordProgressTick, tuiIngestQueueLine, recordIngestQueue, statusCardLines, chatRecallLines, stripAnsi, parseArgs, visLen };
