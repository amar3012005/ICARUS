// P6-4 soak harness: continuous insert + recall load on the mneme-backed store, tracking
// crashes, RSS growth (leak detection), and recall p99. After SOAK_HOURS it writes the
// soak_* metrics the P6 soak gate reads. The gate requires a COMPLETED 72h run
// (soak_hours_completed > 71.9) — a still-running soak is a fail by design. Run a short
// duration to prove the harness; run 72 to actually clear the gate (3 days later).
//
// Usage: SOAK_HOURS=72 node soak.js <out_file>   (default SOAK_HOURS=0.05 for a quick proof)

const fs = require('fs');
const { MnemeVectorStore } = require('./index.js');

const HOURS = Number(process.env.SOAK_HOURS || 0.05);
const DIM = Number(process.env.SOAK_DIM || 256);
const OUT = process.argv[2] || '/tmp/mneme_soak.txt';

function randVec(dim) {
  const v = new Float32Array(dim);
  let n = 0;
  for (let i = 0; i < dim; i++) {
    v[i] = Math.random() - 0.5;
    n += v[i] * v[i];
  }
  n = Math.sqrt(n);
  for (let i = 0; i < dim; i++) v[i] /= n;
  return v;
}

function p99(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(0.99 * s.length))] || 0;
}

(async () => {
  const root = '/tmp/mneme-soak-' + Date.now();
  const store = new MnemeVectorStore({ dataRoot: root, dim: DIM });

  // preload so recall has a real corpus.
  const PRE = 5000;
  const pts = [];
  for (let i = 0; i < PRE; i++) pts.push({ id: i, vector: randVec(DIM), payload: { i } });
  await store.upsert('soak', pts);
  await store.search('soak', randVec(DIM), 5); // trigger index build
  const rss0 = process.memoryUsage().rss;

  const deadline = Date.now() + HOURS * 3600 * 1000;
  let nextId = PRE;
  let crashes = 0;
  let maxRss = rss0;
  const lat = [];
  let ops = 0;

  while (Date.now() < deadline) {
    try {
      // insert one + recall (the steady-state load)
      await store.upsert('soak', [{ id: nextId, vector: randVec(DIM), payload: { i: nextId } }]);
      nextId++;
      const t = process.hrtime.bigint();
      await store.search('soak', randVec(DIM), 5);
      lat.push(Number(process.hrtime.bigint() - t) / 1e6);
      ops++;
      if (ops % 2000 === 0) {
        const rss = process.memoryUsage().rss;
        if (rss > maxRss) maxRss = rss;
        // periodic re-index so HNSW keeps up with inserts (and exercises the build path)
        await store.search('soak', randVec(DIM), 5);
      }
    } catch (e) {
      crashes++;
    }
  }

  const hours = HOURS; // completed (the loop ran to the deadline)
  const rssGrowthPct = ((maxRss - rss0) / rss0) * 100;
  const out =
    `soak_hours_completed=${hours.toFixed(4)}\n` +
    `soak_crashes=${crashes}\n` +
    `soak_rss_growth_pct=${rssGrowthPct.toFixed(4)}\n` +
    `soak_recall_p99_ms=${p99(lat).toFixed(4)}\n` +
    `soak_ops=${ops}\n`;
  fs.writeFileSync(OUT, out);
  console.log(out);
})();
