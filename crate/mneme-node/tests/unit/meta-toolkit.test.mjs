import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { z } = require('zod');
const { createToolkit, compatibleArgs } = require('../../mcp-toolkit.js');
const { queryHistory } = require('../../memory-history.js');
const { webRequest } = require('../../mcp-extra-tools.js');

test('meta dispatch preserves parsed defaults and rejects invalid/unknown arguments before a write', async () => {
  const kit = createToolkit(); let writes = 0;
  kit.registerTool('icarus_save_memory', { title: 'Save', inputSchema: { content: z.string(), tags: z.array(z.string()).default([]) } }, args => { writes++; return args; });
  assert.deepEqual(await kit.call({ action: 'hivemind_save_memory', args: { content: 'fact' } }), { content: 'fact', tags: [] });
  await assert.rejects(kit.call({ action: 'save_memory', args: { content: 'fact', cloud: true } }));
  await assert.rejects(kit.call({ action: 'save_memory', args: {} }));
  await assert.rejects(kit.call({ action: '__proto__', args: {} }));
  assert.equal(writes, 1);
  assert.deepEqual(compatibleArgs('diff', { from: 'a', to: 'b' }), { time_a: 'a', time_b: 'b' });
  assert.deepEqual(compatibleArgs('test_coverage', { action: 'list', fn_name: 'f' }), { action: 'recall', function_name: 'f' });
});

function historyStore(records, edges = {}) {
  return { recordsPage: () => ({ rows: records.map((record, slotId) => ({ slotId, text: JSON.stringify(record) })), nextSlot: 0xffffffff }), slotEdges: slot => edges[slot] || [] };
}
test('history separates learned time and effective time and follows updates across memory ids', () => {
  const store = historyStore([
    { id: 'a', content: 'blue', tags: ['file:a.js'], created_at: '2026-01-01T00:00:00Z', transaction_time: '2026-01-01T00:00:00Z', valid_from: Date.parse('2026-01-01T00:00:00Z') },
    { id: 'b', content: 'green', tags: ['file:a.js'], created_at: '2026-01-03T00:00:00Z', transaction_time: '2026-01-03T00:00:00Z', valid_from: Date.parse('2026-01-02T00:00:00Z') },
  ], { 1: [{ edgeType: 2, target: 0 }] });
  assert.equal(queryHistory(store, 'at', { transaction_time: '2026-01-02T00:00:00Z' }).memories[0].content, 'blue');
  assert.equal(queryHistory(store, 'at', { valid_time: '2026-01-02T00:00:00Z' }).memories[0].content, 'green');
  assert.equal(queryHistory(store, 'at', { valid_time: '2026-01-02T00:00:00Z', transaction_time: '2026-01-02T00:00:00Z' }).memories[0].content, 'blue');
  assert.equal(queryHistory(store, 'timeline', { memory_id: 'b' }).versions.length, 2);
  const diff = queryHistory(store, 'diff', { time_a: '2026-01-02T00:00:00Z', time_b: '2026-01-04T00:00:00Z', query: 'blue' });
  assert.equal(diff.changes[0].kind, 'updated');
  assert.throws(() => queryHistory(store, 'timeline', { max_records: 1 }), /exceeds/);
});
test('legacy corrections never pretend to support an exact historical snapshot', () => {
  const store = historyStore([{ id: 'a', content: 'old', created_at: '2026-01-01T00:00:00Z' }, { id: 'a', content: 'new', created_at: '2026-01-01T00:00:00Z' }]);
  assert.equal(queryHistory(store, 'timeline', {}).history_complete, false);
  assert.throws(() => queryHistory(store, 'at', { transaction_time: '2026-01-02T00:00:00Z' }), /Legacy corrections/);
});
test('history does not resurrect superseded versions after their current memory is deleted', () => {
  const store = historyStore([{ id: 'deleted', content: 'old secret', is_latest: false, created_at: '2026-01-01T00:00:00Z' }]);
  assert.deepEqual(queryHistory(store, 'timeline', {}).versions, []);
  assert.deepEqual(queryHistory(store, 'at', { transaction_time: '2026-01-02T00:00:00Z' }).memories, []);
});
test('developer identity cannot authorize hosted web calls', async () => {
  const original = global.fetch; let calls = 0; global.fetch = async () => { calls++; throw new Error('should not call'); };
  try {
    await assert.rejects(webRequest('/api/web/usage', undefined, { hivemind: { connected: true, apiUrl: 'https://example.invalid', token: 'icarus_dev_identity' } }), /identity only/);
    assert.equal(calls, 0);
  } finally { global.fetch = original; }
});
