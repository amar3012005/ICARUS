'use strict';
// The ingest UI must render observed async-job states, not an invented percentage.
const assert = require('assert');
const { hivemindPollJob, formatHivemindProgress } = require('./cli-lib.js');

const originalFetch = global.fetch;
const responses = [
  { status: 'queued', counts: { pages: null, segments: null, memories: null } },
  { status: 'processing', counts: { pages: 4, segments: 18, memories: 3 } },
  { status: 'ready', counts: { pages: 4, segments: 22, memories: 5 }, document_id: 'doc-1' },
];
global.fetch = async () => ({ ok: true, json: async () => responses.shift() });

(async () => {
  const observed = [];
  const ready = await hivemindPollJob('job-1', { hivemind: { apiUrl: 'https://example.test', token: 'test' } }, {
    intervalMs: 0,
    maxAttempts: 4,
    onStatus: (status) => observed.push(status),
  });
  assert.strictEqual(ready.status, 'ready');
  assert.deepStrictEqual(observed.map((status) => status.status), ['queued', 'processing', 'ready']);
  assert.deepStrictEqual(observed[1].counts, { pages: 4, segments: 18, memories: 3 });
  assert.strictEqual(formatHivemindProgress({ total: 11, completed: 3, phase: 'processing', file: 'report.pdf', counts: observed[1].counts }, '⠹'), '\r  ⠹ [██████▌░░░░░░░░░░░░░░░] 3/11  extracting · 4 pages · 18 segments · 3 memories  report.pdf');
  global.fetch = originalFetch;
  console.log('HIVEMIND_PROGRESS_OK');
})().catch((error) => { global.fetch = originalFetch; throw error; });
