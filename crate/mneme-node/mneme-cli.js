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
const readline = require('readline');
// Lazy: `mcp install`/`status`/`connect` never touch a shard, so they must not be forced to
// load the native addon just because this file was required.
function getMnemeStore() { return require('./index.js').MnemeStore; }
const {
  CFG_PATH, loadCfg, saveCfg, statusReport, ingestDir, recallQuery, embeddingsConfigured,
  llmConfigured, skillSave, skillList,
} = require('./cli-lib.js');

// Flags that are pure on/off switches (no value token follows) — everything else keeps the
// original "consume the next token as this flag's value" behavior unchanged, so `--k 5`,
// `--org acme`, `--seed 7` etc. are byte-identical to before this set existed. A heuristic
// ("no value follows -> must be boolean") was tried and rejected: it would silently turn a
// user mistyping `--k` with no value into `Number(true) === 1` instead of the intended
// fallback default — a worse failure than the boolean-flag bug it would have fixed.
const BOOLEAN_FLAGS = new Set(['pq', 'disable']);

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

async function cmdConnect(_flags, cfg, sharedAsk) {
  const base = process.env.HIVEMIND_URL || 'https://hivemind.blaiq.ai';
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
      case 'graph': await require('./graph.js').run(flags); break;
      case 'skill': await cmdSkill(flags, cfg); break;
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
