#!/usr/bin/env node
'use strict';
// icarus CLI — ingest folders, recall, compact, status, connect HIVEMIND, MCP server.
// (Filename/dir stay "mneme" — the internal engine/crate name — but every string a user sees
// says "icarus", matching the CLI binary install.sh actually installs.)
// Zero npm deps beyond the native addon (and @modelcontextprotocol/sdk for `mcp-serve` only);
// embeddings via the configured LiteLLM gateway (bge-m3).
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

async function cmdConnect(_flags, cfg) {
  const base = process.env.HIVEMIND_URL || 'https://hivemind.blaiq.ai';
  console.log(`\nConnect ICARUS ↔ HIVEMIND`);
  console.log(`  1. Open: ${base}/settings/connections (authorize "icarus local")`);
  console.log(`  2. Copy the access token shown after authorizing.\n`);
  const ask = makePrompter();
  const token = await ask('  Paste HIVEMIND token (or blank to skip): ');
  ask.close();
  if (!token) return console.log('  skipped.');
  cfg.hivemind = { connected: true, url: base, token, connectedAt: new Date().toISOString() };
  saveCfg(cfg);
  console.log('  ✓ HIVEMIND connected. Token stored in', CFG_PATH);
}

// Embeddings are OPT-IN, not required — ingest/recall work lexical-only (BM25) with zero
// embedding provider configured. `export LITELLM_API_KEY=...` alone is enough (.env-style, no
// interactive step needed — the same pattern TencentDB Agent Memory's own setup uses); this
// command is for when you'd rather be prompted, or want the key saved to config instead of
// exported every session, or want to force lexical-only even with an env var present.
async function cmdConnectEmbeddings(flags, cfg) {
  if (flags.disable) {
    cfg.embeddings = { ...cfg.embeddings, disabled: true, apiKey: null };
    saveCfg(cfg);
    return console.log('✓ embeddings disabled — ingest/recall will use lexical-only (BM25) search, even with LITELLM_API_KEY set.');
  }
  console.log('\nConnect an embedding provider (OpenAI-compatible /embeddings endpoint).');
  console.log('Skip this entirely and ICARUS still works — BM25 lexical search needs no vector.');
  console.log('(Already have LITELLM_API_KEY exported? You don\'t need this command at all — it just works.)\n');
  const ask = makePrompter();
  const endpoint = await ask(`  Endpoint [${cfg.embeddings?.endpoint || 'https://api.blaiq.ai/v1'}]: `)
    || cfg.embeddings?.endpoint || 'https://api.blaiq.ai/v1';
  const model = await ask(`  Model [${cfg.embeddings?.model || 'bge-m3'}]: `) || cfg.embeddings?.model || 'bge-m3';
  const apiKey = await ask('  API key (or blank to use LITELLM_API_KEY env var instead): ');
  ask.close();
  if (!apiKey && !process.env.LITELLM_API_KEY) {
    return console.log('  no key given and LITELLM_API_KEY not set — skipped. Staying lexical-only.');
  }
  cfg.embeddings = { disabled: false, endpoint, model, apiKey: apiKey || null };
  saveCfg(cfg);
  console.log(`  ✓ embedding provider configured (${model} @ ${endpoint}). Config → ${CFG_PATH}`);
  console.log('  Re-run `icarus ingest` for existing orgs to get vector recall on their content.');
}

async function cmdMcpServe(_flags, _cfg) {
  // Lazy require: @modelcontextprotocol/sdk is only needed for this one subcommand, so every
  // other command (ingest/recall/status/...) stays dependency-free at require-time.
  await require('./mcp-serve.js').run();
}

async function cmdMcpInstall(flags, _cfg) {
  await require('./mcp-install.js').run(flags);
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
      case 'mcp-serve': await cmdMcpServe(flags, cfg); break;
      case 'mcp': {
        const sub = flags._[0];
        if (sub === 'install') await cmdMcpInstall(flags, cfg);
        else if (sub === 'serve') await cmdMcpServe(flags, cfg);
        else throw new Error('usage: icarus mcp <install|serve>');
        break;
      }
      default:
        console.log(`icarus — memory filesystem CLI (the .amr engine)

  icarus ingest <dir> --org <name>     extract + embed + store a folder
  icarus recall "<query>" --org <name> [--k 5] [--pq]
  icarus compact --org <name>          reclaim deleted memories' bytes
  icarus train-pq --org <name> [--seed 42]
                                        train PQ codebook -> enables --pq recall (see below)
  icarus status                        shards + disk usage
  icarus connect                       link your HIVEMIND account
  icarus connect-embeddings [--disable]
                                        configure an embedding provider for vector recall — OPT
                                        IN, not required: with none configured, ingest/recall
                                        run lexical-only (BM25), not an error
  icarus mcp install                   register icarus as an MCP server in every coding
                                        agent found on this machine (Claude Code, Codex, Cursor)
  icarus mcp serve                     run the MCP server directly (stdio) — what the agents
                                        installed above actually launch

  --pq recall (icarus recall --pq): an alternative to the default HNSW recall, not a universal
  upgrade — measured on real data, it builds much faster always, and queries FASTER than HNSW
  only on small/medium shards (recall_pq loses to HNSW's query latency as shard size grows).
  Good fit: shards you rebuild often. Run train-pq once first, or --pq errors with that reminder.

  env: LITELLM_API_KEY (embeddings, optional — see connect-embeddings), ICARUS_HOME (default ~/.icarus)`);
    }
  } catch (e) {
    console.error('✗', e.message);
    process.exit(1);
  }
}

main();
