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
const path = require('path');
const readline = require('readline');
// Lazy: `mcp install`/`status`/`connect` never touch a shard, so they must not be forced to
// load the native addon just because this file was required.
function getMnemeStore() { return require('./index.js').MnemeStore; }
const {
  CFG_PATH, loadCfg, saveCfg, embed, chunk, walkText, statusReport,
} = require('./cli-lib.js');

// Flags that are pure on/off switches (no value token follows) — everything else keeps the
// original "consume the next token as this flag's value" behavior unchanged, so `--k 5`,
// `--org acme`, `--seed 7` etc. are byte-identical to before this set existed. A heuristic
// ("no value follows -> must be boolean") was tried and rejected: it would silently turn a
// user mistyping `--k` with no value into `Number(true) === 1` instead of the intended
// fallback default — a worse failure than the boolean-flag bug it would have fixed.
const BOOLEAN_FLAGS = new Set(['pq']);

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
  const store = getMnemeStore().open(cfg.dataRoot, org, cfg.dim);
  const files = walkText(dir);
  console.log(`ingesting ${files.length} files → org "${org}"`);
  let n = 0;
  for (const f of files) {
    const chunks = chunk(fs.readFileSync(f, 'utf8'));
    for (let i = 0; i < chunks.length; i += 16) {
      const batch = chunks.slice(i, i + 16);
      const vecs = await embed(batch, cfg);
      batch.forEach((t, j) => {
        store.insert(`${path.basename(f)}\n${t}`, vecs[j], 0);
        n++;
      });
    }
    process.stdout.write(`\r  ${n} chunks`);
  }
  store.enableHnsw();
  store.flush();
  console.log(`\n✓ ingested ${n} chunks into ${org} (${store.liveCount()} live)`);
}

async function cmdRecall(flags, cfg) {
  const q = flags._[0];
  const org = flags.org || 'default';
  const k = Number(flags.k || 5);
  const usePq = flags.pq !== undefined;
  if (!q) throw new Error('usage: icarus recall "<query>" --org <name> [--pq]');
  const store = getMnemeStore().open(cfg.dataRoot, org, cfg.dim);
  // Check --pq's precondition BEFORE spending an embedding API call on a request that's
  // going to fail anyway.
  if (usePq && !store.pqTrained()) {
    throw new Error(`no PQ codebook trained for org "${org}" yet — run: icarus train-pq --org ${org}`);
  }
  const [qv] = await embed([q], cfg);
  let hits;
  if (usePq) {
    hits = store.recallPq(qv, k);
  } else {
    store.enableHnsw();
    hits = store.recall(qv, k);
  }
  console.log(`\ntop ${hits.length} for "${q}"${usePq ? ' (PQ/ADC recall)' : ''}:\n`);
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
  const store = getMnemeStore().open(cfg.dataRoot, org, cfg.dim);
  const live = store.liveCount();
  if (!live) throw new Error(`org "${org}" has no memories yet — nothing to train on`);
  console.log(`training PQ codebook for "${org}" (${live} live vectors, seed=${seed})...`);
  const t0 = Date.now();
  store.trainPq(seed);
  console.log(`✓ trained in ${((Date.now() - t0) / 1000).toFixed(1)}s — try: icarus recall "..." --org ${org} --pq`);
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

async function cmdConnect(_flags, cfg) {
  const base = process.env.HIVEMIND_URL || 'https://hivemind.blaiq.ai';
  console.log(`\nConnect ICARUS ↔ HIVEMIND`);
  console.log(`  1. Open: ${base}/settings/connections (authorize "icarus local")`);
  console.log(`  2. Copy the access token shown after authorizing.\n`);
  const token = await ask('  Paste HIVEMIND token (or blank to skip): ');
  if (!token) return console.log('  skipped.');
  cfg.hivemind = { connected: true, url: base, token, connectedAt: new Date().toISOString() };
  saveCfg(cfg);
  console.log('  ✓ HIVEMIND connected. Token stored in', CFG_PATH);
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
  icarus mcp install                   register icarus as an MCP server in every coding
                                        agent found on this machine (Claude Code, Codex, Cursor)
  icarus mcp serve                     run the MCP server directly (stdio) — what the agents
                                        installed above actually launch

  --pq recall (icarus recall --pq): an alternative to the default HNSW recall, not a universal
  upgrade — measured on real data, it builds much faster always, and queries FASTER than HNSW
  only on small/medium shards (recall_pq loses to HNSW's query latency as shard size grows).
  Good fit: shards you rebuild often. Run train-pq once first, or --pq errors with that reminder.

  env: LITELLM_API_KEY (embeddings), ICARUS_HOME (default ~/.icarus)`);
    }
  } catch (e) {
    console.error('✗', e.message);
    process.exit(1);
  }
}

main();
