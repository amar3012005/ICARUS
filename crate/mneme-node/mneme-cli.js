#!/usr/bin/env node
'use strict';
// icarus CLI — ingest folders, recall, compact, status, connect HIVEMIND, MCP server.
// (Filename/dir stay "mneme" — the internal engine/crate name — but every string a user sees
// says "icarus", matching the CLI binary install.sh actually installs.)
// Zero npm deps beyond the native addon (and @modelcontextprotocol/sdk for `mcp-serve` only);
// embeddings via OpenRouter's baai/bge-m3 by default (any OpenAI-compatible /embeddings endpoint works).
//
// Shared config/embed/ingest/recall logic lives in cli-lib.js — mcp-serve.js requires the SAME
// module, so the CLI and the MCP server can never silently drift onto two different behaviors.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
// Lazy: `mcp install`/`status`/`connect` never touch a shard, so they must not be forced to
// load the native addon just because this file was required.
function getMnemeStore() { return require('./index.js').MnemeStore; }
const {
  HOME, CFG_PATH, loadCfg, saveCfg, statusReport, ingestDir, recallQuery, embeddingsConfigured,
  llmConfigured, skillSave, skillList, parseClaudeTranscript,
  signingEnabled, verifySlot, checkpointAudit, verifyAuditChain,
} = require('./cli-lib.js');

// Flags that are pure on/off switches (no value token follows) — everything else keeps the
// original "consume the next token as this flag's value" behavior unchanged, so `--k 5`,
// `--org acme`, `--seed 7` etc. are byte-identical to before this set existed. A heuristic
// ("no value follows -> must be boolean") was tried and rejected: it would silently turn a
// user mistyping `--k` with no value into `Number(true) === 1` instead of the intended
// fallback default — a worse failure than the boolean-flag bug it would have fixed.
const BOOLEAN_FLAGS = new Set(['pq', 'disable', 'yes']);

function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const name = args[i].slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        out[name] = true;
      } else {
        out[name] = args[++i];
      }
    } else {
      out._.push(args[i]);
    }
  }
  return out;
}

async function cmdIngest(flags, cfg) {
  const dir = flags._[0];
  const org = flags.org || 'default';
  if (!dir) throw new Error('usage: icarus ingest <dir> --org <name>');
  if (!embeddingsConfigured(cfg)) {
    console.log('no embedding provider configured — ingesting lexical-only (BM25, no semantic recall).');
    console.log('run `icarus connect-embeddings` to add one, then re-ingest for vector recall.\n');
  }
  console.log(`ingesting into org "${org}"`);
  const result = await ingestDir(dir, org, cfg, (n) => process.stdout.write(`\r  ${n} chunks`));
  console.log(`\n✓ ingested ${result.chunks} chunks from ${result.files} files into ${org} (${result.live} live, mode=${result.mode})`);
}

async function cmdRecall(flags, cfg) {
  const q = flags._[0];
  const org = flags.org || 'default';
  const k = Number(flags.k || 5);
  const usePq = flags.pq !== undefined;
  if (!q) throw new Error('usage: icarus recall "<query>" --org <name> [--k 5] [--pq]');
  const hits = await recallQuery(q, org, cfg, k, usePq);
  const modeLabel = hits[0]?.mode === 'lexical' ? ' (lexical/BM25 — no embedding provider configured)'
    : usePq ? ' (PQ/ADC recall)' : '';
  console.log(`\ntop ${hits.length} for "${q}"${modeLabel}:\n`);
  hits.forEach((h, i) => {
    const txt = h.text.replace(/\s+/g, ' ').slice(0, 160);
    console.log(`  ${i + 1}. [${h.score.toFixed(4)}] ${txt}`);
  });
}

function cmdStatus(_flags, cfg) {
  const s = statusReport(cfg);
  console.log(`icarus  data: ${s.dataRoot}  dim: ${s.dim}`);
  console.log(`HIVEMIND: ${s.hivemindConnected ? 'connected' : 'not connected'}`);
  console.log(`Signing: ${signingEnabled(cfg) ? 'ML-DSA-65 (FIPS 204), on' : 'disabled'}`);
  console.log(`Audit trail: SLH-DSA-SHA2-128s (FIPS 205), on — icarus audit checkpoint/verify`);
  if (!s.shards.length) return console.log('no shards yet — run: icarus ingest <dir> --org <name>');
  console.log(`\nshards:`);
  for (const sh of s.shards) {
    console.log(`  ${sh.org.padEnd(24)} ${(sh.bytesOnDisk / 1e6).toFixed(2)} MB on disk`);
  }
}

function cmdCompact(flags, cfg) {
  const org = flags.org || 'default';
  const store = getMnemeStore().open(cfg.dataRoot, org, cfg.dim);
  const reclaimed = store.compact();
  console.log(`✓ compacted ${org}: reclaimed ${(reclaimed / 1e3).toFixed(1)} KB`);
}

// PQ (Product Quantization) is a real alternative to HNSW, not a universal upgrade — see
// trainPq()'s doc comment in amr-store.mjs for the measured tradeoff (fast build always, fast
// QUERY only at small/medium shard sizes). This command is what makes it reachable without
// writing code — before this, train_pq/recall_pq only existed in the Rust crate.
function cmdTrainPq(flags, cfg) {
  const org = flags.org || 'default';
  const seed = Number(flags.seed || 42);
  // PQ trains a codebook on the shard's raw vectors — in lexical-only mode those are zero
  // placeholders (no embedding provider to produce real ones), so training now would silently
  // produce a degenerate, meaningless codebook rather than erroring. Refuse loudly instead.
  if (!embeddingsConfigured(cfg)) {
    throw new Error('train-pq needs real vectors — no embedding provider configured. Run `icarus connect-embeddings` first, then re-ingest and train.');
  }
  const store = getMnemeStore().open(cfg.dataRoot, org, cfg.dim);
  const live = store.liveCount();
  if (!live) throw new Error(`org "${org}" has no memories yet — nothing to train on`);
  console.log(`training PQ codebook for "${org}" (${live} live vectors, seed=${seed})...`);
  const t0 = Date.now();
  store.trainPq(seed);
  console.log(`✓ trained in ${((Date.now() - t0) / 1000).toFixed(1)}s — try: icarus recall "..." --org ${org} --pq`);
}

// Two real, separate bugs were caught building this:
//   1. A fresh readline.Interface PER question loses whatever was buffered past the first
//      question when the interface is closed and reopened on the same non-tty pipe.
//   2. Fixed to one shared interface, multi-question flows STILL silently dropped answers 2+ on
//      piped (non-tty) input: Node's readline.Interface on a non-tty stream processes buffered
//      lines eagerly in the background — `rl.question()` only attaches a ONE-TIME listener for
//      the very next 'line' event, so if a later question is asked after any event-loop tick
//      (even just an `await`), lines already fired-and-discarded before that listener existed
//      are gone. No error, no hang past the first question — just missing input. Reproduced in
//      a 3-line isolated repro before trusting this diagnosis.
// Fix: a real interactive TTY paces itself, so classic sequential question() is fine there.
// Piped/non-interactive input is read up front, split into lines, and each ask() call just
// pops the next one — no readline race possible because there's no readline involved.
function makePrompter() {
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));
    ask.close = () => rl.close();
    return ask;
  }
  let buffered = null;
  let idx = 0;
  const readAll = () => {
    try { buffered = fs.readFileSync(0, 'utf8').split('\n'); } catch (_) { buffered = []; }
  };
  const ask = async (q) => {
    if (buffered === null) readAll();
    process.stdout.write(q);
    const line = idx < buffered.length ? buffered[idx++] : '';
    process.stdout.write(line + '\n');
    return line.trim();
  };
  ask.close = () => {};
  return ask;
}

async function cmdConnect(flags, cfg, sharedAsk) {
  const base = process.env.HIVEMIND_URL || 'https://hivemind.blaiq.ai';
  // --token makes this fully non-interactive — install.sh's guided section uses this instead of
  // spawning a second interactive read inside a curl|bash pipeline's child process. A real bug
  // was caught running the actual `curl | bash` install: a long-lived Node process doing several
  // sequential /dev/tty reads (icarus setup's own wizard, invoked as install.sh's child) died
  // silently after its first question — most likely a controlling-terminal/process-group issue
  // specific to being spawned from within a shell pipeline (`curl url | bash`), not reproducible
  // in a plain interactive shell. install.sh now does ALL prompting itself (the single-read `read
  // ... < /dev/tty` pattern already proven reliable), then calls each icarus subcommand with the
  // answer already in hand via flags — never handing tty control to a child process for more than
  // one read at a time.
  if (flags.token !== undefined) {
    if (!flags.token) return console.log('  skipped.');
    cfg.hivemind = { connected: true, url: base, token: flags.token, connectedAt: new Date().toISOString() };
    saveCfg(cfg);
    return console.log('  ✓ HIVEMIND connected. Token stored in', CFG_PATH);
  }
  console.log(`\nConnect ICARUS ↔ HIVEMIND`);
  console.log(`  1. Open: ${base}/settings/connections (authorize "icarus local")`);
  console.log(`  2. Copy the access token shown after authorizing.\n`);
  // A caller (icarus setup) that's already mid-wizard passes its own prompter through, so this
  // never touches stdin itself — a SECOND fs.readFileSync(0) on piped input reads nothing, since
  // the first prompter already drained the pipe (a real bug, caught running the actual wizard).
  const ask = sharedAsk || makePrompter();
  const token = await ask('  Paste HIVEMIND token (or blank to skip): ');
  if (!sharedAsk) ask.close();
  if (!token) return console.log('  skipped.');
  cfg.hivemind = { connected: true, url: base, token, connectedAt: new Date().toISOString() };
  saveCfg(cfg);
  console.log('  ✓ HIVEMIND connected. Token stored in', CFG_PATH);
}

// Embeddings are OPT-IN, not required — ingest/recall work lexical-only (BM25) with zero
// embedding provider configured. `export OPENROUTER_API_KEY=...` alone is enough (.env-style,
// no interactive step needed — the same pattern TencentDB Agent Memory's own setup uses); this
// command is for when you'd rather be prompted, or want the key saved to config instead of
// exported every session, or want to force lexical-only even with an env var present. Default
// provider is OpenRouter's real baai/bge-m3 (openrouter.ai/baai/bge-m3, verified live: native
// 1024-dim output, matches the shard's fixed dim exactly). LITELLM_API_KEY/LITELLM_BASE_URL
// still work as an override for anyone pointing at their own LiteLLM/blaiq gateway instead.
async function cmdConnectEmbeddings(flags, cfg, sharedAsk) {
  if (flags.disable) {
    cfg.embeddings = { ...cfg.embeddings, disabled: true, apiKey: null };
    saveCfg(cfg);
    return console.log('✓ embeddings disabled — ingest/recall will use lexical-only (BM25) search, even with OPENROUTER_API_KEY set.');
  }
  // --key (even '' to mean "use env var / skip") makes this fully non-interactive — see
  // cmdConnect's comment for why install.sh's guided section needs this shape.
  if (flags.key !== undefined) {
    const endpoint = flags.endpoint || cfg.embeddings?.endpoint || 'https://openrouter.ai/api/v1';
    const model = flags.model || cfg.embeddings?.model || 'baai/bge-m3';
    if (!flags.key && !process.env.OPENROUTER_API_KEY && !process.env.LITELLM_API_KEY) {
      return console.log('  no key given and OPENROUTER_API_KEY not set — skipped. Staying lexical-only.');
    }
    cfg.embeddings = { disabled: false, endpoint, model, apiKey: flags.key || null };
    saveCfg(cfg);
    console.log(`  ✓ embedding provider configured (${model} @ ${endpoint}). Config → ${CFG_PATH}`);
    return;
  }
  console.log('\nConnect an embedding provider (OpenAI-compatible /embeddings endpoint).');
  console.log('Skip this entirely and ICARUS still works — BM25 lexical search needs no vector.');
  console.log('(Already have OPENROUTER_API_KEY exported? You don\'t need this command at all — it just works.)\n');
  const ask = sharedAsk || makePrompter();
  const endpoint = await ask(`  Endpoint [${cfg.embeddings?.endpoint || 'https://openrouter.ai/api/v1'}]: `)
    || cfg.embeddings?.endpoint || 'https://openrouter.ai/api/v1';
  const model = await ask(`  Model [${cfg.embeddings?.model || 'baai/bge-m3'}]: `) || cfg.embeddings?.model || 'baai/bge-m3';
  const apiKey = await ask('  API key (or blank to use OPENROUTER_API_KEY env var instead): ');
  if (!sharedAsk) ask.close();
  if (!apiKey && !process.env.OPENROUTER_API_KEY && !process.env.LITELLM_API_KEY) {
    return console.log('  no key given and OPENROUTER_API_KEY not set — skipped. Staying lexical-only.');
  }
  cfg.embeddings = { disabled: false, endpoint, model, apiKey: apiKey || null };
  saveCfg(cfg);
  console.log(`  ✓ embedding provider configured (${model} @ ${endpoint}). Config → ${CFG_PATH}`);
  console.log('  Re-run `icarus ingest` for existing orgs to get vector recall on their content.');
}

// Memory generation (distillation, TencentDB Agent Memory's own L0->L1 term) is OPT-IN, same
// shape as connect-embeddings — but a SEPARATE knob: this is a chat-completion call, not an
// embeddings one, and neither Claude's native API nor OpenRouter offer embeddings at all. Two
// real providers, not a fake "connect your Claude subscription": Anthropic prohibits third-party
// products from routing calls through a user's Claude.ai Free/Pro/Max login — the only supported
// path is a standalone Anthropic API key from console.anthropic.com, or OpenRouter (which can
// also reach Claude models, by model name, through its own separate key). ICARUS never asks for
// or stores a Claude.ai/Codex login session.
async function cmdConnectLlm(flags, cfg, sharedAsk) {
  if (flags.disable) {
    cfg.llm = { ...cfg.llm, disabled: true, apiKey: null };
    saveCfg(cfg);
    return console.log('✓ memory generation disabled — ingest will store raw text, even with an API key env var set.');
  }
  // --provider (openrouter|anthropic|skip) + --key make this fully non-interactive — see
  // cmdConnect's comment for why install.sh's guided section needs this shape.
  if (flags.provider !== undefined) {
    if (flags.provider === 'skip') return console.log('  skipped. Staying raw-text mode.');
    const provider = flags.provider === 'anthropic' ? 'anthropic' : 'openrouter';
    const defaults = provider === 'anthropic'
      ? { endpoint: 'https://api.anthropic.com', model: 'claude-3-5-haiku-20241022' }
      : { endpoint: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-3.5-haiku' };
    const endpoint = flags.endpoint || cfg.llm?.endpoint || defaults.endpoint;
    const model = flags.model || cfg.llm?.model || defaults.model;
    const envVar = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENROUTER_API_KEY';
    if (!flags.key && !process.env[envVar]) {
      return console.log(`  no key given and ${envVar} not set — skipped. Staying raw-text mode.`);
    }
    cfg.llm = { disabled: false, provider, endpoint, model, apiKey: flags.key || null };
    saveCfg(cfg);
    console.log(`  ✓ memory generation configured (${provider}: ${model} @ ${endpoint}). Config → ${CFG_PATH}`);
    return;
  }
  console.log('\nConnect a memory-generation provider (distills raw text into key facts before storing).');
  console.log('Skip this entirely and ICARUS still works — raw text is stored and searchable as-is.\n');
  console.log('  1) OpenRouter   — one key, routes to Claude/GPT/etc by model name');
  console.log('  2) Anthropic API key — console.anthropic.com (NOT your Claude.ai subscription login)');
  console.log('  3) Skip\n');
  const ask = sharedAsk || makePrompter();
  const choice = (await ask('  Choice [1/2/3]: ')).trim() || '3';
  if (choice === '3') { if (!sharedAsk) ask.close(); return console.log('  skipped. Staying raw-text mode.'); }
  const provider = choice === '2' ? 'anthropic' : 'openrouter';
  const defaults = provider === 'anthropic'
    ? { endpoint: 'https://api.anthropic.com', model: 'claude-3-5-haiku-20241022' }
    : { endpoint: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-3.5-haiku' };
  const endpoint = await ask(`  Endpoint [${cfg.llm?.endpoint || defaults.endpoint}]: `) || cfg.llm?.endpoint || defaults.endpoint;
  const model = await ask(`  Model [${cfg.llm?.model || defaults.model}]: `) || cfg.llm?.model || defaults.model;
  const envVar = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENROUTER_API_KEY';
  const apiKey = await ask(`  API key (or blank to use ${envVar} env var instead): `);
  if (!sharedAsk) ask.close();
  if (!apiKey && !process.env[envVar]) {
    return console.log(`  no key given and ${envVar} not set — skipped. Staying raw-text mode.`);
  }
  cfg.llm = { disabled: false, provider, endpoint, model, apiKey: apiKey || null };
  saveCfg(cfg);
  console.log(`  ✓ memory generation configured (${provider}: ${model} @ ${endpoint}). Config → ${CFG_PATH}`);
  console.log('  Re-run `icarus ingest` for existing orgs to distill their content going forward.');
}

// The guided, one-by-one flow: detect agents, ask per agent, then walk through memory-generation
// / embeddings / HIVEMIND as sequential explained steps — never a silent "run these 3 commands
// later" wall. Piped/non-interactive input works identically (makePrompter's non-TTY branch),
// just answered from stdin/env instead of a live terminal.
async function cmdSetup(_flags, cfg) {
  const { detectAgents, installClaudeCode, installCodex, installCursor, resolveIcarusCommand } = require('./mcp-install.js');
  console.log('\nicarus setup — guided, step by step. Answer or press enter to skip any step.\n');
  // ONE prompter for the whole wizard: on piped/non-TTY input, makePrompter() does a single
  // fs.readFileSync(0) — a second instance mid-wizard would find the pipe already drained and
  // silently read nothing for every remaining question (a real bug, caught running this live).
  const ask = makePrompter();
  console.log('Step 1/4 — coding agents on this machine\n');
  const found = detectAgents().filter((a) => a.found);
  if (!found.length) {
    console.log('  none detected (no ~/.claude.json, ~/.codex, or ~/.cursor found). Skipping.\n');
  } else {
    const command = resolveIcarusCommand();
    const installers = { 'claude-code': installClaudeCode, codex: installCodex, cursor: installCursor };
    for (const { agent } of found) {
      const yn = (await ask(`  Register ICARUS as an MCP server for ${agent}? [Y/n]: `)).trim().toLowerCase();
      if (yn === 'n' || yn === 'no') { console.log(`  · ${agent}: skipped`); continue; }
      const r = installers[agent](command);
      console.log(r.installed ? `  ✓ ${agent}: registered in ${r.path}` : `  · ${agent}: ${r.reason}`);
    }
    if (found.some((a) => a.agent === 'codex')) {
      console.log('  (Codex ChatGPT-subscription login via its app-server is a separate, not-yet-built');
      console.log('   integration — this only registered icarus as a plain MCP tool for it.)');
    }
    console.log('');
  }

  console.log('Step 2/4 — memory generation (distill ingested text into key facts)\n');
  if (llmConfigured(cfg)) {
    console.log(`  already configured (${cfg.llm.provider} @ ${cfg.llm.endpoint}) — skipping.\n`);
  } else {
    await cmdConnectLlm({ _: [] }, cfg, ask);
    console.log('');
  }

  console.log('Step 3/4 — vector recall (semantic search on top of lexical/BM25)\n');
  if (embeddingsConfigured(cfg)) {
    console.log(`  already configured (${cfg.embeddings.model} @ ${cfg.embeddings.endpoint}) — skipping.\n`);
  } else {
    await cmdConnectEmbeddings({ _: [] }, cfg, ask);
    console.log('');
  }

  console.log('Step 4/4 — HIVEMIND account (optional)\n');
  if (cfg.hivemind && cfg.hivemind.connected) {
    console.log('  already connected — skipping.\n');
  } else {
    await cmdConnect({ _: [] }, cfg, ask);
    console.log('');
  }
  ask.close();

  const fresh = loadCfg();
  console.log('Setup summary:');
  console.log(`  agents registered : ${found.filter((a) => a.found).length ? 'see above' : 'none found'}`);
  console.log(`  memory generation : ${llmConfigured(fresh) ? `on (${fresh.llm.provider})` : 'off (raw text)'}`);
  console.log(`  vector recall     : ${embeddingsConfigured(fresh) ? `on (${fresh.embeddings.model})` : 'off (lexical/BM25)'}`);
  console.log(`  HIVEMIND          : ${fresh.hivemind?.connected ? 'connected' : 'not connected'}`);
  console.log('\nAll set. Try: icarus ingest <dir> --org <name>');
}

// "Automatically enables skill generation" (as requested) has a real limit: ICARUS has no
// visibility into a coding-agent session on its own — no agent broadcasts its transcript to
// arbitrary local tools. What's actually automatable is the LAST step: given a transcript
// (stdin, a file, or a piped `--session-end` hook payload), distill it into a skill with zero
// interactive prompts. The "automatic" part is wiring THIS into an agent's own hook (e.g.
// Claude Code's SessionEnd hook piping its transcript here) — that's a one-line hook config on
// the agent's side, not something ICARUS can install into another tool's session lifecycle
// itself (same reasoning as never touching a Claude Code/Codex login session).
async function cmdSkill(flags, cfg) {
  const sub = flags._[0];
  const org = flags.org || 'default';
  if (sub === 'list') {
    const skills = skillList(org);
    if (!skills.length) return console.log(`no skills saved yet for org "${org}". Run: icarus skill save <file> --org ${org}`);
    console.log(`skills for "${org}":\n`);
    for (const s of skills) console.log(`  ${s.slug.padEnd(28)} ${s.description}`);
    return;
  }
  if (sub === 'save') {
    if (!llmConfigured(cfg)) {
      throw new Error('skill extraction needs a memory-generation provider — run `icarus connect-llm` first');
    }
    const file = flags._[1];
    const transcript = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
    console.log('extracting skill...');
    const saved = await skillSave(transcript, org, cfg);
    if (!saved) throw new Error('extraction failed (bad key, provider error, or empty transcript) — no skill written');
    return console.log(`✓ skill saved: ${saved}`);
  }
  throw new Error('usage: icarus skill <save [file] --org <name> | list --org <name>>');
}

// `icarus verify` — independent proof that a memory hasn't been tampered with since it was
// written: re-derives the same canonical payload (slot id + current stored text) and checks it
// against the recorded ML-DSA-65 signature. Reports one of three real states, not just a
// boolean: no signature ever recorded (written before signing was enabled, or signing was off),
// signature present and valid, or signature present but the content no longer matches it — the
// last case is the one that actually matters (real tamper detection, verified in this session
// by rewriting a slot's stored text directly and confirming this goes invalid).
function cmdVerify(flags, cfg) {
  const org = flags.org || 'default';
  const slotId = Number(flags._[0]);
  if (!Number.isInteger(slotId) || slotId < 0) throw new Error('usage: icarus verify <slot_id> --org <name>');
  const r = verifySlot(slotId, cfg, org);
  if (!r.signed) return console.log(`slot ${slotId} in "${org}": no signature recorded (written before signing was enabled, or signing was off).`);
  if (r.valid) return console.log(`✓ slot ${slotId} in "${org}": signature valid (signed ${r.signedAt}).`);
  console.log(`✗ slot ${slotId} in "${org}": signature INVALID — content does not match what was signed at ${r.signedAt}.`);
  process.exitCode = 1;
}

// `icarus audit checkpoint|verify` — the hash-chain audit trail (SLH-DSA-SHA2-128s, FIPS 205),
// a DIFFERENT property from `icarus verify` above: that checks one memory's content against its
// own signature; this checks that the SEQUENCE of write events hasn't been edited, reordered, or
// had entries spliced out — real tamper detection verified this session by deleting an audit
// entry directly and confirming the chain correctly reports broken, at the right position.
function cmdAudit(flags, cfg) {
  const sub = flags._[0];
  const org = flags.org || 'default';
  if (sub === 'checkpoint') {
    const cp = checkpointAudit(cfg, org);
    return console.log(`✓ checkpoint signed for "${org}" at seq ${cp.seq} (${cp.signed_at}).`);
  }
  if (sub === 'verify') {
    const r = verifyAuditChain(cfg, org);
    if (!r.entries) return console.log(`org "${org}": no audit entries yet.`);
    console.log(`${r.entries} audit entries for "${org}".`);
    if (!r.chainValid) {
      console.log(`✗ CHAIN BROKEN at seq ${r.brokenAt} — an entry was edited, reordered, or deleted.`);
      process.exitCode = 1;
      return;
    }
    console.log(`✓ hash chain intact (genesis → tip, no gaps).`);
    if (!r.checkpoint) {
      console.log(`  no checkpoint signed yet — run: icarus audit checkpoint --org ${org}`);
      return;
    }
    console.log(`  latest checkpoint: seq ${r.checkpoint.seq}, signature ${r.checkpoint.valid ? 'valid' : 'INVALID'} (${r.checkpoint.signedAt})`);
    if (r.checkpoint.entriesSinceCheckpoint > 0) {
      console.log(`  ${r.checkpoint.entriesSinceCheckpoint} entries since the last checkpoint are hash-chained but not yet signed — run: icarus audit checkpoint --org ${org}`);
    }
    if (!r.checkpoint.valid) process.exitCode = 1;
    return;
  }
  throw new Error('usage: icarus audit <checkpoint|verify> --org <name>');
}

// `icarus hook session-end` — the automatic-skill-generation counterpart to `icarus skill save`,
// wired as a real Claude Code SessionEnd hook (verified against actual Claude Code hook docs,
// not guessed): Claude Code writes {session_id, transcript_path, cwd, hook_event_name} as JSON on
// stdin when a session ends. transcript_path is Claude Code's own real transcript.jsonl for that
// session; parseClaudeTranscript() turns it into readable text for extractSkill(). Org defaults
// to the basename of `cwd` (the project directory) so skills naturally group by project, not by
// a single catch-all "default" bucket, unless overridden.
//
// Real, documented caveat this has to account for: the transcript file is written
// ASYNCHRONOUSLY and may still be lagging behind the actual last turn at the moment SessionEnd
// fires — so this polls for the file's size to stabilize (unchanged across two checks) for a few
// seconds before parsing, rather than reading whatever partial content exists the instant the
// hook starts. Never throws past that: a hook that fails must not block or error out a user's
// session close, so every failure path here just logs and exits 0.
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitForStableFile(p, attempts = 6, intervalMs = 500) {
  let lastSize = -1;
  for (let i = 0; i < attempts; i++) {
    let size;
    try { size = fs.statSync(p).size; } catch (_) { size = -1; }
    if (size !== -1 && size === lastSize) return true;
    lastSize = size;
    await sleep(intervalMs);
  }
  return fs.existsSync(p);
}
async function cmdHookSessionEnd(_flags, cfg) {
  let payload = '';
  try { payload = fs.readFileSync(0, 'utf8'); } catch (_) { /* no stdin — nothing to do */ }
  let hookData;
  try { hookData = JSON.parse(payload); } catch (_) { console.error('icarus hook session-end: no valid JSON on stdin, skipping.'); return; }
  const { transcript_path: transcriptPath, cwd } = hookData;
  if (!transcriptPath) { console.error('icarus hook session-end: no transcript_path in hook payload, skipping.'); return; }
  if (!llmConfigured(cfg)) return; // silent — this only fires automatically; no key configured means nothing to do, not an error
  await waitForStableFile(transcriptPath);
  const transcript = parseClaudeTranscript(transcriptPath);
  if (!transcript.trim()) { console.error('icarus hook session-end: empty transcript after parsing, skipping.'); return; }
  const org = process.env.ICARUS_HOOK_ORG || (cwd ? path.basename(cwd) : 'default');
  try {
    const saved = await skillSave(transcript, org, cfg);
    if (saved) console.error(`icarus: skill auto-saved from session → ${saved}`); // stderr: SessionEnd's stdout isn't shown to the user
  } catch (e) {
    console.error('icarus hook session-end: extraction failed —', e.message);
  }
}

// The PATH line install.sh's ensure_path() appends — same literal string, so removal matches
// exactly what was added, never a fuzzy/regex guess at "any icarus-looking PATH export" that
// could delete something a user wrote themselves.
function pathLine() {
  return `export PATH="${path.join(HOME, 'bin')}:$PATH"`;
}
function shellRcFiles() {
  const h = os.homedir();
  return [path.join(h, '.zshrc'), path.join(h, '.bashrc'), path.join(h, '.profile')].filter((p) => fs.existsSync(p));
}

function dirSizeMb(dir) {
  let bytes = 0;
  try {
    (function rec(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) rec(p);
        else { try { bytes += fs.statSync(p).size; } catch (_) { /* race */ } }
      }
    })(dir);
  } catch (_) { /* dir vanished mid-walk, or never existed */ }
  return (bytes / 1e6).toFixed(1);
}

// Real uninstall — everything install.sh/setup ever wrote, and nothing else. Detect-then-confirm-
// then-remove, same shape as the rest of this CLI's destructive-adjacent commands: show exactly
// what will happen before doing it, `--yes` skips the prompt for scripted use.
async function cmdPrune(flags, _cfg) {
  const { detectRemovable, removeAll } = require('./mcp-install.js');
  const icarusExists = fs.existsSync(HOME);
  const line = pathLine();
  const rcHits = shellRcFiles().filter((rc) => fs.readFileSync(rc, 'utf8').includes(line));
  const mcpHits = detectRemovable().filter((r) => r.found);

  console.log('icarus prune — this will remove:\n');
  if (icarusExists) console.log(`  ✓ ${HOME} (${dirSizeMb(HOME)} MB — bin, config, data, src)`);
  else console.log(`  · ${HOME} — not found, nothing to remove`);
  for (const rc of rcHits) console.log(`  ✓ PATH line in ${rc}`);
  for (const r of mcpHits) console.log(`  ✓ MCP entr${r.entries.length > 1 ? 'ies' : 'y'} (${r.entries.join(', ')}) in ${r.path}`);
  if (!icarusExists && !rcHits.length && !mcpHits.length) {
    return console.log('\nNothing found — icarus is already fully removed.');
  }
  console.log('\nData in ~/.icarus/data (ingested memories) and any HIVEMIND connection token go with it — this is not reversible.');

  if (!flags.yes) {
    const ask = makePrompter();
    const ans = (await ask('\nProceed? [y/N] ')).trim().toLowerCase();
    ask.close();
    if (ans !== 'y' && ans !== 'yes') return console.log('Aborted — nothing removed.');
  }

  const removed = removeAll();
  for (const r of removed) if (r.removed) console.log(`  ✓ removed icarus MCP registration from ${r.path}`);
  for (const rc of rcHits) {
    const content = fs.readFileSync(rc, 'utf8');
    fs.writeFileSync(rc, content.split('\n').filter((l) => l.trim() !== line).join('\n'));
    console.log(`  ✓ removed PATH line from ${rc}`);
  }
  if (icarusExists) {
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log(`  ✓ removed ${HOME}`);
  }
  console.log('\nicarus fully removed from this machine. Restart any open Claude Code/Cursor/Codex session to drop the MCP registration.');
}

async function cmdMcpServe(_flags, _cfg) {
  // Lazy require: @modelcontextprotocol/sdk is only needed for this one subcommand, so every
  // other command (ingest/recall/status/...) stays dependency-free at require-time.
  await require('./mcp-serve.js').run();
}

async function cmdMcpInstall(flags, _cfg) {
  await require('./mcp-install.js').run(flags);
}

async function cmdDaemon(flags, _cfg) {
  // Lazy require: daemon.js's own deps (http, child_process) are core Node, but keep the
  // require lazy anyway for consistency — the daemon subcommands are the only callers.
  const daemon = require('./daemon.js');
  const sub = flags._[0];
  if (sub === 'start') return daemon.start(flags);
  if (sub === 'stop') return daemon.stop();
  if (sub === 'status') return daemon.status();
  throw new Error('usage: icarus daemon <start|stop|status> [--port 8137]');
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const cfg = loadCfg();
  try {
    switch (cmd) {
      case 'ingest': await cmdIngest(flags, cfg); break;
      case 'recall': await cmdRecall(flags, cfg); break;
      case 'status': cmdStatus(flags, cfg); break;
      case 'compact': cmdCompact(flags, cfg); break;
      case 'train-pq': cmdTrainPq(flags, cfg); break;
      case 'connect': await cmdConnect(flags, cfg); break;
      case 'connect-embeddings': await cmdConnectEmbeddings(flags, cfg); break;
      case 'connect-llm': await cmdConnectLlm(flags, cfg); break;
      case 'setup': await cmdSetup(flags, cfg); break;
      case 'mcp-serve': await cmdMcpServe(flags, cfg); break;
      case 'mcp': {
        const sub = flags._[0];
        if (sub === 'install') await cmdMcpInstall(flags, cfg);
        else if (sub === 'serve') await cmdMcpServe(flags, cfg);
        else throw new Error('usage: icarus mcp <install|serve>');
        break;
      }
      case 'daemon': await cmdDaemon(flags, cfg); break;
      case 'prune': await cmdPrune(flags, cfg); break;
      case 'hook': {
        const sub = flags._[0];
        if (sub === 'session-end') await cmdHookSessionEnd(flags, cfg);
        else throw new Error('usage: icarus hook session-end   (reads Claude Code\'s SessionEnd JSON payload from stdin)');
        break;
      }
      case 'graph': await require('./graph.js').run(flags); break;
      case 'skill': await cmdSkill(flags, cfg); break;
      case 'verify': cmdVerify(flags, cfg); break;
      case 'audit': cmdAudit(flags, cfg); break;
      default:
        console.log(`icarus — memory filesystem CLI (the .amr engine)

  icarus ingest <dir> --org <name>     extract + embed + store a folder
  icarus recall "<query>" --org <name> [--k 5] [--pq]
  icarus compact --org <name>          reclaim deleted memories' bytes
  icarus train-pq --org <name> [--seed 42]
                                        train PQ codebook -> enables --pq recall (see below)
  icarus status                        shards + disk usage
  icarus setup                         guided, one-by-one wizard: detect coding agents, connect
                                        memory generation, embeddings, HIVEMIND — do this first
  icarus connect                       link your HIVEMIND account
  icarus connect-embeddings [--disable]
                                        configure an embedding provider for vector recall — OPT
                                        IN, not required: with none configured, ingest/recall
                                        run lexical-only (BM25), not an error
  icarus connect-llm [--disable]       configure a memory-generation (distillation) provider —
                                        OpenRouter or your own Anthropic API key. OPT IN; with
                                        none configured, ingest stores raw text unchanged.
                                        NEVER a Claude.ai/Codex subscription login — Anthropic's
                                        own terms prohibit third-party tools from doing that.
  icarus skill save [file] --org <name>  distill a session transcript (file, or piped stdin) into
                                        a Claude-Code-shaped skill .md, saved to ~/.icarus/skills
  icarus skill list --org <name>       list skills saved for an org
                                        needs connect-llm configured (memory generation)
  icarus hook session-end              automatic skill generation, wired as a Claude Code
                                        SessionEnd hook (icarus setup offers to install it) —
                                        reads Claude Code's own hook JSON from stdin, no manual
                                        transcript handling needed. Not meant to be run by hand.
  icarus graph build --repo <dir>      native symbol/call-graph index (Tree-sitter via WASM,
                                        SQLite storage) — JS/TS + Rust for now, no Python/uvx dep
  icarus graph status --repo <dir>     node/edge/file counts for the built graph
  icarus graph query --kind <callers_of|callees_of|imports_of|find> --name <symbol> [--repo <dir>]
  icarus mcp install                   register icarus as an MCP server in every coding agent
                                        found on this machine (Claude Code, Codex, Cursor) —
                                        exposes icarus_graph_build/status/query natively too
  icarus mcp serve                     run the MCP server directly (stdio) — what the agents
                                        installed above actually launch
  icarus daemon start [--port 8137]    run ICARUS as a persistent local HTTP service (a shared
                                        process anything on this machine can call — editors,
                                        scripts, a future local panel — instead of each spawning
                                        its own icarus process). Separate from mcp serve: that's
                                        stdio, one per agent session; this is one long-running
                                        process reached over http://127.0.0.1:<port>.
  icarus daemon stop
  icarus daemon status
  icarus prune [--yes]                 remove EVERYTHING icarus installed: ~/.icarus (bin,
                                        config, data, src), the PATH line install.sh added, and
                                        its MCP registration from Claude Code/Cursor/Codex. Shows
                                        exactly what will be removed and asks first, unless
                                        --yes. Not reversible — ingested data goes with it.
  icarus verify <slot_id> --org <name> check a memory's ML-DSA-65 (FIPS 204) signature against
                                        its current stored content — real tamper detection, not
                                        just a checksum. Every icarus ingest signs on by default;
                                        keys live at ~/.icarus/keys (0600), generated on first use.
  icarus audit checkpoint --org <name> sign the audit trail's current tip with SLH-DSA-SHA2-128s
                                        (FIPS 205) — a real, separate algorithm from icarus verify
                                        above, attesting the SEQUENCE of writes hasn't been
                                        edited/reordered/spliced, not just one memory's content.
  icarus audit verify --org <name>     replay the full hash chain from genesis + verify the
                                        latest checkpoint's signature. Reports exactly where a
                                        broken chain diverges, and how many entries since the
                                        last checkpoint are chained but not yet signed.

  --pq recall (icarus recall --pq): an alternative to the default HNSW recall, not a universal
  upgrade — measured on real data, it builds much faster always, and queries FASTER than HNSW
  only on small/medium shards (recall_pq loses to HNSW's query latency as shard size grows).
  Good fit: shards you rebuild often. Run train-pq once first, or --pq errors with that reminder.

  env: OPENROUTER_API_KEY (embeddings + memory generation, optional — see connect-embeddings/connect-llm)
       ANTHROPIC_API_KEY (memory generation via Anthropic's own API instead — see connect-llm)
       LITELLM_API_KEY / LITELLM_BASE_URL (embeddings via your own LiteLLM/blaiq gateway instead)
       ICARUS_HOME (default ~/.icarus)`);
    }
  } catch (e) {
    console.error('✗', e.message);
    process.exit(1);
  }
}

main();
