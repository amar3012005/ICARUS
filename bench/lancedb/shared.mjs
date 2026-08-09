// Shared loaders + exact-ground-truth computation for the mneme-vs-LanceDB embedded benchmark
// (ROADMAP.md T1-4 — "the killer benchmark", embedded-to-embedded, real corpus, honest either way).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export function loadF32(path, dim) {
  const buf = readFileSync(path);
  const n = buf.length / 4 / dim;
  const out = new Array(n);
  for (let r = 0; r < n; r++) {
    const v = new Float32Array(dim);
    for (let c = 0; c < dim; c++) v[c] = buf.readFloatLE((r * dim + c) * 4);
    out[r] = v;
  }
  return out;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Exact float32 cosine top-K per query (vectors are pre-normalized -> dot == cosine).
// Cached to disk so both engines are scored against the byte-identical ground truth.
export function exactTopK(corpus, queries, k, cachePath) {
  if (cachePath && existsSync(cachePath)) {
    return JSON.parse(readFileSync(cachePath, 'utf8'));
  }
  const out = [];
  for (const q of queries) {
    const scored = new Array(corpus.length);
    for (let i = 0; i < corpus.length; i++) scored[i] = [dot(q, corpus[i]), i];
    scored.sort((a, b) => b[0] - a[0]);
    out.push(scored.slice(0, k).map((x) => x[1]));
  }
  if (cachePath) writeFileSync(cachePath, JSON.stringify(out));
  return out;
}

export function percentile(sortedArr, p) {
  const idx = Math.min(sortedArr.length - 1, Math.floor((p / 100) * sortedArr.length));
  return sortedArr[idx];
}

export function stats(latenciesMs) {
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
  };
}
