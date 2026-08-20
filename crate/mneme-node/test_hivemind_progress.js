'use strict';
// The ingest UI must render observed async-job states, not an invented percentage.
const assert = require('assert');
const { hivemindPollJob, hivemindUploadFile, formatHivemindProgress, isInaccessibleHivemindDuplicate } = require('./cli-lib.js');

assert.strictEqual(isInaccessibleHivemindDuplicate(new Error('HIVEMIND documents 404: {"error":"Document not found or access denied"}')), true);
assert.strictEqual(isInaccessibleHivemindDuplicate(new Error('HIVEMIND documents 500: upstream unavailable')), false);

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

  const modes = [];
  global.fetch = async (_url, options) => {
    modes.push(options.body.get('ingestMode'));
    return { ok: true, status: 202, text: async () => JSON.stringify({ job_id: 'job-1', status: 'queued' }) };
  };
  const cfg = { hivemind: { apiUrl: 'https://example.test', token: 'test' } };
  await hivemindUploadFile(__filename, 'default', cfg);
  await hivemindUploadFile(__filename, 'default', cfg, { ingestMode: 'both' });
  assert.deepStrictEqual(modes, ['evidence', 'both']);
  global.fetch = originalFetch;
  console.log('HIVEMIND_PROGRESS_OK');
})().catch((error) => { global.fetch = originalFetch; throw error; });
