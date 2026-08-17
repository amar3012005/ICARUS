/**
 * ICARUS — zero to agent memory, in one script, no API key required.
 *
 *   npm install singulance-amr
 *   node demo-60s.mjs
 *
 * The engine does not embed text itself (see README's "bring your own embeddings"
 * contract) — real deployments pass a real embedding model (bge-m3, OpenAI, etc). This
 * demo uses a tiny deterministic hash-embedding instead, specifically so it runs on a
 * completely clean machine with ZERO setup: no API key, no network call, no cost. It's
 * not a real embedding model — don't judge recall QUALITY from this, only the API shape
 * and the fact that it actually runs end to end. See bench/ for real bge-m3 numbers.
 */
import { MnemeStore } from 'singulance-amr';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const t0 = Date.now();
const DIM = 64;

// Toy embedding: hash each word into one of DIM buckets, L2-normalize. Directionally
// sane for exact/overlapping-word queries (the point of this demo), NOT a real semantic
// embedding — no synonym/paraphrase understanding at all.
function toyEmbed(text) {
  const v = new Float32Array(DIM);
  for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 2166136261;
    for (const ch of word) h = (h ^ ch.charCodeAt(0)) * 16777619 >>> 0;
    v[h % DIM] += 1;
  }
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

console.log('1. Open a shard — one memory-mapped file, no server, no account.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-demo-'));
const store = MnemeStore.open(root, 'demo-org', DIM);
console.log(`   ${root}/demo-org (live=${store.liveCount()})\n`);

console.log('2. Ingest a few memories.');
const memories = [
  'the user prefers dark mode in every app',
  'the user works remotely from Berlin',
  'the warranty on the laptop covers 24 months of parts and labor',
  'the quarterly revenue report shows growth in the EU region',
];
for (const m of memories) {
  store.insert(m, toyEmbed(m), 0);
  console.log(`   + "${m}"`);
}
store.enableHnsw();
store.flush();
console.log(`   live=${store.liveCount()}\n`);

console.log('3. Recall by similarity.');
// A real embedding model (bge-m3, OpenAI, ...) would rank this correctly even worded as
// "UI theme preference" with zero shared words — the toy hash-embedding above can't do
// that (it's pure word overlap, no learned meaning), so this query deliberately shares
// real words with the target memory. Swap in a real embedder and paraphrased queries
// work too — see bench/ for that actually measured, on real bge-m3.
const query = 'user dark mode preference';
const hits = store.recall(toyEmbed(query), 2);
console.log(`   query: "${query}"`);
for (const h of hits) console.log(`   [${h.score.toFixed(3)}] ${h.text}`);

console.log(`\nDone in ${Date.now() - t0}ms. Real embeddings (bge-m3/OpenAI) instead of the`);
console.log('toy hash above is the only change needed for production — same API.');
