#!/usr/bin/env node
'use strict';
// mneme CLI — ingest folders, recall, compact, status, connect HIVEMIND.
// Zero npm deps beyond the native addon; embeddings via the configured LiteLLM gateway (bge-m3).

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { MnemeStore } = require('./index.js');

const HOME = process.env.MNEME_HOME || path.join(os.homedir(), '.mneme');
const CFG_PATH = path.join(HOME, 'config.json');

function loadCfg() {
  try {
    return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  } catch (_) {
    return {
      dataRoot: path.join(HOME, 'data'),
      dim: 1024,
      embeddings: { endpoint: process.env.LITELLM_BASE_URL || 'https://api.blaiq.ai/v1', model: 'bge-m3' },
      hivemind: { connected: false },
    };
  }
}
function saveCfg(cfg) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
}

function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) out[args[i].slice(2)] = args[++i];
    else out._.push(args[i]);
  }
  return out;
}

async function embed(texts, cfg) {
  const key = process.env.LITELLM_API_KEY;
  if (!key) throw new Error('set LITELLM_API_KEY for embeddings (bge-m3 gateway)');
  const res = await fetch(`${cfg.embeddings.endpoint}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: cfg.embeddings.model, input: texts }),
  });
  if (!res.ok) throw new Error(`embedding API ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.data.map((d) => {
    const v = Float32Array.from(d.embedding);
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= n; // L2-normalize for cosine
    return v;
  });
}

function chunk(text, size = 900) {
  const words = text.split(/\s+/);
  const out = [];
  for (let i = 0; i < words.length; i += size) out.push(words.slice(i, i + size).join(' '));
  return out.filter((c) => c.trim().length > 20);
}

function walkText(dir) {
  const exts = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.log']);
  const files = [];
  (function rec(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p);
      else if (exts.has(path.extname(e.name).toLowerCase())) files.push(p);
    }
  })(dir);
  return files;
}

async function cmdIngest(flags, cfg) {
  const dir = flags._[0];
  const org = flags.org || 'default';
  if (!dir) throw new Error('usage: mneme ingest <dir> --org <name>');
  const store = MnemeStore.open(cfg.dataRoot, org, cfg.dim);
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
  if (!q) throw new Error('usage: mneme recall "<query>" --org <name>');
  const store = MnemeStore.open(cfg.dataRoot, org, cfg.dim);
  const [qv] = await embed([q], cfg);
  store.enableHnsw();
  const hits = store.recall(qv, k);
  console.log(`\ntop ${hits.length} for "${q}":\n`);
  hits.forEach((h, i) => {
    const txt = h.text.replace(/\s+/g, ' ').slice(0, 160);
    console.log(`  ${i + 1}. [${h.score.toFixed(4)}] ${txt}`);
  });
}

function cmdStatus(_flags, cfg) {
  console.log(`mneme  data: ${cfg.dataRoot}  dim: ${cfg.dim}`);
  console.log(`HIVEMIND: ${cfg.hivemind && cfg.hivemind.connected ? 'connected' : 'not connected'}`);
  let orgs = [];
  try {
    orgs = fs.readdirSync(cfg.dataRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (_) {}
  if (!orgs.length) return console.log('no shards yet — run: mneme ingest <dir> --org <name>');
  console.log(`\nshards:`);
  for (const o of orgs) {
    const dir = path.join(cfg.dataRoot, o.name);
    let bytes = 0;
    for (const f of fs.readdirSync(dir)) {
      try { bytes += fs.statSync(path.join(dir, f)).size; } catch (_) {}
    }
    console.log(`  ${o.name.padEnd(24)} ${(bytes / 1e6).toFixed(2)} MB on disk`);
  }
}

function cmdCompact(flags, cfg) {
  const org = flags.org || 'default';
  const store = MnemeStore.open(cfg.dataRoot, org, cfg.dim);
  const reclaimed = store.compact();
  console.log(`✓ compacted ${org}: reclaimed ${(reclaimed / 1e3).toFixed(1)} KB`);
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

async function cmdConnect(_flags, cfg) {
  const base = process.env.HIVEMIND_URL || 'https://hivemind.blaiq.ai';
  console.log(`\nConnect mneme ↔ HIVEMIND`);
  console.log(`  1. Open: ${base}/settings/connections (authorize "mneme local")`);
  console.log(`  2. Copy the access token shown after authorizing.\n`);
  const token = await ask('  Paste HIVEMIND token (or blank to skip): ');
  if (!token) return console.log('  skipped.');
  cfg.hivemind = { connected: true, url: base, token, connectedAt: new Date().toISOString() };
  saveCfg(cfg);
  console.log('  ✓ HIVEMIND connected. Token stored in', CFG_PATH);
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
      case 'connect': await cmdConnect(flags, cfg); break;
      default:
        console.log(`mneme — memory filesystem CLI

  mneme ingest <dir> --org <name>     extract + embed + store a folder
  mneme recall "<query>" --org <name> [--k 5]
  mneme compact --org <name>          reclaim deleted memories' bytes
  mneme status                        shards + disk usage
  mneme connect                       link your HIVEMIND account

  env: LITELLM_API_KEY (embeddings), MNEME_HOME (default ~/.mneme)`);
    }
  } catch (e) {
    console.error('✗', e.message);
    process.exit(1);
  }
}

main();
