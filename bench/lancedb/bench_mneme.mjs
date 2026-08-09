// ROADMAP T1-4 — mneme side of the embedded-to-embedded benchmark vs LanceDB.
// Real bge-m3 vectors (bench/data/*.bin), real .amr engine via the napi binding, HNSW index
// (the approximate path an embedded app actually uses, not brute force).
//
// Usage: node bench_mneme.mjs <corpus.bin> <queries.bin> <dim> <k> <dataRoot> <groundTruth.json>
import { execSync } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { loadF32, exactTopK, stats } from './shared.mjs';

const [corpusPath, queriesPath, dimStr, kStr, dataRoot, gtPath] = process.argv.slice(2);
const dim = Number(dimStr);
const k = Number(kStr);

const nativePath = new URL('../../crate/mneme-node/native.js', import.meta.url).pathname;
const nativeMod = await import(nativePath);
const MnemeStore = nativeMod.MnemeStore || nativeMod.default.MnemeStore;

const corpus = loadF32(corpusPath, dim);
const queries = loadF32(queriesPath, dim);
console.error(`[mneme] corpus=${corpus.length} queries=${queries.length} dim=${dim} k=${k}`);

const groundTruth = exactTopK(corpus, queries, k, gtPath);

rmSync(dataRoot, { recursive: true, force: true });
mkdirSync(dataRoot, { recursive: true });
const store = MnemeStore.open(dataRoot, 'bench', dim);

// Ingest — timed per-insert so we can report p50 alongside total wall time.
const insertLatencies = [];
const t0 = performance.now();
for (let i = 0; i < corpus.length; i++) {
  const t = performance.now();
  store.insert(String(i), corpus[i], 0);
  insertLatencies.push(performance.now() - t);
}
const ingestWallMs = performance.now() - t0;

const buildT0 = performance.now();
store.enableHnsw();
const buildMs = performance.now() - buildT0;

// Query — approximate (HNSW) recall@k, timed per-query.
const queryLatencies = [];
let overlap = 0;
for (let qi = 0; qi < queries.length; qi++) {
  const t = performance.now();
  const hits = store.recall(queries[qi], k);
  queryLatencies.push(performance.now() - t);
  const got = new Set(hits.map((h) => Number(h.text)));
  for (const id of groundTruth[qi]) if (got.has(id)) overlap++;
}
const recallAtK = overlap / (queries.length * k);

const sizeBytes = Number(execSync(`du -sk "${dataRoot}"`).toString().split('\t')[0]) * 1024;

console.log(JSON.stringify({
  engine: 'mneme (.amr, napi)',
  n: corpus.length,
  dim,
  k,
  ingest_wall_ms: ingestWallMs,
  ingest_p50_us: stats(insertLatencies).p50 * 1000,
  index_build_ms: buildMs,
  query_p50_ms: stats(queryLatencies).p50,
  query_p90_ms: stats(queryLatencies).p90,
  query_p99_ms: stats(queryLatencies).p99,
  recall_at_k: recallAtK,
  storage_bytes: sizeBytes,
  storage_bytes_per_record: sizeBytes / corpus.length,
}, null, 2));
