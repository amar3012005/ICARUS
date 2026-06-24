// Compare mneme top-k vs prod-Qdrant top-k on the same queries (real prod org vectors).
const fs = require('fs');
const [mPath, qPath] = process.argv.slice(2);

function load(p) {
  const m = new Map();
  for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    const o = JSON.parse(l);
    m.set(o.qid, o);
  }
  return m;
}
const M = load(mPath);
const Q = load(qPath);

let sumOverlap = 0;
let sumTop1 = 0;
let n = 0;
const qlat = [];
const dist = {};
for (const [qid, q] of Q) {
  const m = M.get(qid);
  if (!m) continue;
  const qset = new Set(q.ids.map(String));
  const inter = m.ids.filter((id) => qset.has(String(id))).length;
  const k = q.ids.length || 10;
  sumOverlap += inter / k;
  if (m.ids[0] != null && String(m.ids[0]) === String(q.ids[0])) sumTop1++;
  dist[inter] = (dist[inter] || 0) + 1;
  if (typeof q.ms === 'number') qlat.push(q.ms);
  n++;
}
qlat.sort((a, b) => a - b);
const pct = (p) => (qlat.length ? qlat[Math.min(qlat.length - 1, Math.floor((p / 100) * qlat.length))] : NaN);

console.log(`\nShadow eval — mneme vs PROD Qdrant (org_40114bfd, real vectors)`);
console.log(`queries:            ${n}`);
console.log(`top-10 overlap:     ${(100 * sumOverlap / n).toFixed(2)}%  (mneme returns the same memories as prod)`);
console.log(`top-1 agreement:    ${(100 * sumTop1 / n).toFixed(2)}%`);
console.log(`Qdrant prod latency: p50=${pct(50).toFixed(3)}ms p99=${pct(99).toFixed(3)}ms (in-container, no client RTT)`);
console.log(`overlap histogram (matches/10): ${JSON.stringify(dist)}`);
