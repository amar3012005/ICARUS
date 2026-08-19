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
  loadCfg, saveCfg, ingestDir, recallQuery, statusReport, signingEnabled,
  hivemindConfigured, hivemindIngestDir, hivemindRecallQuery, attemptHivemindOAuth,
  DEFAULT_HIVEMIND_AUTH_URL, DEFAULT_HIVEMIND_API_URL,
  ICARUS_VERSION, checkForUpdate, performSelfUpdate, noIngestableFilesReason,
} = require('./cli-lib.js');

function boxWidth() {
  const cols = process.stdout.columns || 78;
  return Math.max(48, Math.min(cols - 2, 78));
}

function padLine(s, width) {
  // Strip ANSI for width math, then pad the ORIGINAL (colored) string using the visible length.
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
  const pad = Math.max(0, width - visible.length);
  return s + ' '.repeat(pad);
}

function box(lines, width) {
  const top = c.dim('┌' + '─'.repeat(width) + '┐');
  const bot = c.dim('└' + '─'.repeat(width) + '┘');
  const body = lines.map((l) => `${c.dim('│')} ${padLine(l, width - 2)} ${c.dim('│')}`);
  return [top, ...body, bot].join('\n');
}

function drawBanner(cfg) {
  const w = boxWidth();
  const hmLine = cfg.hivemind?.connected
    ? c.success(`HIVEMIND connected${cfg.hivemind.userEmail ? ` as ${cfg.hivemind.userEmail}` : ''}`)
    : c.dim('HIVEMIND not connected — /connect to link your account');
  const lines = [
    `${c.bold(c.assistant('ICARUS'))} ${c.dim(`v${ICARUS_VERSION}`)}  ${c.dim('memory filesystem for AI agents')}`,
    '',
    hmLine,
    '',
    `${c.command('/ingest')} ${c.dim('<dir> [--org name]')}          extract + store a folder`,
    `${c.command('/recall')} ${c.dim('<query> [--org name]')}        semantic + lexical search`,
    `${c.command('/status')}                              shards, signing, audit, HIVEMIND`,
    `${c.command('/connect')}                             sign in to HIVEMIND (browser)`,
    `${c.command('/update')}                              download the latest release`,
    `${c.command('/help')}                                full command list`,
    `${c.command('/quit')}${' '.repeat(31)}${c.dim('ctrl+d')}`,
  ];
  console.log(box(lines, w));
}

function printHelp() {
  console.log(`
${heading('Commands')}
  ${c.command('/ingest')} <dir> [--org name] [--local] [--full]   ingest a folder
  ${c.command('/recall')} <query> [--org name] [--k 5] [--local]  recall
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
      const boolFlags = new Set(['local', 'full', 'pq']);
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
  console.log(c.dim(`\nType a command, or plain text to recall. ${c.command('/help')} for the full list.\n`));

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
      if (!dir) { console.log(err('usage: /ingest <dir> [--org name] [--local] [--full]')); break; }
      const skipReason = noIngestableFilesReason(dir);
      if (skipReason) { console.log(err(skipReason)); break; }
      if (hivemindConfigured(cfg) && !flags.local) {
        console.log(bullet(c.system(`ingesting into HIVEMIND, org "${c.path(org)}"...`)));
        let tick = 0;
        const result = await hivemindIngestDir(dir, org, cfg, (n) => process.stdout.write(`\r  ${c.running(spinnerFrame(tick++))} ${n} files`), { fullMemoryGeneration: !!flags.full });
        console.log(`\n${ok(`ingested ${result.files} files → ${result.live} memories, ${result.chunks} segments`)}${result.duplicates ? c.dim(` — ${result.duplicates} already in your knowledge base, skipped`) : ''}`);
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
      if (hivemindConfigured(cfg) && !flags.local) {
        const hits = await hivemindRecallQuery(q, org, cfg, k);
        console.log(`\n${heading(`top ${hits.length}`)} ${c.dim('(HIVEMIND)')}\n`);
        hits.forEach((h, i) => console.log(`  ${c.dim(String(i + 1).padStart(2))} ${c.assistant(glyphs.promptArrow)} ${c.model(`[${(h.score ?? 0).toFixed(4)}]`)} ${(h.text || '').replace(/\s+/g, ' ').slice(0, 140)}`));
      } else {
        const hits = await recallQuery(q, org, cfg, k, !!flags.pq);
        console.log(`\n${heading(`top ${hits.length}`)}\n`);
        hits.forEach((h, i) => console.log(`  ${c.dim(String(i + 1).padStart(2))} ${c.assistant(glyphs.promptArrow)} ${c.model(`[${h.score.toFixed(4)}]`)} ${h.text.replace(/\s+/g, ' ').slice(0, 140)}`));
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
