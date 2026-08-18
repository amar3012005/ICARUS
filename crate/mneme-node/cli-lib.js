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

// A shard takes an exclusive flock for the lifetime of its open handle. Each `icarus` CLI
// invocation is a short-lived process — one open, one command, process exits, lock releases
// naturally — so that was never a problem there. `icarus mcp serve` is NOT short-lived: it's
// one long process fielding many tool calls, and a real bug surfaced calling icarus_ingest then
// icarus_recall on the same org back to back — the second open collided with the first handle's
// still-held lock ("shard is locked by another process"), because nothing ever closed it and
// there's no exposed close()/drop() to call explicitly. Fix: cache one open handle per org per
// process and reuse it — the same pattern the HIVEMIND integration's embedded-agent.mjs already
// uses for the identical reason, and a real efficiency win too (skips re-scanning the shard's
// id index on every call).
const _storeCache = new Map(); // `${dataRoot}::${org}` -> open store handle
function openStore(cfg, org) {
  const key = `${cfg.dataRoot}::${org}`;
  let store = _storeCache.get(key);
  if (!store) {
    store = getMnemeStore().open(cfg.dataRoot, org, cfg.dim);
    _storeCache.set(key, store);
  }
  return store;
}

const HOME = process.env.ICARUS_HOME || process.env.MNEME_HOME || path.join(os.homedir(), '.icarus');
const CFG_PATH = path.join(HOME, 'config.json');

function loadCfg() {
  try {
    return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  } catch (_) {
    return {
      dataRoot: path.join(HOME, 'data'),
      dim: 1024,
      // No `enabled` flag to flip — presence of a key (env var OR stored) is what turns on
      // vector recall, `.env`-style (export LITELLM_API_KEY and it just works, no interactive
      // step required), the same pattern TencentDB Agent Memory's own setup uses. `disabled`
      // is the only explicit override, and only a person setting it wins over an env var —
      // BM25 lexical search needs no vector at all, so skipping this entirely still leaves a
      // fully working tool, not an error wall.
      embeddings: { disabled: false, endpoint: process.env.LITELLM_BASE_URL || 'https://api.blaiq.ai/v1', model: 'bge-m3', apiKey: null },
      hivemind: { connected: false },
    };
  }
}
function saveCfg(cfg) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
}

/** True if an embedding provider is actually usable: not explicitly disabled, AND a key is
 * available from EITHER the config file OR the environment (`LITELLM_API_KEY`) — `export
 * LITELLM_API_KEY=... && icarus ingest ...` works with zero setup step, the same way it would
 * against any other `.env`-driven tool. `icarus connect-embeddings --disable` is the only thing
 * that overrides an env var actually being present — an explicit no always wins. */
function embeddingsConfigured(cfg) {
  if (cfg.embeddings && cfg.embeddings.disabled) return false;
  return !!(cfg.embeddings?.apiKey || process.env.LITELLM_API_KEY);
}

async function embed(texts, cfg) {
  const key = cfg.embeddings?.apiKey || process.env.LITELLM_API_KEY;
  if (!key) throw new Error('no embedding provider configured — run `icarus connect-embeddings`, or use lexical-only (BM25) recall instead');
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

/** Ingest every text file under `dir` into `org`. Returns the number of chunks stored, and
 * which mode was used — `vector` when an embedding provider is configured, `lexical` when not
 * (BM25-only: text is stored and searchable, just not semantically). Never errors out just
 * because no embedding provider exists; it degrades, it doesn't refuse. */
async function ingestDir(dir, org, cfg, onProgress) {
  const store = openStore(cfg, org);
  const files = walkText(dir);
  const vectorMode = embeddingsConfigured(cfg);
  const zero = new Float32Array(cfg.dim); // BM25 needs no vector; a placeholder keeps every
                                           // slot's dim consistent so a later `connect-embeddings`
                                           // + re-ingest doesn't hit a dimension mismatch.
  let n = 0;
  for (const f of files) {
    const chunks = chunk(fs.readFileSync(f, 'utf8'));
    if (vectorMode) {
      for (let i = 0; i < chunks.length; i += 16) {
        const batch = chunks.slice(i, i + 16);
        const vecs = await embed(batch, cfg);
        batch.forEach((t, j) => {
          store.insert(`${path.basename(f)}\n${t}`, vecs[j], 0);
          n++;
        });
      }
    } else {
      for (const t of chunks) {
        store.insert(`${path.basename(f)}\n${t}`, zero, 0);
        n++;
      }
    }
    if (onProgress) onProgress(n);
  }
  if (vectorMode) store.enableHnsw();
  store.flush();
  return { files: files.length, chunks: n, live: store.liveCount(), mode: vectorMode ? 'vector' : 'lexical' };
}

/** Recall `topK` memories for `query` in `org`. `usePq` requires trainPq() to have run first
 * AND an embedding provider configured (PQ trains on real vectors, no way around that). With
 * no embedding provider configured and usePq not requested, transparently falls back to BM25
 * lexical search — the engine is still fully usable, just not semantic. */
async function recallQuery(query, org, cfg, topK = 5, usePq = false) {
  const store = openStore(cfg, org);
  const vectorMode = embeddingsConfigured(cfg);
  if (usePq && !vectorMode) {
    throw new Error('usePq requires an embedding provider — run `icarus connect-embeddings` first (PQ trains on real vectors)');
  }
  if (!vectorMode) {
    const hits = store.bm25Search(query, topK);
    return hits.map((h) => ({ score: h.score, text: h.text, mode: 'lexical' }));
  }
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
  return hits.map((h) => ({ score: h.score, text: h.text, mode: 'vector' }));
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
  embeddingsConfigured, openStore,
};
