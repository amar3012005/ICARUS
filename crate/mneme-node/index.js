'use strict';
// MnemeVectorStore — drop-in replacement for HIVEMIND's QdrantVectorStore
// (core/src/ingestion/indexer.js). Same async upsert(collectionName, points) +
// search(collectionName, vector, topK) interface, backed by the local .mseg engine
// (one shard per collection). No network, no Qdrant server.
//
// A Qdrant point's { id, vector, payload } is stored as the memory's text = JSON({id,payload})
// plus its embedding; search recalls by vector and reconstructs { id, score, payload } so
// indexer.js call sites are unchanged.

const path = require('path');
const { MnemeStore } = require('./mneme.node');

function sanitizeOrg(name) {
  const s = String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return s.length ? s : 'default';
}

class MnemeVectorStore {
  constructor(opts = {}) {
    this.dataRoot = opts.dataRoot || process.env.MNEME_DATA_ROOT || '/tmp/mneme-data';
    this.dim = opts.dim || Number(process.env.MNEME_DIM || 1024);
    this.stores = new Map();
    this.dirty = new Set();
  }

  _store(collectionName) {
    if (!this.stores.has(collectionName)) {
      const org = sanitizeOrg(collectionName);
      this.stores.set(collectionName, MnemeStore.open(this.dataRoot, org, this.dim));
    }
    return this.stores.get(collectionName);
  }

  async upsert(collectionName, points) {
    const s = this._store(collectionName);
    for (const p of points) {
      const vec = p.vector instanceof Float32Array ? p.vector : Float32Array.from(p.vector);
      const text = JSON.stringify({ id: p.id, payload: p.payload || {} });
      s.insert(text, vec, 0);
    }
    this.dirty.add(collectionName);
    return { upserted: points.length };
  }

  async search(collectionName, vector, topK = 5) {
    const s = this._store(collectionName);
    // (re)build the HNSW overlay lazily after a batch of upserts.
    if (this.dirty.has(collectionName)) {
      s.enableHnsw();
      this.dirty.delete(collectionName);
    }
    const q = vector instanceof Float32Array ? vector : Float32Array.from(vector);
    const hits = s.recall(q, topK);
    return hits.map((h) => {
      let rec;
      try {
        rec = JSON.parse(h.text);
      } catch (_) {
        rec = { id: h.slotId, payload: {} };
      }
      return { id: rec.id, score: h.score, payload: rec.payload };
    });
  }
}

module.exports = { MnemeVectorStore, MnemeStore, sanitizeOrg };
