// Shadow eval (mneme side): load the scrolled prod vectors, build a local mneme shard, run
// leave-one-out top-k for a deterministic query sample. Writes queries.jsonl (for the Qdrant
// side) + mneme_results.jsonl. Usage: node shadow_mneme.js <corpus.jsonl> <outdir> [k] [nq]
const fs = require('fs');
const path = require('path');
const { MnemeVectorStore } = require('../crate/mneme-node/index.js');

const [corpusPath, outDir, kStr, nqStr] = process.argv.slice(2);
const K = Number(kStr || 10);
const NQ = Number(nqStr || 200);

const ids = [];
const vecs = [];
for (const line of fs.readFileSync(corpusPath, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const o = JSON.parse(line);
  ids.push(o.id);
  vecs.push(Float32Array.from(o.vector));
}
const dim = vecs[0].length;
console.error(`loaded ${ids.length} vectors, dim=${dim}`);

(async () => {
  const root = path.join(outDir, 'mneme-shard');
  fs.rmSync(root, { recursive: true, force: true });
  const store = new MnemeVectorStore({ dataRoot: root, dim });
  const BATCH = 1000;
  for (let s = 0; s < ids.length; s += BATCH) {
    const pts = [];
    for (let i = s; i < Math.min(s + BATCH, ids.length); i++) pts.push({ id: ids[i], vector: vecs[i], payload: {} });
    await store.upsert('shadow', pts);
  }
  // deterministic query sample spread across the corpus
  const step = Math.max(1, Math.floor(ids.length / NQ));
  const qIdx = [];
  for (let i = 0; i < ids.length && qIdx.length < NQ; i += step) qIdx.push(i);

  // warm the index, then time
  await store.search('shadow', vecs[qIdx[0]], K);

  const qOut = fs.createWriteStream(path.join(outDir, 'queries.jsonl'));
  const mOut = fs.createWriteStream(path.join(outDir, 'mneme_results.jsonl'));
  const lat = [];
  for (const qi of qIdx) {
    const qv = vecs[qi];
    const t = process.hrtime.bigint();
    const hits = await store.search('shadow', qv, K);
    lat.push(Number(process.hrtime.bigint() - t) / 1e6);
    qOut.write(JSON.stringify({ qid: ids[qi], vector: Array.from(qv) }) + '\n');
    mOut.write(JSON.stringify({ qid: ids[qi], ids: hits.map((h) => h.id) }) + '\n');
  }
  qOut.end();
  mOut.end();
  lat.sort((a, b) => a - b);
  const pct = (p) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))];
  const storageBytes = fs.readdirSync(path.join(root, 'shadow')).reduce((a, f) => a + fs.statSync(path.join(root, 'shadow', f)).size, 0);
  console.error(
    `mneme: ${qIdx.length} queries, k=${K}, p50=${pct(50).toFixed(3)}ms p99=${pct(99).toFixed(3)}ms, shard=${(storageBytes / 1e6).toFixed(1)}MB`
  );
})();
