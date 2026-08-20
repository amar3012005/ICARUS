'use strict';
const assert = require('assert');
const { normalizeStructuredSaveToolCall } = require('./cli-lib.js');

const knownIds = new Set(['memory-1']);
const draft = normalizeStructuredSaveToolCall(JSON.stringify({
  title: 'Kruti project decision', content: 'Kruti chose the memory project.',
  tags: ['kruti', 'memory'], memory_type: 'decision', entities: ['Kruti', 'Memory Project'],
  relationship: 'extend', related_to: 'memory-1',
}), knownIds);
assert.deepStrictEqual(draft, {
  title: 'Kruti project decision', content: 'Kruti chose the memory project.',
  tags: ['kruti', 'memory'], memoryType: 'decision', entities: ['Kruti', 'Memory Project'],
  relationship: 'extend', relatedTo: 'memory-1',
});
assert.strictEqual(normalizeStructuredSaveToolCall('{bad json', knownIds), null);
assert.strictEqual(normalizeStructuredSaveToolCall(JSON.stringify({ title: 'x', content: 'y', tags: [], relationship: 'update', related_to: 'invented-id' }), knownIds).relationship, null);
console.log('INTELLIGENT_SAVE_OK');
