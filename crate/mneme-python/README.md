# mneme-python

Python binding for [mneme](https://github.com/amar3012005/ICARUS) — a memory filesystem for AI
agents: per-tenant mmap'd vector + temporal + graph store, plus native BM25 lexical search. Same
engine and on-disk format the Node binding (`singulance-amr`) wraps — one Rust core, two language
bindings, identical behavior and identical `.amr` files. Not a reimplementation.

## Install

**Not yet published to PyPI** — `pip install mneme-python` doesn't work today (checked live: no
release exists under that name). The automated release pipeline is blocked on an unrelated GitHub
Actions billing issue — see the main [`LIMITATIONS.md`](../../LIMITATIONS.md). Build from source
with [maturin](https://www.maturin.rs/) — this is the real, verified-working path:

```bash
git clone https://github.com/amar3012005/ICARUS
cd ICARUS/crate/mneme-python
pip install maturin
maturin develop --release
```

## Quickstart

The engine does not embed text itself — you provide the vectors (from whatever embedding model
you already use). This mirrors the Node binding's contract exactly.

```python
from mneme_python import MnemeStore

store = MnemeStore("/path/to/data", "my-org", dim=1024)

vec = my_embedding_model.embed("user prefers dark mode")
slot_id = store.insert("user prefers dark mode", vec, valid_from=0)

hits = store.recall(my_embedding_model.embed("ui settings"), top_k=5)
for h in hits:
    print(h.slot_id, h.score, h.text)
```

### Native BM25 lexical search

Real document-frequency/IDF statistics, not a substring heuristic — the same algorithm the Node
binding uses (both call the shared `mneme-bm25` crate, so scores are identical across languages).

```python
hits = store.bm25_search("warranty terms", top_k=10)
# [MnemeHit(slot_id=.., score=.., text=..), ...] -- best match first, non-matches absent
```

### PQ/ADC recall — an alternative to HNSW, not a universal upgrade

```python
store.train_pq(seed=42)       # one-time, blocks for its duration -- call after a bulk load
hits = store.recall_pq(query_vec, top_k=5)  # raises ValueError if train_pq() hasn't run
```

Real, measured tradeoff (bge-m3, see `mneme/bench/RESULTS.md`): at 10k vectors PQ beats
`enable_hnsw()` on both build time and query latency at equal recall; at 100k it still builds
~6x faster but queries ~3x slower at equal recall (PQ scans every live code at O(n) with a cheap
per-item cost; HNSW's near-O(log n) traversal wins once the shard grows). Good fit: shards you
rebuild often — dev/test, small orgs, frequently-retrained data. Measure your own shard size
before reaching for this over `enable_hnsw()` at real scale.

### Layers, graph edges, lifecycle

```python
# 0=memory, 1=evidence, 2=cognitive — one shard holds all three, filterable at recall time.
store.insert_layered("supporting evidence text", vec, valid_from=0, layer=1)
evidence_only = store.recall_layer(query_vec, top_k=5, layer=1)

store.add_edge(slot_a, slot_b, edge_type=1, weight=255)
reachable = store.traverse_typed(slot_a, edge_type=1, max_hops=2)

store.delete(slot_id)
store.flush()  # explicit durability point; the engine already flushes on write
print(store.live_count())
```

## Framework integrations

Optional, pure-Python adapters that import their framework lazily — neither is a hard dependency
of `mneme-python` itself.

### LangChain

Not on PyPI yet (see Install above) — after building from source, `pip install langchain-core`
alongside it gets you this adapter (it's a lazy-imported extra, no separate build step):

```python
from mneme_python import MnemeStore
from mneme_integrations.langchain import MnemeRetriever

store = MnemeStore("/path/to/data", "my-org", dim=1024)
retriever = MnemeRetriever(store=store, embed_query=my_embedding_model.embed, top_k=5)
docs = retriever.invoke("what's our warranty policy?")
```

### LlamaIndex

Same story — `pip install llama-index-core` after building from source:

```python
from mneme_python import MnemeStore
from mneme_integrations.llamaindex import MnemeVectorStore
from llama_index.core.schema import TextNode
from llama_index.core.vector_stores.types import VectorStoreQuery

vstore = MnemeVectorStore(mneme=MnemeStore("/path/to/data", "my-org", dim=1024))
vstore.add([TextNode(text="...", embedding=my_embedding_model.embed("..."))])
result = vstore.query(VectorStoreQuery(query_embedding=query_vec, similarity_top_k=5))
```

**Known limitation, stated rather than hidden**: `MnemeVectorStore.delete(ref_doc_id)` resolves
the LlamaIndex node id to a mneme slot id via an in-memory map built during `add()`. That map is
not persisted, so `delete` by `ref_doc_id` only works for nodes added in the current process —
deleting directly by slot id (`store.delete(slot_id)`) always works, since that is the engine's
own durable identifier.

## What this v0.1 covers, and what it does not

Open, insert (plain and layered), vector recall (plain and layer-filtered), native BM25 lexical
search, typed graph edges/traversal, and lifecycle (delete, flush, live_count). This is not full
parity with every method the Node binding exposes — temporal snapshot/rewrite operations
(`as_of`, `insert_at`, `update`) are not yet bound here.

`bm25_search` does not currently filter by layer: the underlying `Hit` type doesn't surface a
record's layer back out, so it scans every live slot regardless of the 0/1/2 layer
`insert_layered`/`recall_layer` use. Filter the returned `slot_id`s yourself if you need
layer-scoped lexical search.

## Testing

```bash
pip install -e ".[test]"
pytest tests/ -v
```

## License

Apache-2.0, same as the rest of the repository.
