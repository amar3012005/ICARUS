# mneme-node

Node binding for **mneme** — a memory filesystem for AI agents. Per-tenant `mmap`'d vector +
temporal + graph store in the `.amr` format. Drop-in for Qdrant's vector layer. 13× faster than a
REST vector DB at equal recall, 7.5× smaller storage, zero servers.

```js
const { MnemeVectorStore } = require('mneme-node'); // drop-in for QdrantVectorStore
const store = new MnemeVectorStore({ dataRoot: '~/.mneme/data', dim: 1024 });
await store.upsert('org_acme', [{ id: 'm1', vector: emb, payload: { kind: 'pref' } }]);
const hits = await store.search('org_acme', queryEmb, 5); // [{ id, score, payload }]
```

CLI:

```bash
npx mneme ingest <dir> --org acme
npx mneme recall "your question" --org acme
```

Full docs, design thesis, benchmarks, and the `.amr` format spec:
**https://github.com/amar3012005/mneme**

Apache-2.0.
