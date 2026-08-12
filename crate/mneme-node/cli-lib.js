'use strict';
// Shared logic between mneme-cli.js and mcp-serve.js — config, embeddings, ingest/recall
// primitives. Extracted specifically so the CLI and the MCP server call the SAME code, not two
// copies that can silently drift apart (the exact class of bug the flag-parsing regression
// earlier in this repo's history was — one path fixed, the other forgotten).
const fs = require('fs');
const path = require('path');
const os = require('os');
// Lazy: some callers of this module (icarus mcp install, icarus status) never touch a shard,
// so they must not be forced to load the native addon just because this file was required.
function getMnemeStore() { return require('./index.js').MnemeStore; }

const HOME = process.env.ICARUS_HOME || process.env.MNEME_HOME || path.join(os.homedir(), '.icarus');
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

/** Ingest every text file under `dir` into `org`. Returns the number of chunks stored. */
async function ingestDir(dir, org, cfg, onProgress) {
  const store = getMnemeStore().open(cfg.dataRoot, org, cfg.dim);
  const files = walkText(dir);
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
    if (onProgress) onProgress(n);
  }
  store.enableHnsw();
  store.flush();
  return { files: files.length, chunks: n, live: store.liveCount() };
}

/** Recall `topK` memories for `query` in `org`. `usePq` requires trainPq() to have run first. */
async function recallQuery(query, org, cfg, topK = 5, usePq = false) {
  const store = getMnemeStore().open(cfg.dataRoot, org, cfg.dim);
  if (usePq && !store.pqTrained()) {
    throw new Error(`no PQ codebook trained for org "${org}" yet — run train_pq first`);
  }
  const [qv] = await embed([query], cfg);
  let hits;
  if (usePq) {
    hits = store.recallPq(qv, topK);
  } else {
    store.enableHnsw();
    hits = store.recall(qv, topK);
  }
  return hits.map((h) => ({ score: h.score, text: h.text }));
}

function statusReport(cfg) {
  let orgs = [];
  try {
    orgs = fs.readdirSync(cfg.dataRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (_) { /* no shards yet */ }
  return {
    dataRoot: cfg.dataRoot,
    dim: cfg.dim,
    hivemindConnected: !!(cfg.hivemind && cfg.hivemind.connected),
    shards: orgs.map((o) => {
      const dir = path.join(cfg.dataRoot, o.name);
      let bytes = 0;
      for (const f of fs.readdirSync(dir)) {
        try { bytes += fs.statSync(path.join(dir, f)).size; } catch (_) { /* race with a concurrent writer */ }
      }
      return { org: o.name, bytesOnDisk: bytes };
    }),
  };
}

module.exports = {
  HOME, CFG_PATH, loadCfg, saveCfg, embed, chunk, walkText, ingestDir, recallQuery, statusReport,
};
