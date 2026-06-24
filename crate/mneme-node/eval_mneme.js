// P6-3: eval the MnemeVectorStore (napi → .mseg engine) on the real bge-m3 10k corpus.
// Score = mean recall@K vs the exact float32 cosine ground truth (the same metric the Qdrant
// baseline is scored on by bench/quality_vs_qdrant.py). Prints mneme_eval_score.
//
// Usage: node eval_mneme.js <corpus_f32.bin> <queries_f32.bin> <dim> [k]

const fs = require('fs');
const { MnemeVectorStore } = require('./index.js');

function loadF32(path, dim) {
  const buf = fs.readFileSync(path);
  const n = buf.length / 4 / dim;
  const rows = [];
  for (let r = 0; r < n; r++) {
    const v = new Float32Array(dim);
    for (let c = 0; c < dim; c++) v[c] = buf.readFloatLE((r * dim + c) * 4);
    rows.push(v);
  }
  return rows;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

(async () => {
  const [corpusPath, queriesPath, dimStr, kStr] = process.argv.slice(2);
  const dim = Number(dimStr);
  const k = Number(kStr || 5);
  const corpus = loadF32(corpusPath, dim);
  const queries = loadF32(queriesPath, dim);
  console.error(`corpus=${corpus.length} queries=${queries.length} dim=${dim} k=${k}`);

  const root = '/tmp/mneme-eval-' + Date.now();
  const store = new MnemeVectorStore({ dataRoot: root, dim });
  // upsert in batches; id = corpus row index so we can compare to exact ground truth.
  const BATCH = 1000;
  for (let s = 0; s < corpus.length; s += BATCH) {
    const pts = [];
    for (let i = s; i < Math.min(s + BATCH, corpus.length); i++) {
      pts.push({ id: i, vector: corpus[i], payload: {} });
    }
    await store.upsert('eval', pts);
  }
  console.error('upserted; searching...');

  // recall@k vs exact float32 top-k (same metric as bench/quality_vs_qdrant.py).
  let overlap = 0;
  let denom = 0;
  for (let qi = 0; qi < queries.length; qi++) {
    const q = queries[qi];
    const scored = corpus.map((v, i) => [dot(q, v), i]);
    scored.sort((a, b) => b[0] - a[0]);
    const exact = new Set(scored.slice(0, k).map((x) => x[1]));
    const hits = await store.search('eval', q, k);
    for (const h of hits) if (exact.has(h.id)) overlap++;
    denom += k;
  }
  const score = overlap / denom;
  console.log(`mneme_eval_score=${score.toFixed(4)}`);
  console.log(`mneme_eval_k=${k}`);
  console.log(`mneme_eval_n=${corpus.length}`);
})();
