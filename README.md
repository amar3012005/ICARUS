<div align="center">

# ICARUS

**A memory filesystem for AI agents.** One memory-mapped file per tenant. Semantic + entity +
bi-temporal + graph recall from a single read. 13× faster than a REST vector DB at equal recall,
7.5× smaller storage, 32× vector compression, zero servers.

`Apache-2.0` · Rust core (internal engine name: `mneme`) · Node + Python bindings · drop-in for Qdrant

[![npm](https://img.shields.io/npm/v/singulance-amr?label=npm)](https://www.npmjs.com/package/singulance-amr)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)

</div>

---

## Zero to agent memory, right now

```bash
curl -fsSL https://raw.githubusercontent.com/amar3012005/ICARUS/main/install.sh | bash
```

Optional — auto-registers ICARUS as an MCP server in every coding agent found on this machine
(Claude Code, Codex, Cursor):

```bash
icarus mcp install
```

Node — real, published on npm, works today:

```bash
npm install singulance-amr
```

Python: **not on PyPI yet** (`pip install mneme-python` doesn't work — checked live, no release
exists under that name; the automated publish is blocked on an unrelated GitHub Actions billing
issue, see [`LIMITATIONS.md`](./LIMITATIONS.md)). Build from source with
[maturin](https://www.maturin.rs/) — real, verified-working, three commands:
[`crate/mneme-python/README.md`](./crate/mneme-python/README.md#install).

**[`examples/demo-60s.mjs`](./examples/demo-60s.mjs)** — the whole API, zero setup, zero API key,
runs in under a second:

```bash
node examples/demo-60s.mjs
```
```
1. Open a shard — one memory-mapped file, no server, no account.
2. Ingest a few memories.
3. Recall by similarity.
   [0.530] the user prefers dark mode in every app
Done in 50ms.
```

Real numbers, real methodology, real limitations — not just this README's word for it:
[`BENCHMARKS.md`](./BENCHMARKS.md) · [`LIMITATIONS.md`](./LIMITATIONS.md) ·
[`THESIS.md`](./THESIS.md) (full design) · [`SPEC.md`](./SPEC.md) (frozen format RFC)

## Why

General-purpose vector databases are built for document search. Agent *memory* needs
**similarity + entity filter + bi-temporal range + graph hop — in one shot, per tenant, in
milliseconds.** ICARUS bakes that access pattern into a byte layout (`.amr`) instead of stitching a
vector DB to a relational DB across a network.

## Numbers (real `bge-m3` embeddings, vs Qdrant 1.18.2)

| | ICARUS | Qdrant |
|---|---|---|
| recall@10 @ 1M | **1.33 ms** | 2.06 ms (REST) |
| recall quality (recall@5 vs exact) | **1.00** | 1.00 |
| bi-temporal + 2-hop @ 1M | **1.93 ms** | (multiple calls) |
| storage / memory | **~600 B** | ~4,500 B |
| vector compression | **32×** (PQ) | 4× (int8) |
| infra | one file | cluster |

How these were produced, and how to reproduce them yourself: [`BENCHMARKS.md`](./BENCHMARKS.md).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/amar3012005/ICARUS/main/install.sh | bash
```

On linux-x64/darwin-arm64 this downloads one self-contained binary — no Node/Rust/npm needed on
the target machine. Everywhere else it falls back to: checks the toolchain, builds the native
addon, installs the `icarus` CLI to `~/.icarus`, and (optionally) connects your HIVEMIND account.
Manual build:

```bash
git clone https://github.com/amar3012005/ICARUS
cd ICARUS/crate/mneme-node && npm install && npx napi build --release
```

## Quickstart (Node)

```js
const { MnemeVectorStore } = require('singulance-amr'); // drop-in for QdrantVectorStore

const store = new MnemeVectorStore({ dataRoot: '~/.icarus/data', dim: 1024 });
await store.upsert('org_acme', [
  { id: 'm1', vector: embed('user prefers dark mode'), payload: { kind: 'preference' } },
]);
const hits = await store.search('org_acme', embed('ui settings'), 5); // [{ id, score, payload }]
```

Low-level engine:

```js
const { MnemeStore } = require('singulance-amr');
const s = MnemeStore.open('~/.icarus/data', 'org_acme', 1024);
const id = s.insert('user prefers dark mode', new Float32Array(vec), Date.now() * 1e6);
s.enableHnsw();
const hits = s.recall(new Float32Array(queryVec), 5); // [{ slotId, score, text }]
s.compact(); // reclaim deleted memories' bytes
```

## CLI

```bash
icarus ingest <dir> --org acme
icarus recall "your question" --org acme
icarus compact --org acme
icarus status
```

`icarus ingest` extracts, embeds, and stores every text/markdown/json/csv/log file under `<dir>`.

## Quickstart (Python)

Same engine, same on-disk format, same behavior as the Node binding — one Rust core, two
language bindings, not two implementations.

Not on PyPI yet — build from source ([real, verified steps](./crate/mneme-python/README.md#install)):

```bash
git clone https://github.com/amar3012005/ICARUS && cd ICARUS/crate/mneme-python
pip install maturin && maturin develop --release
```

```python
from mneme_python import MnemeStore

store = MnemeStore("/path/to/data", "org_acme", dim=1024)
store.insert("user prefers dark mode", embed("user prefers dark mode"), valid_from=0)
hits = store.recall(embed("ui settings"), top_k=5)  # [MnemeHit(slot_id, score, text), ...]
```

Full guide, layered recall, graph edges, and framework integrations:
[`crate/mneme-python/README.md`](./crate/mneme-python/README.md).

## Native BM25 lexical search

The engine's first lexical capability — real document-frequency/IDF statistics (standard Okapi
BM25), not a substring heuristic. One shared implementation (`mneme-bm25`) used identically by
both bindings, so scores are not just similar across languages, they are the same number for the
same corpus and query.

```js
// Node
const hits = store.bm25Search('warranty terms', 10);
```
```python
# Python
hits = store.bm25_search("warranty terms", top_k=10)
```

Only documents matching at least one query term are returned, ranked best-first. Language-neutral
tokenization (lowercase, Unicode-alphanumeric split — no stemming, no stopword list, the same
reasoning the rest of this engine uses to avoid per-language brittle logic). **Known
limitation**: results are not currently layer-filterable (0=memory/1=evidence/2=cognitive) — the
underlying `Hit` type doesn't surface a record's layer back out yet. A persistent postings index
for very large corpora is a natural follow-on, not part of this — this is real IDF-weighted
ranking over the existing corpus-wide scan.

## Framework integrations (Python)

Optional, lazy-imported adapters — neither is a dependency of the core binding.

After building from source above, `pip install langchain-core` / `pip install llama-index-core`
gets you each adapter — no separate build step, they're lazy-imported extras.

See [`crate/mneme-python/README.md`](./crate/mneme-python/README.md) for both, or run the
runnable examples directly (all three work with zero API key — see
[`examples/toy_embed.py`](./examples/toy_embed.py) for why, and `BENCHMARKS.md` for what a real
embedding model actually measures):

After building `mneme-python` from source above:

```bash
cd examples
pip install langchain-core llama-index-core
python langchain_example.py
python llamaindex_example.py
python minimal_agent_loop.py
```

`langchain_example.py` uses ICARUS as a LangChain `BaseRetriever`, `llamaindex_example.py` as a
LlamaIndex `VectorStore`, and `minimal_agent_loop.py` needs no framework at all — the smallest
possible recall-then-store agent loop.

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
SPEC.md              frozen .amr format RFC (the moat)
THESIS.md            full design + benchmarks + DB comparison
BENCHMARKS.md         how every number in this README was produced, and how to reproduce it
LIMITATIONS.md        every real gap, honestly, in one place
examples/            demo-60s.mjs, langchain/llamaindex/minimal-agent-loop, all runnable
crate/
  mseg-format/       pure byte layout (spec-locked, offset_of! asserts)
  mseg/              storage engine: segment, CRUD, HNSW overlay, compact, shard
  mnsw-index/        thin usearch HNSW wrapper
  mpq/               product quantization codebook + ADC + drift
  mneme-bm25/        pure BM25 scoring -- no Shard, no napi, no pyo3; shared by both bindings
  mneme-node/        napi Node binding + MnemeVectorStore drop-in + CLI + MCP server
  mneme-python/      pyo3 Python binding + LangChain/LlamaIndex integrations
  mneme-probe/       P1 proof-of-physics probe
bench/               reproducible benchmark harness + Qdrant baselines
install.sh           curl | bash installer
```

## Build / test

```bash
cd crate
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
bash ../bench/run_p1.sh

cd mneme-python
pip install maturin && maturin develop --release
pip install -e ".[test]" && pytest tests/ -v
```

`cargo test --workspace` runs all suites (`mneme-python`'s extension-module target is excluded
from plain cargo builds by design — see its own README). `bash ../bench/run_p1.sh` reproduces the
headline benchmark against Qdrant, on your own machine.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
