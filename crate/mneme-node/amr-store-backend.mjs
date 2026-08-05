// .amr persistence backend for the Prisma adapter (Path B). Memory records live as .amr slots
// (full-record JSON in the slot text + embedding vector + layer); relationships live as typed edges.
// Implements the { loadAll, insert, update, remove } backend the adapter's MnemeModel calls, plus
// edge round-tripping for relationships. The vector never enters the stored JSON (it's the slot's
// own vector); _vector is the transient input field.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const LAYER_ID = { memory: 0, evidence: 1, cognitive: 2 };
const LAYER_NAME = ['memory', 'evidence', 'cognitive'];
const REL_TYPE = { Mentions: 1, Updates: 2, Derives: 3, Contradicts: 4, PartOf: 5, Extends: 6 };
const REL_NAME = [null, 'Mentions', 'Updates', 'Derives', 'Contradicts', 'PartOf', 'Extends'];

export function loadBinding(nodePath) {
  return require(nodePath);
}

// Backs the `memory` model: each record is a .amr slot. idToSlot maps record id → slot for
// update/delete/edge-wiring. Append-only update = tombstone old + insert new.
export class MnemeMemoryBackend {
  constructor(store, dim) {
    this.store = store;
    this.dim = dim;
    this.idToSlot = new Map();
  }
  loadAll() {
    const recs = [];
    for (const r of this.store.allRecords()) {
      let rec;
      try { rec = JSON.parse(r.text); } catch { continue; }
      if (!rec || !rec.id) continue;
      this.idToSlot.set(rec.id, r.slotId);
      recs.push(rec);
    }
    return recs;
  }
  insert(rec) {
    const layer = LAYER_ID[rec.layer] ?? 0;
    const vec = Array.isArray(rec._vector) ? Float32Array.from(rec._vector) : new Float32Array(this.dim);
    const { _vector, ...clean } = rec;
    const slot = this.store.insertLayered(JSON.stringify(clean), vec, 0, layer);
    this.idToSlot.set(rec.id, slot);
    this.store.flush();
  }
  update(id, rec) {
    const old = this.idToSlot.get(id);
    const { _vector, ...clean } = rec;
    const layer = LAYER_ID[rec.layer] ?? 0;
    const vec = Array.isArray(rec._vector) ? Float32Array.from(rec._vector) : new Float32Array(this.dim);
    const slot = this.store.insertLayered(JSON.stringify(clean), vec, 0, layer);
    this.idToSlot.set(id, slot);
    if (old != null) { try { this.store.delete(old); } catch { /* ignore */ } }
    this.store.flush();
  }
  remove(id) {
    const slot = this.idToSlot.get(id);
    if (slot != null) { try { this.store.delete(slot); } catch { /* ignore */ } this.idToSlot.delete(id); this.store.flush(); }
  }
}

// Backs the `relationship` model: records ↔ .amr typed edges. loadAll reconstructs relationship
// records by reading every memory slot's edges (slot_edges) and mapping slots back to memory ids.
export class MnemeRelationshipBackend {
  constructor(store, memBackend) {
    this.store = store;
    this.mem = memBackend;
  }
  _slotToId() {
    const m = new Map();
    for (const [id, slot] of this.mem.idToSlot) m.set(slot, id);
    return m;
  }
  loadAll() {
    const slot2id = this._slotToId();
    const out = [];
    for (const [fromId, fromSlot] of this.mem.idToSlot) {
      let edges;
      try { edges = this.store.slotEdges(fromSlot); } catch { continue; }
      for (const e of edges) {
        const toId = slot2id.get(e.target);
        if (!toId) continue;
        out.push({ id: `e:${fromId}:${toId}:${e.edgeType}`, fromId, toId, type: REL_NAME[e.edgeType] || 'Mentions', confidence: e.weight / 255 });
      }
    }
    return out;
  }
  insert(rel) {
    const fromSlot = this.mem.idToSlot.get(rel.fromId);
    const toSlot = this.mem.idToSlot.get(rel.toId);
    if (fromSlot != null && toSlot != null) {
      const et = REL_TYPE[rel.type] || 1;
      this.store.addEdge(fromSlot, toSlot, et, Math.max(1, Math.min(255, Math.round((rel.confidence ?? 1) * 255))));
      this.store.flush();
    }
  }
  update() { /* edges are immutable identity; supersession handled via memory versions */ }
  remove() { /* individual edge removal = compact-time; no-op live */ }
}

export { LAYER_NAME, REL_NAME };
