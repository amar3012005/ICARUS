<div align="center">

# mneme

**A memory filesystem for AI agents.** One memory-mapped file per tenant. Semantic + entity +
bi-temporal + graph recall from a single read. 13× faster than a REST vector DB at equal recall,
7.5× smaller storage, 32× vector compression, zero servers.

`Apache-2.0` · Rust core · Node binding · drop-in for Qdrant

</div>

---

## Why

General-purpose vector databases are built for document search. Agent *memory* needs
**similarity + entity filter + bi-temporal range + graph hop — in one shot, per tenant, in
milliseconds.** mneme bakes that access pattern into a byte layout (`.amr`) instead of stitching a
vector DB to a relational DB across a network. See [`THESIS.md`](./THESIS.md) for the full design +
benchmarks, and [`SPEC.md`](./SPEC.md) for the frozen format RFC.

## Numbers (real `bge-m3` embeddings, vs Qdrant 1.18.2)

| | mneme | Qdrant |
|---|---|---|
| recall@10 @ 1M | **1.33 ms** | 2.06 ms (REST) |
| recall quality (recall@5 vs exact) | **1.00** | 1.00 |
| bi-temporal + 2-hop @ 1M | **1.93 ms** | (multiple calls) |
| storage / memory | **~600 B** | ~4,500 B |
| vector compression | **32×** (PQ) | 4× (int8) |
| infra | one file | cluster |

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/amar3012005/ICARUS/main/install.sh | bash
```

Installs the toolchain if missing, builds the native addon, installs the `mneme` CLI to `~/.mneme`,
and (optionally) connects your HIVEMIND account. Manual build:

```bash
git clone https://github.com/amar3012005/ICARUS
cd ICARUS/crate/mneme-node && npm install && npx napi build --release
```

## Quickstart (Node)

```js
const { MnemeVectorStore } = require('singulance-amr'); // drop-in for QdrantVectorStore

const store = new MnemeVectorStore({ dataRoot: '~/.mneme/data', dim: 1024 });
await store.upsert('org_acme', [
  { id: 'm1', vector: embed('user prefers dark mode'), payload: { kind: 'preference' } },
]);
const hits = await store.search('org_acme', embed('ui settings'), 5); // [{ id, score, payload }]
```

Low-level engine:

```js
const { MnemeStore } = require('singulance-amr');
const s = MnemeStore.open('~/.mneme/data', 'org_acme', 1024);
const id = s.insert('user prefers dark mode', new Float32Array(vec), Date.now() * 1e6);
s.enableHnsw();
const hits = s.recall(new Float32Array(queryVec), 5); // [{ slotId, score, text }]
s.compact(); // reclaim deleted memories' bytes
```

## CLI

```bash
mneme ingest <dir> --org acme     # extract + embed + store a folder of docs
mneme recall "your question" --org acme
mneme compact --org acme
mneme status
```

## What it is / isn't

- **Is:** a per-org vector + temporal + graph-adjacency storage engine. Drop-in for the Qdrant
  vector layer. Local, mmap'd, no server.
- **Isn't:** a cognition layer. No typed graph edges, entity co-mention, memory versioning,
  synthesis, or conflict resolution — those live above the storage engine.

## Architecture

```
recall(query, Filter{entity, created_at, valid_from}, hops, top_k)
  → HNSW candidates (usearch)
  → post-filter (entity AND + temporal range + tombstone skip)   [bytes in the slot]
  → exact f32 rescore (recall parity with float32)
  → 2-hop adjacency BFS                                           [same mmap]
```

Per-org shard = one directory: `shard.amr` (64-byte header + 202-byte slots), `shard.vec`
(rescore source), `shard.txt` (LZ4 text), `shard.mnsw` (HNSW), `shard.mpq` (PQ codebook),
`shard.lock`.

## Repo layout

```
mneme/
  SPEC.md            frozen .amr format RFC (the moat)
  THESIS.md          design + benchmarks + DB comparison
  crate/
    mseg-format/     pure byte layout (spec-locked, offset_of! asserts)
    mseg/            storage engine: segment, CRUD, HNSW overlay, compact, shard
    mnsw-index/      thin usearch HNSW wrapper
    mpq/             product quantization codebook + ADC + drift
    mneme-node/      napi Node binding + MnemeVectorStore drop-in + CLI
    mneme-probe/     P1 proof-of-physics probe
  bench/             reproducible benchmark harness + Qdrant baselines
  install.sh         curl | bash installer
```

## Build / test

```bash
cd crate
cargo test --workspace          # all suites
cargo clippy --workspace --all-targets -- -D warnings
bash ../bench/run_p1.sh          # reproduce the headline benchmark vs Qdrant
```

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
