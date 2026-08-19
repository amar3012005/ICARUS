'use strict';
// icarus TUI — launched by bare `icarus` (no subcommand) on a real TTY. Modeled directly on
// grok-build's own startup screen (xai-grok-pager's boxed banner + slash-command prompt): a
// bordered banner box up top, then a scrolling REPL below it where `/ingest`, `/recall`,
// `/status`, `/connect` etc. are typed and answered inline — same interaction shape, ICARUS's
// own content.
//
// Deliberately NOT a full alt-screen curses redraw (grok's pager repaints a fixed-position
// bottom input bar on every keystroke via raw terminal control) — that's a materially bigger
// build (raw mode, manual line editing, cursor save/restore per frame) for a one-shot memory
// CLI. This draws the banner once, then hands off to a normal scrolling readline REPL: visually
// "boxed banner, then a running shell below it," which is what a slash-command CLI shell reads
// as in practice (psql/redis-cli/mongosh all work this way) even though it isn't pixel-identical
// to a bottom-pinned curses bar.
const path = require('path');
const readline = require('readline');
const { c, heading, ok, err, bullet, glyphs, rule, spinnerFrame } = require('./theme.js');
const {
  loadCfg, saveCfg, ingestDir, recallQuery, statusReport, signingEnabled, embeddingsConfigured,
  hivemindConfigured, hivemindIngestDir, attemptHivemindOAuth,
  DEFAULT_HIVEMIND_AUTH_URL, DEFAULT_HIVEMIND_API_URL,
  ICARUS_VERSION, checkForUpdate, performSelfUpdate, noIngestableFilesReason, HIVEMIND_INGESTABLE_EXTS,
  hivemindSaveMemory, saveLocalMemory,
} = require('./cli-lib.js');

function boxWidth() {
  const cols = process.stdout.columns || 78;
  return Math.max(60, Math.min(cols - 4, 96));
}

function visibleLen(s) { return s.replace(/\x1b\[[0-9;]*m/g, '').length; }

function padLine(s, width) {
  // Strip ANSI for width math, then pad the ORIGINAL (colored) string using the visible length.
  const pad = Math.max(0, width - visibleLen(s));
  return s + ' '.repeat(pad);
}

// Right-align a key/hint against a left label within `width` columns — matches grok-build's
// hero-box menu rows (welcome/mod.rs's rendered "label ... key" pattern, e.g. "New worktree
// ctrl+w"): label left, hint right, both on one row, padded to fill the column exactly.
function menuRow(label, hint, width) {
  const gap = Math.max(1, width - visibleLen(label) - visibleLen(hint));
  return `${label}${' '.repeat(gap)}${hint}`;
}

// Original ICARUS mark, NOT a copy of any other product's logo asset — an abstract ascending-
// wing motif in the same dot-matrix visual language grok-build's own small logo uses (braille
// block characters, compact ~11x5), rendered as its own thing.
const ICARUS_MARK = [
  '⠀⠀⢀⣠⣴⣾⣷⣦⣀⠀⠀',
  '⠀⣰⡿⠋⠀⠀⠀⠙⢿⣆⠀',
  '⢰⡟⠀⠀⢀⣀⡀⠀⠀⢻⡆',
  '⠈⠻⣦⡀⠀⠉⠀⢀⣼⠟⠁',
  '⠀⠀⠈⠛⠶⠶⠞⠛⠁⠀⠀',
];
const MARK_WIDTH = 11;

// Rounded border, two columns inside — mark left, version/status/menu right — mirroring
// grok-build's hero_box.rs structure (logo left column, version+subtitle+menu right column,
// rounded border) without its mouse hit-testing/live-announcement machinery, which needs a real
// alt-screen curses runtime this CLI deliberately doesn't build (see this file's header comment).
function heroBox(rightLines, width) {
  const leftW = MARK_WIDTH + 2;
  const rightW = width - leftW - 3; // 3 = the gap column + 2 border-adjacent spaces
  const rows = Math.max(ICARUS_MARK.length, rightLines.length);
  const top = c.dim('╭' + '─'.repeat(width) + '╮');
  const bot = c.dim('╰' + '─'.repeat(width) + '╯');
  const body = [];
  for (let i = 0; i < rows; i++) {
    const left = i < ICARUS_MARK.length ? c.assistant(ICARUS_MARK[i]) : ' '.repeat(MARK_WIDTH);
    const right = i < rightLines.length ? rightLines[i] : '';
    body.push(`${c.dim('│')} ${padLine(left, leftW - 1)} ${padLine(right, rightW)} ${c.dim('│')}`);
  }
  return [top, ...body, bot].join('\n');
}

function drawBanner(cfg) {
  const w = boxWidth();
  const cwd = process.cwd().replace(process.env.HOME || '', '~');
  console.log(`${c.dim(glyphs.diamond)} ${c.dim(cwd)}\n`);

  const hmLine = cfg.hivemind?.connected
    ? c.success(`HIVEMIND connected${cfg.hivemind.userEmail ? ` as ${cfg.hivemind.userEmail}` : ''}`)
    : c.dim('HIVEMIND not connected');
  const right = [
    `${c.bold(c.assistant('ICARUS'))}  ${c.dim(`v${ICARUS_VERSION}`)}`,
    c.dim('memory filesystem for AI agents'),
    '',
    hmLine,
    '',
    menuRow(`${c.command('/ingest')} ${c.dim('<dir>')}`, c.dim('extract + store a folder'), 48),
    menuRow(`${c.command('/recall')} ${c.dim('<query>')}`, c.dim('local semantic + lexical search'), 48),
    menuRow(`${c.command('/save')} ${c.dim('<text>')}`, c.dim('save a real memory'), 48),
    menuRow(c.command('/status'), c.dim('shards, signing, audit'), 48),
    menuRow(c.command('/connect'), c.dim('sign in to HIVEMIND'), 48),
    menuRow(c.command('/update'), c.dim('download the latest release'), 48),
    menuRow(c.command('/help'), c.dim('full command list'), 48),
    menuRow(c.command('/quit'), c.dim('ctrl+d'), 48),
  ];
  console.log(heroBox(right, w));
  console.log(`\n${c.dim('Type a command, or plain text to recall.')}\n`);
}

function printHelp() {
  console.log(`
${heading('Commands')}
  ${c.command('/ingest')} <dir> [--org name] [--local] [--force]  ingest a folder
  ${c.command('/recall')} <query> [--org name] [--k 5] [--pq]     local recall, always. Real parallel hybrid (dense+lexical, RRF-merged); narrow-reranked if HIVEMIND connected, else the hybrid merge is final. Never HIVEMIND's shared recall (a real cross-tenant leak was found there).
  ${c.command('/save')} <text> [--org name] [--local]              save a real memory (full embedding + smart-router; NOT evidence-only) — recallable via /recall
  ${c.command('/status')}                                          org shards + engine status
  ${c.command('/connect')}                                         browser sign-in to HIVEMIND
  ${c.command('/org')} <name>                                      switch the default org for this session
  ${c.command('/update')}                                          download + verify the latest release, replace this binary
  ${c.command('/help')}                                             this list
  ${c.command('/quit')} / ${c.command('ctrl+d')}                                   exit

Anything not starting with "/" is treated as ${c.command('/recall <text>')} against the current org.
`);
}

function parseArgs(argStr) {
  // Same tiny flag grammar as the CLI's own parseFlags — reused conceptually, not imported, since
  // this operates on a single already-split line rather than process.argv.
  const tokens = argStr.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const clean = tokens.map((t) => t.replace(/^["']|["']$/g, ''));
  const out = { _: [] };
  for (let i = 0; i < clean.length; i++) {
    if (clean[i].startsWith('--')) {
      const name = clean[i].slice(2);
      const boolFlags = new Set(['local', 'force', 'pq', 'no-mirror']);
      if (boolFlags.has(name)) out[name] = true;
      else out[name] = clean[++i];
    } else out._.push(clean[i]);
  }
  return out;
}

async function run() {
  const cfg = loadCfg();
  process.stdout.write('\x1b[2J\x1b[H'); // clear screen — banner starts at a known top
  drawBanner(cfg);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${c.assistant(glyphs.promptArrow)} `,
  });
  const state = { org: 'default', rl };
  rl.prompt();

  // Queue + drain rather than `rl.on('line', async ...)` directly — readline's `line` event
  // fires for every buffered newline as soon as it arrives, NOT after the previous line's async
  // handler resolves, and `close` fires independently once the input stream hits EOF. Piped
  // input (multiple lines delivered in one chunk, immediately EOF) raced past pending `dispatch`
  // calls straight to `close` -> process.exit(0), silently dropping the command output — caught
  // by actually testing piped input, not just interactive typing (which never lines up enough
  // commands back-to-back to hit the race in practice, but is exposed to the exact same bug on a
  // fast paste or a command triggered right as the user hits ctrl+d).
  const queue = [];
  let draining = false;
  let closing = false;
  async function drain() {
    if (draining) return;
    draining = true;
    while (queue.length) {
      const line = queue.shift();
      try { await dispatch(line, state, cfg); } catch (e) { console.log(err(e.message || String(e))); }
    }
    draining = false;
    if (closing) return finish();
    rl.prompt();
  }
  // No process.exit() here — a real bug caught by testing piped input (not just interactive
  // typing): process.exit() can truncate stdout that hasn't finished flushing to a pipe/pty yet,
  // silently swallowing the LAST command's own output. Just stop reading and let Node exit
  // naturally once the event loop drains (nothing else keeps it alive once readline is closed).
  function finish() { console.log(c.dim('\nbye.')); }

  rl.on('line', (raw) => {
    const line = raw.trim();
    if (line) queue.push(line);
    drain();
  });
  rl.on('close', () => {
    closing = true;
    if (!draining && !queue.length) finish();
    // else: drain()'s own tail handles it once the queue empties.
  });
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
      if (!dir) { console.log(err('usage: /ingest <dir> [--org name] [--local] [--force] [--no-mirror]')); break; }
      const viaHivemind = hivemindConfigured(cfg) && !flags.local;
      const skipReason = noIngestableFilesReason(dir, viaHivemind ? HIVEMIND_INGESTABLE_EXTS : undefined);
      if (skipReason) { console.log(err(skipReason)); break; }
      if (viaHivemind) {
        console.log(bullet(c.system(`ingesting into HIVEMIND, org "${c.path(org)}"...`)));
        let tick = 0;
        const result = await hivemindIngestDir(dir, org, cfg, (n) => process.stdout.write(`\r  ${c.running(spinnerFrame(tick++))} ${n} files`), { force: !!flags.force, mirrorLocal: !flags['no-mirror'] });
        const notes = [];
        if (result.duplicates) notes.push(`${result.duplicates} already in your knowledge base`);
        if (result.pending) notes.push(`${result.pending} still processing`);
        if (result.failed) notes.push(`${result.failed} failed — see errors above`);
        if (result.mirrored) notes.push(`${result.mirrored} segments mirrored locally`);
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
      // LOCAL ONLY, always — see cli-lib.js's comment where hivemindRecallQuery used to live:
      // a real cross-tenant leak was found on HIVEMIND's shared /api/recall (other orgs' private
      // content came back for this org's queries). recallQuery() still uses HIVEMIND's free
      // embed+rerank services for query processing when connected — never as the search index.
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
      if (!text) { console.log(err('usage: /save <text> [--org name]')); break; }
      if (hivemindConfigured(cfg) && !flags.local) {
        const r = await hivemindSaveMemory(text, org, cfg);
        await saveLocalMemory(text, org, cfg); // mirror — /recall is local-only, this text must exist locally to ever surface
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
      if (!s.shards.length) console.log(c.dim('no shards yet'));
      else s.shards.forEach((sh) => console.log(`  ${c.path(sh.org.padEnd(20))} ${c.dim((sh.bytesOnDisk / 1e6).toFixed(2) + ' MB')}`));
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
    case 'help': printHelp(); break;
    case 'quit': case 'exit': state.rl.close(); break;
    default: console.log(err(`unknown command: /${cmd} — try /help`));
  }
}

module.exports = { run };
