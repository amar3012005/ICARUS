/**
 * mneme quickstart — write, recall, layer-filter, graph, bi-temporal, compact.
 *
 *   npm install singulance-amr
 *   node quickstart.mjs
 *
 * Uses random vectors ONLY because this is an API demo. Never benchmark on random
 * vectors: they have no cluster structure, so ANN indexes behave nothing like they do on
 * real embeddings. See bench/ for the real-embedding harness.
 */
import { MnemeStore } from 'singulance-amr';
import os from 'node:os';
import path from 'node:path';

const DIM = 8; // real deployments use the embedding model's dim (e.g. 1024 for bge-m3)
const ns = (date) => BigInt(date.getTime()) * 1_000_000n;
const vec = (seed) => Float32Array.from({ length: DIM }, (_, i) => Math.sin(seed + i));

const root = path.join(os.tmpdir(), 'mneme-quickstart');
const store = MnemeStore.open(root, 'tenant-demo', DIM);
console.log(`opened shard at ${root}/tenant-demo (live=${store.liveCount()})`);

// ── write ────────────────────────────────────────────────────────────────────────
// `text` is opaque to the engine; the reference integration stores JSON with an `id`,
// which is what findById() resolves.
const a = store.insert(JSON.stringify({ id: 'm1', body: 'Ada prefers dark roast' }), vec(1), 0);
const b = store.insert(JSON.stringify({ id: 'm2', body: 'Ada works in Berlin' }), vec(2), 0);

// Layers let ONE shard hold memories, evidence and synthesis, queried separately.
store.insertLayered(JSON.stringify({ id: 'e1', body: 'source: interview transcript p4' }), vec(3), 0, 1);
console.log(`wrote 3 records (2 memory, 1 evidence) — live=${store.liveCount()}`);

// ── recall ───────────────────────────────────────────────────────────────────────
console.log('recall(all):    ', store.recall(vec(1), 3).map((h) => h.slotId));
console.log('recall(memory): ', store.recallLayer(vec(1), 3, 0).map((h) => h.slotId));
console.log('recall(evidence):', store.recallLayer(vec(3), 3, 1).map((h) => h.slotId));

// ── graph ────────────────────────────────────────────────────────────────────────
store.addEdge(a, b, 1, 1.0); // 1 = Mentions
console.log('edges from m1:  ', store.slotEdges(a));
console.log('traverse Mentions:', store.traverseTyped(a, 1, 2));

// ── bi-temporal: supersede, then look back ───────────────────────────────────────
const t1 = ns(new Date('2026-01-01'));
const t2 = ns(new Date('2026-06-01'));
const newer = store.update(a, JSON.stringify({ id: 'm1', body: 'Ada prefers espresso' }),
  vec(1), Number(t2), 0);
console.log(`m1 superseded: slot ${a} -> ${newer}`);
console.log('as of 2026-03: ', store.asOf(newer, Number(ns(new Date('2026-03-01')))));
console.log('as of 2026-09: ', store.asOf(newer, Number(ns(new Date('2026-09-01')))));
console.log('findById(m1):  ', store.findById('m1'), '(the LATEST version)');
void t1;

// ── scan without loading the shard into JS heap ──────────────────────────────────
let from = 0; let seen = 0;
for (;;) {
  const page = store.recordsPage(from, 2);
  seen += page.rows.length;
  if (page.nextSlot === 4294967295) break; // u32::MAX -> scan complete
  from = page.nextSlot;
}
console.log(`streamed ${seen} live records`);

// ── maintenance ──────────────────────────────────────────────────────────────────
// Deletes tombstone; bytes come back on compact(). Slot ids can MOVE — drop cached ids.
store.delete(b);
store.flush();
console.log(`compact reclaimed ${store.compact()} bytes — live=${store.liveCount()}`);
