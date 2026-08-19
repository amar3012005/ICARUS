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
  ICARUS_VERSION, checkForUpdate, performSelfUpdate, noIngestableFilesReason, HIVEMIND_INGESTABLE_EXTS,
  hivemindSaveMemory, saveLocalMemory,
} = require('./cli-lib.js');

// ── ANSI primitives ─────────────────────────────────────────────────────────────────────────
const ENTER_ALT = '\x1b[?1049h';
const EXIT_ALT = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_HOME = '\x1b[2J\x1b[H';
const moveTo = (row, col) => `\x1b[${row};${col}H`;

function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }
function visLen(s) { return stripAnsi(s).length; }

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
  out(state, `  ${c.command('/ingest')} <dir> [--org name] [--local] [--force] [--keep-cloud]  ingest a folder. HIVEMIND (when connected) is a stateless extraction pipeline only — segments mirror locally, then the cloud document icarus itself created is deleted (--keep-cloud to leave it there).`);
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
function topBarLine(cfg, state) {
  const hm = cfg.hivemind?.connected
    ? c.success('HIVEMIND connected' + (cfg.hivemind.userEmail ? ` as ${cfg.hivemind.userEmail}` : ''))
    : c.dim('HIVEMIND not connected');
  return ` ${c.bold(c.assistant('ICARUS'))} ${c.dim(`v${ICARUS_VERSION}`)}  ${c.dim('org:')} ${c.path(state.org)}  ${hm}`;
}

function inputBoxFrame(state, cols) {
  const width = cols - 2;
  const top = c.dim('╭' + '─'.repeat(width) + '╮');
  const bot = c.dim('╰' + '─'.repeat(width) + '╯');
  const prefix = `${c.assistant(glyphs.promptArrow)} `;
  const visiblePrefixLen = visLen(prefix);
  const maxTextWidth = width - visiblePrefixLen - 2;
  // Keep the cursor's column visible if the line is longer than the box — scroll the visible
  // window of `state.input` so `state.cursor` always stays on-screen.
  let viewStart = 0;
  if (state.cursor > maxTextWidth) viewStart = state.cursor - maxTextWidth;
  const visibleText = state.input.slice(viewStart, viewStart + maxTextWidth);
  const pad = Math.max(0, maxTextWidth - visLen(visibleText));
  const mid = `${c.dim('│')} ${prefix}${visibleText}${' '.repeat(pad)} ${c.dim('│')}`;
  const cursorCol = 2 + visiblePrefixLen + (state.cursor - viewStart) + 1; // 1-indexed terminal column within the row
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
  const topBarH = 1;
  const inputH = 3;
  const tipH = 1;
  const contentH = Math.max(1, rows - topBarH - dropdownH - inputH - tipH);

  // Word/ANSI-wrap the transcript to the real terminal width, then take the last `contentH`
  // wrapped rows — a real scrollback window, not a fixed-size ring buffer that silently drops
  // history off the front before it's ever been seen.
  const pending = state._pendingPartial ? [state._pendingPartial] : [];
  const allLines = state.transcript.concat(pending);
  const wrapped = allLines.flatMap((l) => wrapLine(l, cols));
  const visible = wrapped.slice(Math.max(0, wrapped.length - contentH));
  const padCount = Math.max(0, contentH - visible.length);

  const frame = [];
  frame.push(topBarLine(loadCfg(), state));
  frame.push(...visible);
  frame.push(...Array(padCount).fill(''));
  for (const m of dropdown) {
    frame.push(`  ${c.command(m.cmd)} ${c.dim(m.hint)}`);
  }
  frame.push(c.dim('Type a command, or plain text to recall. Tab completes, ↑/↓ browse history.'));
  const { lines: inputLines, cursorCol } = inputBoxFrame(state, cols);
  frame.push(...inputLines);

  const body = frame.map((l) => {
    const pad = Math.max(0, cols - visLen(l));
    return l + ' '.repeat(pad);
  }).join('\r\n');

  const inputRowIndex = 1 + visible.length + padCount + dropdownH + 1 + 1; // 1-indexed row of the input line (middle border row)
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
  out(state, c.dim(`${glyphs.diamond} ${process.cwd().replace(process.env.HOME || '', '~')}`));
  out(state, '');
  out(state, c.dim('Type /help for the full command list.'));

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
      out(state, `${c.assistant(glyphs.promptArrow)} ${line}`);
      try { await dispatch(line, state, cfg); } catch (e) { out(state, err(e.message || String(e))); }
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
      const dir = flags._[0];
      if (!dir) { console.log(err('usage: /ingest <dir> [--org name] [--local] [--force] [--no-mirror] [--keep-cloud]')); break; }
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
