'use strict';
// Regression coverage for the two-stage local recall path. The exact-subject evidence must make
// the WIDE candidate pool even when ordinary question words dominate the BM25 head; the reranker
// is the component that then decides the narrow final ordering.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore, recallQuery } = require('./cli-lib.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-recall-pipeline-'));
const cfg = {
  dataRoot: root,
  dim: 1024,
  embeddings: { disabled: true },
  hivemind: { connected: true, token: 'test', apiUrl: 'https://example.test' },
};

const originalFetch = global.fetch;
global.fetch = async (url, options = {}) => {
  if (String(url).includes('/v1/embeddings')) throw new Error('synthetic embedding outage');
  if (String(url).includes('/api/v1/rerank')) {
    const body = JSON.parse(options.body);
    const results = body.documents
      .map((text, index) => ({ index, relevance_score: /SOLVIS/i.test(text) ? 0.99 : 0.01 }))
      .sort((a, b) => b.relevance_score - a.relevance_score);
    return { ok: true, json: async () => ({ results }) };
  }
  throw new Error(`unexpected fetch: ${url}`);
};

(async () => {
  try {
    const store = openStore(cfg, 'default');
    const zero = new Float32Array(cfg.dim);
    // These documents intentionally contain enough high-frequency question glue to push the
    // exact-subject record beyond the old 32-candidate budget.
    for (let i = 0; i < 60; i++) {
      store.insert(`noise-${i}: what what what what what is is is is is this system status`, zero, Date.now());
    }
    for (let i = 0; i < 240; i++) store.insert(`filler-${i}: unrelated archival material`, zero, Date.now());
    store.insert('SOLVIS develops heating systems and thermal-energy technology.', zero, Date.now());
    store.flush();

    assert.strictEqual(store.bm25Search('what is solvis', 32).some((h) => /SOLVIS/i.test(h.text)), false);
    assert.strictEqual(store.bm25Search('what is solvis', 128).some((h) => /SOLVIS/i.test(h.text)), true);

    const hits = await recallQuery('what is solvis', 'default', cfg, 5);
    assert.strictEqual(hits[0].mode, 'hybrid-reranked');
    assert.match(hits[0].text, /SOLVIS/i);
    console.log('RECALL_PIPELINE_OK');
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
