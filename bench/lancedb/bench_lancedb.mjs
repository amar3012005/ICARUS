// ROADMAP T1-4 — LanceDB side of the embedded-to-embedded benchmark vs mneme.
// Same corpus, same queries, same ground truth, same k. LanceDB is queried through its own
// ANN index (createIndex on the vector column — IVF_PQ default), the realistic embedded-app path,
// not brute force.
//
// Usage: node bench_lancedb.mjs <corpus.bin> <queries.bin> <dim> <k> <dataRoot> <groundTruth.json>
import { execSync } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import * as lancedb from '@lancedb/lancedb';
import { loadF32, exactTopK, stats } from './shared.mjs';

const [corpusPath, queriesPath, dimStr, kStr, dataRoot, gtPath] = process.argv.slice(2);
const dim = Number(dimStr);
const k = Number(kStr);

const corpus = loadF32(corpusPath, dim);
const queries = loadF32(queriesPath, dim);
console.error(`[lancedb] corpus=${corpus.length} queries=${queries.length} dim=${dim} k=${k}`);

const groundTruth = exactTopK(corpus, queries, k, gtPath);

rmSync(dataRoot, { recursive: true, force: true });
mkdirSync(dataRoot, { recursive: true });
const db = await lancedb.connect(dataRoot);

// Ingest — LanceDB's Node API is bulk-oriented (createTable takes the whole batch), so there is
// no meaningful per-row insert latency to report; we time the one bulk write instead, same as
// how an embedded app would actually load 10k vectors.
const rows = corpus.map((v, i) => ({ id: i, vector: Array.from(v) }));
const t0 = performance.now();
const tbl = await db.createTable('bench', rows, { mode: 'overwrite' });
const ingestWallMs = performance.now() - t0;

const buildT0 = performance.now();
await tbl.createIndex('vector');
const buildMs = performance.now() - buildT0;

// Two passes, both honest: LanceDB's out-of-the-box default index params, and a tuned pass
// (higher nprobes + refineFactor) — the "what does it cost to match mneme's recall" comparison.
// Reporting only the default would flatter neither engine; reporting only tuned would hide what
// most embedders actually get by default.
async function runPass(searchOpts) {
  const latencies = [];
  let overlap = 0;
  for (let qi = 0; qi < queries.length; qi++) {
    const t = performance.now();
    let q = tbl.search(Array.from(queries[qi])).limit(k);
    if (searchOpts?.nprobes) q = q.nprobes(searchOpts.nprobes);
    if (searchOpts?.refineFactor) q = q.refineFactor(searchOpts.refineFactor);
    const hits = await q.toArray();
    latencies.push(performance.now() - t);
    const got = new Set(hits.map((h) => Number(h.id)));
    for (const id of groundTruth[qi]) if (got.has(id)) overlap++;
  }
  return { latencies, recallAtK: overlap / (queries.length * k) };
}

const defaultPass = await runPass(null);
const tunedPass = await runPass({ nprobes: 50, refineFactor: 20 });
const queryLatencies = defaultPass.latencies;
const recallAtK = defaultPass.recallAtK;

const sizeBytes = Number(execSync(`du -sk "${dataRoot}"`).toString().split('\t')[0]) * 1024;

console.log(JSON.stringify({
  engine: 'LanceDB (@lancedb/lancedb, embedded)',
  n: corpus.length,
  dim,
  k,
  ingest_wall_ms: ingestWallMs,
  index_build_ms: buildMs,
  query_p50_ms: stats(queryLatencies).p50,
  query_p90_ms: stats(queryLatencies).p90,
  query_p99_ms: stats(queryLatencies).p99,
  recall_at_k: recallAtK,
  tuned_nprobes: 50,
  tuned_refine_factor: 20,
  tuned_query_p50_ms: stats(tunedPass.latencies).p50,
  tuned_query_p99_ms: stats(tunedPass.latencies).p99,
  tuned_recall_at_k: tunedPass.recallAtK,
  storage_bytes: sizeBytes,
  storage_bytes_per_record: sizeBytes / corpus.length,
}, null, 2));
