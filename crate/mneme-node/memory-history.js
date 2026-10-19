'use strict';

// Local structured-record history, not a mirror of HIVEMIND's server MemoryVersion ledger.
// Explicit transaction stamps are recorded on new saves/corrections; legacy corrections that
// lack those stamps are reported as incomplete rather than assigned invented timestamps.
function timestamp(value, label) {
  const n = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(n)) throw new Error(`${label} must be an ISO timestamp or epoch milliseconds`);
  return n;
}

function readHistory(store, maxRecords = 10000) {
  const records = [];
  let from = 0, scanned = 0;
  for (;;) {
    const page = store.recordsPage(from, 500);
    for (const row of page.rows) {
      if (++scanned > maxRecords) throw new Error(`History scan exceeds ${maxRecords} records; raise max_records explicitly (maximum 100000). No partial snapshot returned.`);
      let record;
      try { record = JSON.parse(row.text); } catch (_) { continue; }
      if (typeof record?.id !== 'string') continue;
      records.push({ ...record, slot: row.slotId });
    }
    if (page.nextSlot === 0xffffffff) break;
    from = page.nextSlot;
  }
  const parent = new Map(records.map(r => [r.slot, r.slot]));
  const root = (slot) => { while (parent.get(slot) !== slot) slot = parent.get(slot); return slot; };
  const idHeads = new Map();
  for (const r of records) {
    if (idHeads.has(r.id)) parent.set(root(r.slot), root(idHeads.get(r.id)));
    else idHeads.set(r.id, r.slot);
    for (const edge of store.slotEdges(r.slot)) {
      if (edge.edgeType === 2 && parent.has(edge.target)) parent.set(root(r.slot), root(edge.target));
    }
  }
  for (const r of records) r.lineage = String(root(r.slot));
  const active = new Set(records.filter(r => r.is_latest !== false).map(r => r.lineage));
  const retained = records.filter(r => active.has(r.lineage));
  const counts = new Map();
  for (const r of retained) counts.set(r.id, (counts.get(r.id) || 0) + 1);
  return { records: retained, history_complete: retained.every(r => counts.get(r.id) < 2 || !!r.transaction_time) };
}

function matches(r, args) {
  if (args.memory_id && r.id !== args.memory_id) return false;
  if (args.file_path && !(r.tags || []).includes(`file:${args.file_path}`)) return false;
  if (args.project && r.project !== args.project && !(r.tags || []).includes(`project:${args.project}`)) return false;
  if (args.tags?.some(tag => !(r.tags || []).includes(tag))) return false;
  const terms = String(args.query || args.memory_query || '').toLowerCase().split(/\s+/).filter(Boolean);
  return !terms.length || terms.some(term => `${r.title || ''} ${r.content || ''}`.toLowerCase().includes(term));
}

function snapshot(records, args) {
  const tx = args.transaction_time ? timestamp(args.transaction_time, 'transaction_time') : Infinity;
  const valid = args.valid_time ? timestamp(args.valid_time, 'valid_time') : Infinity;
  const latest = new Map();
  for (const r of records) {
    const learned = timestamp(r.transaction_time || r.created_at, 'record transaction time');
    const effective = timestamp(r.valid_from ?? r.created_at, 'record valid time');
    if (learned > tx || effective > valid) continue;
    const previous = latest.get(r.lineage);
    if (!previous || learned > previous.learned || (learned === previous.learned && r.slot > previous.record.slot)) latest.set(r.lineage, { learned, record: r });
  }
  return [...latest.values()].map(v => v.record).filter(r => matches(r, args));
}

function queryHistory(store, action, args) {
  const { records, history_complete } = readHistory(store, args.max_records);
  const limit = args.limit || 20;
  const base = { source: 'local-amr', history_complete, excludes_deleted: true };
  if (action === 'timeline') {
    const seeds = records.filter(r => matches(r, args));
    const lineages = new Set(seeds.map(r => r.lineage));
    const versions = records.filter(r => lineages.has(r.lineage)).sort((a, b) => timestamp(b.transaction_time || b.created_at) - timestamp(a.transaction_time || a.created_at) || b.slot - a.slot);
    return { ...base, versions: versions.slice(0, limit), truncated: versions.length > limit };
  }
  if (action === 'at' || action === 'code_at') {
    if (!args.transaction_time && !args.valid_time) throw new Error('Specify transaction_time or valid_time');
    if (!history_complete) throw new Error('Legacy corrections lack transaction timestamps; an exact historical snapshot is unavailable. Use timeline to inspect the retained versions.');
    const memories = snapshot(records, args);
    return { ...base, memories: memories.slice(0, limit), truncated: memories.length > limit };
  }
  if (action === 'diff') {
    if (!history_complete) throw new Error('Legacy corrections lack transaction timestamps; exact historical diff is unavailable. Use timeline.');
    if (timestamp(args.time_a, 'time_a') > timestamp(args.time_b, 'time_b')) throw new Error('time_a must be before time_b');
    // Apply content filters after comparing snapshots so a memory changing OUT of a query
    // remains visible as a removal rather than vanishing from the comparison.
    const a = new Map(snapshot(records, { transaction_time: args.time_a }).map(r => [r.lineage, r]));
    const b = new Map(snapshot(records, { transaction_time: args.time_b }).map(r => [r.lineage, r]));
    const changes = [];
    for (const id of new Set([...a.keys(), ...b.keys()])) {
      const before = a.get(id) || null, after = b.get(id) || null;
      if (before?.slot === after?.slot || ![before, after].some(r => r && matches(r, args))) continue;
      changes.push({ before, after, kind: !before ? 'added' : !after ? 'removed' : 'updated' });
    }
    return { ...base, changes: changes.slice(0, limit), truncated: changes.length > limit };
  }
  throw new Error(`Unknown history action ${action}`);
}
module.exports = { queryHistory, readHistory, timestamp };
