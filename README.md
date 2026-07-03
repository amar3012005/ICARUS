<div align="center">

# ICARUS

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
curl -fsSL https://raw.githubusercontent.com/amar3012005/mneme/main/install.sh | bash
```

Installs the toolchain if missing, builds the native addon, installs the `mneme` CLI to `~/.mneme`,
and (optionally) connects your HIVEMIND account. Manual build:

```bash
git clone https://github.com/amar3012005/mneme
cd mneme/crate/mneme-node && npm install && npx napi build --release
```

## Quickstart (Node)

```js
const { MnemeVectorStore } = require('mneme-node'); // drop-in for QdrantVectorStore

const store = new MnemeVectorStore({ dataRoot: '~/.mneme/data', dim: 1024 });
await store.upsert('org_acme', [
  { id: 'm1', vector: embed('user prefers dark mode'), payload: { kind: 'preference' } },
]);
const hits = await store.search('org_acme', embed('ui settings'), 5); // [{ id, score, payload }]
```

Low-level engine:

```js
const { MnemeStore } = require('mneme-node');
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

## Production hardening (P8 — July 2026)

Running ICARUS as the live memory store behind a long-lived Node service surfaced one
architectural rule: **nothing above the engine may hold the shard resident.** The initial
Node integration cached every record parsed in a JS Map — ~1–2 KB of V8 heap per memory,
an OOM wall around ~1M records. P8 moved that state down into the engine:

- **Native id index** — `findById(id)` resolves a record's JSON id to its live slot from a
  Rust-side hash index (~24 B/record, built by one mmap scan at `open()`, collision-safe via
  exact text verification). No JS-side id map needed, ever.
- **`rewriteText(slot, text)`** — repoints a live slot at a newly appended text block while
  keeping its vector, layer, temporal anchors and edges. This is the durability primitive for
  metadata-only mutations (tags, recall reinforcement, supersession flags baked into the
  record JSON). Append-only is preserved; dead bytes are reclaimed by `compact()`.
- **`recordsPage(fromSlot, limit)`** — streaming scan so list/lexical/analytics consumers
  work in bounded pages instead of materializing the shard.
- **`slotText(slot)`** — single-record point read.

Measured with the streaming Node store at 1M records: flat process RSS during seeding
(hundreds of MB, dominated by the vector index — not per-record JS objects), point reads and
metadata rewrites in microsecond–millisecond range. See THESIS.md for the engine benchmarks.

**Known ceilings, stated honestly:** the HNSW overlay (usearch) holds f32 vectors in RAM —
at 10M+ records switch to the PQ codebook path (32× compression, `mpq` crate) or shard per
tenant; the reference lexical scorer is an O(N) streaming scan — fine to ~1M, pair with an
external FTS beyond that.

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
