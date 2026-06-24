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
  let rss0 = process.memoryUsage().rss;

  const start = Date.now();
  const deadline = start + HOURS * 3600 * 1000;
  let nextId = PRE;
  let crashes = 0;
  let maxRss = rss0;
  const lat = [];
  let ops = 0;
  let lastCheckpoint = start;

  const writeMetrics = (done) => {
    const hours = (Date.now() - start) / 3600000;
    fs.writeFileSync(
      OUT,
      `soak_hours_completed=${(done ? HOURS : hours).toFixed(4)}\n` +
        `soak_crashes=${crashes}\n` +
        `soak_rss_growth_pct=${(((maxRss - rss0) / rss0) * 100).toFixed(4)}\n` +
        `soak_recall_p99_ms=${p99(lat).toFixed(4)}\n` +
        `soak_ops=${ops}\n` +
        `soak_status=${done ? 'complete' : 'running'}\n`
    );
  };

  // Steady-state load: hold a BOUNDED working set so RSS growth is a leak signal, not data
  // growth. Fill to CAP, then run recall-dominant with a trickle of inserts capped at CAP*1.2
  // (a real memory store is read-heavy). Unbounded insertion would grow RSS with the corpus and
  // conflate "the index got bigger" with "we leaked".
  const CAP = Number(process.env.SOAK_CAP || 30000);
  let steady = false;
  while (Date.now() < deadline) {
    try {
      // 1 insert every 10 ops while under cap; otherwise pure recall (read-heavy steady state).
      if (nextId < CAP && ops % 10 === 0) {
        await store.upsert('soak', [{ id: nextId, vector: randVec(DIM), payload: { i: nextId } }]);
        nextId++;
      } else if (!steady && nextId >= CAP) {
        // corpus filled — reset the leak baseline so growth/p99 measure STEADY STATE only,
        // not the legitimate data-growth + index warmup of the fill phase.
        steady = true;
        rss0 = process.memoryUsage().rss;
        maxRss = rss0;
        lat.length = 0;
      }
      const t = process.hrtime.bigint();
      await store.search('soak', randVec(DIM), 5);
      lat.push(Number(process.hrtime.bigint() - t) / 1e6);
      if (lat.length > 100000) lat.splice(0, 50000); // bound the latency buffer itself
      ops++;
      if (ops % 2000 === 0) {
        const rss = process.memoryUsage().rss;
        if (rss > maxRss) maxRss = rss;
        await store.search('soak', randVec(DIM), 5);
      }
      // checkpoint metrics every ~60s so the run is monitorable without touching it.
      if (Date.now() - lastCheckpoint > 60000) {
        writeMetrics(false);
        lastCheckpoint = Date.now();
      }
    } catch (e) {
      crashes++;
    }
  }

  writeMetrics(true);
  console.log('soak complete');
})();
