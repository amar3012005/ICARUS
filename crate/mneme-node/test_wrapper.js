// Smoke test for the MnemeVectorStore drop-in (P6-2).
const fs = require('fs');
const { MnemeVectorStore } = require('./index.js');

(async () => {
  const root = '/tmp/mneme-wrap-test-' + Date.now();
  const store = new MnemeVectorStore({ dataRoot: root, dim: 4 });
  await store.upsert('org_demo', [
    { id: 'doc-A', vector: [1, 0, 0, 0], payload: { title: 'Alpha' } },
    { id: 'doc-B', vector: [0, 1, 0, 0], payload: { title: 'Beta' } },
    { id: 'doc-C', vector: [0.9, 0.1, 0, 0], payload: { title: 'Almost-Alpha' } },
  ]);
  const res = await store.search('org_demo', [1, 0, 0, 0], 2);
  console.log('search:', JSON.stringify(res));
  const ok =
    res.length === 2 &&
    res[0].id === 'doc-A' &&
    res[0].payload.title === 'Alpha' &&
    res[1].id === 'doc-C';
  console.log(ok ? 'WRAPPER_OK' : 'WRAPPER_FAIL');
  process.exit(ok ? 0 : 1);
})();
