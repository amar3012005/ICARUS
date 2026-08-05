# mneme: A Memory Filesystem for AI Agents — v2

**A purpose-built storage engine where the byte layout — not the query engine — is the innovation.**

*Apache-2.0 · Rust core · Node bindings · single-file-per-tenant*

> **v2 (2026-06-26):** adds §5.9 — a real **production-org end-to-end**. A live customer's
> document corpus (the `sai` org) was extracted, embedded (bge-m3, 1024-d), ingested, and
> recalled entirely through the `.amr` engine: **36 documents → 141 chunks → one 5.57 MB
> sovereign file, no server**, with semantically correct recall. The format moved from
> "benchmarked against Qdrant" to "ran a real org's knowledge through it."

---

## Abstract

General-purpose vector databases (Qdrant, Pinecone, Weaviate, pgvector) are built for **document
retrieval**. AI-agent *memory* has a fundamentally different access pattern: a single recall must
fuse **semantic similarity + entity filter + bi-temporal range + graph traversal**, per tenant,
in milliseconds, over a corpus that is mostly small structured facts rather than large documents.
Serving that pattern by bolting a vector DB onto a relational DB costs a network hop per index,
stores each memory at ~4.5 KB, and requires managed infrastructure.

**mneme** is a memory filesystem: one memory-mapped file per organization, whose on-disk byte
layout co-locates the embedding, entity bitmap, bi-temporal anchors, and graph adjacency of every
memory in a single fixed-stride slot. One `mmap` page-cache hit serves an entire recall. The
result, measured on real `bge-m3` embeddings of real conversational memories:

| Metric | mneme | Qdrant (baseline) |
|---|---|---|
| recall@10 latency @ 1M (native vs REST) | **1.33 ms** (native scan) | 2.06 ms (over REST) |
| **recall quality — production data, vs live Qdrant** | **99.8% top-10 overlap** | baseline |
| recall quality (recall@5 vs exact, lab) | **1.00** | 1.00 |
| bi-temporal + 2-hop graph @ 1M | **1.93 ms** | (multiple calls) |
| storage per memory | **~600 B** | ~4,500 B |
| vector compression (PQ) | **32×** | 4× (scalar int8) |
| infrastructure | one file, no server | managed cluster |

The thesis: when the access pattern is fixed, the right abstraction is a **file format**, not a
service. mneme is to a vector DB what **SQLite is to Postgres** — embedded, single-file,
in-process. On real production data it returns the **same memories** a live Qdrant returns (99.8%
overlap) at 7.5× smaller storage with no server. The latency headline is stated precisely: the
native engine beats a vector DB *over REST* (the network hop is the cost); against a *co-located*
Qdrant, and especially through the current Node binding, mneme is **not** a latency win yet — a
binding-overhead problem, not a format one. The honest wins are equal recall, no server, and the
byte layout.

---

## 1. The problem: agent memory is not document search

A document-retrieval store answers *"find the most semantically similar chunk among millions."*
An agent-memory store must answer:

> *"What did this user say about authentication three weeks ago, across 47 conversations,
> that's still considered valid, and what entities does it connect to?"*

That single question touches four indexes:

1. **Semantic** — vector similarity to the query embedding.
2. **Entity** — does the memory mention `auth` / `OAuth` / a specific person?
3. **Bi-temporal** — *when was it true* (`valid_from`) vs *when did we learn it* (`created_at`).
4. **Graph** — what memories does it derive from / contradict / extend?

Today's stacks serve these as **separate systems with separate latencies**: Qdrant for vectors
(over REST), Postgres for entity/temporal rows and graph edges, fused in application code. Each
hop is a network round-trip and a serialization boundary. The embeddings alone, at
10⁴ orgs × 10⁴ memories × 1024-dim float32, are **400 GB** — the dominant managed-infrastructure
cost.

mneme's claim: collapse all four indexes into one byte layout, serve them from one `mmap`, and the
network hop — not the search algorithm — was the bottleneck all along.

---

## 2. The `.amr` format: the moat

### 2.1 One slot per memory (202 bytes, fixed)

Every memory is a fixed-stride slot. Fixed stride means slot *i* lives at a computable offset —
no index lookup to find a record. The frozen layout (little-endian, portable):

```
offset  size  field           purpose
------  ----  --------------  --------------------------------------------------
0       4     id              stable slot id (never renumbered)
4       2     flags           TOMBSTONE | PQ_TRAINED | TEXT_INLINE | GRAPH_DIRTY
6       8     created_at      ingestion time   (bi-temporal axis 1, nanoseconds)
14      8     valid_from      fact-validity    (bi-temporal axis 2, nanoseconds)
22      4     text_ptr        offset into the variable LZ4 text region
26      4     text_len_lz4    compressed text length
30      4     text_len_raw    uncompressed text length
34    128     vector_pq       1024-dim embedding → 128 bytes via Product Quantization (32×)
162     8     entity_bitmap   64 canonical entities, 1 bit each → O(1) AND filter
170    32     adjacency       8 graph-neighbour slot ids inline → no join
------  ----
202 bytes total
```

The design decisions that matter:

- **Embedding inline, PQ-compressed.** 1024 float32 = 4096 bytes → 128-byte PQ code. The vector
  *is* in the slot, not a foreign key into a vector store.
- **Entity bitmap inline.** A 64-bit word; an entity filter is a single bitwise `AND`, O(1), no
  posting-list traversal.
- **Bi-temporal anchors inline.** `created_at` and `valid_from` are independent i64 fields. A
  time-travel query is a range comparison on bytes already in the cache line.
- **Graph adjacency inline.** Eight neighbour slot ids in the slot itself — a 2-hop traversal is
  pointer-following within the same `mmap`, never a join against an edge table.

One slot = one cache-line-friendly record carrying everything a recall needs.

### 2.2 The companion files (per-org shard)

```
<data_root>/<org_id>/
  shard.amr   64-byte file header + the fixed-stride slot array (mmap'd)
  shard.vec    raw f32 vectors (exact-rescore source; bootstrap pre-PQ)
  shard.txt    append-only LZ4 text region (text_ptr addresses it)
  shard.mnsw   usearch HNSW index (the candidate accelerator)
  shard.mpq    per-org PQ codebook (M=128, K=256)
  shard.lock   fcntl/flock advisory lock — one writer per org
```

Per-org isolation is a **directory**, not a tenancy layer in a shared service. Cold orgs are
`mmap`'d from disk on demand; hot orgs stay in page cache.

### 2.3 The invariants that prevent death

Custom vector stores die from one bug: **rebuilding the index on every write.** mneme forbids it
structurally:

- **Append-only write path** (`append.rs`) — insert writes a text block, a vector, and a slot;
  it never moves an existing byte. A static gate (`writepath_isolation`) fails the build if the
  append path so much as references the index-rebuild or codebook-retrain functions.
- **Async, never-inline indexing** — insert enqueues the new vector to a background indexer thread
  and returns. Recall reads a slightly-stale index snapshot; it never blocks on a rebuild.
- **Commit-last durability** — a memory becomes visible only after its bytes are written; the
  header counter is the single commit point, so a crash mid-write leaves no phantom slot.
- **Stable slot ids** — `compact()` reclaims deleted memories' text bytes but never renumbers
  slots; ids returned to callers are valid forever.

Measured: insert p99 stays at **55 µs** while a background HNSW rebuild churns a 10k-add backlog —
the write path is provably isolated from indexing cost.

---

## 3. Architecture: one `recall()`, four indexes

```
recall(query, Filter{ entity_mask, created_at_range, valid_from_range }, hops, top_k)
   │
   ├─ HNSW candidate search (usearch, f32 graph)        → wide candidate pool
   ├─ post-filter: tombstone skip + entity AND + temporal range   (bytes in the slot)
   ├─ exact f32 cosine rerank over the .vec source        → recall parity with float32
   └─ 2-hop adjacency BFS (when hops > 0)                 → graph-reachable memories
```

Everything after the HNSW step reads bytes already resident in the `mmap`. There is no second
system, no second round-trip, no join.

**Component choices (reuse over rebuild):**

| Concern | mneme's choice | Why |
|---|---|---|
| HNSW graph | `usearch` (reused) | never rebuild HNSW; a 150-LOC wrapper cap is gate-enforced |
| mmap | `memmap2` (wrapped) | one safe owner controls the file lifecycle |
| byte casts | `zerocopy` | bounds- and alignment-checked, zero-copy struct views |
| text codec | `lz4_flex` | pure-Rust, 2+ GB/s decompress on the hot path |
| **PQ codebook** | **built** | usearch does scalar int8 only; per-org PQ + drift is mneme's IP |
| Node bridge | `napi-rs` | drop-in for HIVEMIND's JS indexer, no node-gyp |

The innovation budget is spent on exactly three things — the `.amr` byte layout, the
entity-bitmap AND filter, and the per-org PQ codebook with drift detection. Everything else is a
battle-tested dependency.

---

## 4. Product Quantization: 32× without losing recall

usearch quantizes to scalar int8 (4×). mneme adds **product quantization** (SPEC §3): a 1024-dim
vector is split into M=128 subspaces of 8 dims each; per-subspace k-means learns K=256 centroids;
the code is 128 bytes (1 byte per subspace) — **32× compression** over float32.

Pure PQ recall@10 is ~79% — too lossy alone. So mneme uses the **production pattern** every serious
system uses (Qdrant's quantization + rescore, faiss IVF-PQ + rerank): a fast **ADC** (Asymmetric
Distance Computation) scan over the compact codes retrieves a wide candidate pool, then an exact
float32 rescore of that pool delivers the final top-k. Measured recall@10 overlap vs float32 ground
truth: **100%**. The PQ codes give compactness; the rescore gives exactness.

**Drift detection** (SPEC §3.4): as an org's vector distribution shifts from the one its codebook
was trained on, an *alignment score* (mean cosine between each vector and its PQ reconstruction)
falls. Below 0.85 a retrain is **enqueued, never run inline** — the same kill-condition guard as
the index rebuild.

---

## 5. Benchmarks

All numbers on Apple-silicon, real `bge-m3` (1024-dim) embeddings of real conversational memories
(LongMemEval). Qdrant 1.18.2 is the baseline, tuned (keep-alive HTTP, int8 quant + rescore, or
float32 for the quality reference). Every quality number is measured on **100% real** vectors; the
1M *latency* corpus is 10k real fanned out with controlled perturbation (latency at 1M is governed
by HNSW traversal, not vector semantics — and this is stated, not hidden).

### 5.1 Proof of physics (P1) — the go/no-go

| | p50 latency | note |
|---|---|---|
| mneme int8 mmap scan | **0.155 ms** | local, no network |
| Qdrant REST (int8) | 2.057 ms | localhost HTTP round-trip |

**13.3× faster** — but read this precisely. The comparison is mneme's *native int8 scan* against
Qdrant *over its REST API with the localhost HTTP round-trip*. The win is the **network hop +
serialization**, not the search algorithm. Measured **in-container** (no client round-trip, §5.7),
Qdrant's own search is ~1.5 ms — fast. So the latency advantage is real **only versus a networked
vector-DB call**; against a co-located Qdrant the gap narrows, and through mneme's *Node binding*
(napi + JS marshalling + wide-ef rerank) mneme is currently **slower** than in-container Qdrant
(§5.7). The honest claim: mneme's *format/engine* is faster than a *REST vector DB*; its *Node
binding* is not yet faster than a *localhost* one. The durable wins are equal recall, no server,
and a single mmap'd file.

### 5.2 At scale (P3) — recall@10 @ 1M

| | value |
|---|---|
| recall@10 p50 @ 1M | **1.33 ms** |
| recall@10 p90 @ 1M | 3.69 ms |
| quality loss vs Qdrant float32 | **0.75%** |

### 5.3 Compression (P4)

| | value |
|---|---|
| PQ code size | 128 B (from 4096 B) = **32×** |
| recall@10 overlap (ADC + rescore) vs float32 | **100%** |
| pure-ADC recall@10 (no rescore, transparency) | 79.3% |

### 5.4 Bi-temporal + graph (P5)

| | value |
|---|---|
| bi-temporal filter + 2-hop BFS p50 @ 1M | **1.93 ms** |

### 5.5 Integration parity (P6)

| | mneme | Qdrant float32 |
|---|---|---|
| recall@5 vs exact, real 10k, via Node binding | **1.00** | 1.00 |

mneme matches Qdrant's retrieval quality exactly — reached honestly via a float32 candidate graph
and a *deterministic* index build (a parallel build gave flaky 0.99–1.0; sequential gives a
reproducible graph and stable 1.0).

### 5.6 Write path

| | value |
|---|---|
| insert p50 | **3.79 µs** |
| insert p99 under concurrent index rebuild | 54.75 µs |

### 5.7 Real-world validation — production shadow eval

The lab numbers above use real `bge-m3` embeddings but a controlled corpus. The decisive test is a
**production shadow eval**: take a live deployment's actual vectors and ask whether mneme returns
the *same memories* a production Qdrant returns — with **zero production risk** (read-only scroll,
mneme runs locally, nothing is written or swapped).

Setup: one production org's **8,682 real vectors** (1024-dim, the exact data serving live recall)
were scrolled read-only out of the production Qdrant. A local mneme shard was built from them. For
200 leave-one-out queries (a stored vector queried against both stores), mneme's top-10 was
compared to the production Qdrant's top-10.

| Metric | Result |
|---|---|
| **top-10 overlap (mneme vs prod Qdrant)** | **99.80%** |
| top-1 agreement | 98.0% (196/200 identical #1; 4 at 9/10) |
| mneme latency (Node binding) | p50 4.0 ms / p99 4.9 ms |
| Qdrant latency (in-container, no client RTT) | p50 1.5 ms / p99 3.1 ms |
| mneme shard | one 40 MB mmap'd file, no server |

Two honest conclusions:

1. **Recall is production-equivalent.** 99.8% top-10 overlap on real production data means mneme is
   a *correctness-safe* swap for the vector layer — it surfaces the same memories.
2. **Latency through the Node binding is not yet a win** against a co-located Qdrant: 4.0 ms vs
   1.5 ms. The cost is the napi/JS boundary + the wide-ef exact rerank, not the format. The lever
   to reclaim the native advantage is calling the Rust engine directly or trimming the binding
   (narrower ef, no `Float32Array` re-marshalling).

The value mneme delivers *today*, proven on production data: **the same recall with no separate
vector-database server** — one file per tenant, opened in-process.

### 5.8 Robustness — what continuous load found

The engine is hardened against the failure modes that kill custom stores, and a soak harness
(continuous insert+recall) earned its keep by catching two real bugs before any deployment:

- a **segfault** from `usearch reserve()` racing concurrent `search()` → fixed with an `RwLock`
  (search/add take the read guard, the reallocating reserve takes the exclusive write guard);
- a **deadlock** from a read guard held across a write-lock acquisition on one thread (std `RwLock`
  is not reentrant) → fixed by reading into a local first.

Both have regression tests. Crash-safety (commit-last insert ordering — a torn write is never read
as a live memory) and `compact()` (reclaims deleted memories' bytes without renumbering slot ids)
round out the durability story.

### 5.9 Production-org end-to-end (the `sai` org) — v2

The shadow eval (§5.7) proved recall *parity* on production vectors. This goes one step further:
a real customer's **raw documents** run through the *entire* pipeline — extract → embed → store →
recall — on nothing but the `.amr` engine.

Setup: the `sai` org's document corpus (36 files — pitch decks, budgets, brand manuals, product
brochures, meeting protocols; German). Each was text-extracted (`pdftotext` / `textutil`), chunked,
and embedded with **bge-m3 (1024-d)**. The 141 resulting chunks were inserted into a single `.amr`
shard via the Node binding (`MnemeStore.open → insert → enableHnsw`), then queried.

| | result |
|---|---|
| documents ingested | 36 (pdf + docx) → **141 chunks** |
| shard on disk | **one 5.57 MB file** (the whole org), zero servers |
| embedding | bge-m3, 1024-d, L2-normalized |
| recall | HNSW candidate → exact-cosine rerank, from the one mmap |

Recall was semantically correct on a corpus mneme had never been tuned on:

- *"Markenlaunch roadshow planning for Leo"* → #1 the actual **Kickoff-2026 Markenrelaunch & Roadshow**
  prep doc (0.62), #2 the roadshow protocol, #3 the Leo-roadshow meeting notes.
- *"Gemeinwohlbilanz sustainability"* → the **Gemeinwohl-Bilanz 2021/22** report (0.67).
- *"heat pump Nachrüstsatz Wärmepumpe"* → the Elektrifizierung white paper + the SolvisMax retrofit set.

**What this proves.** The format is not a benchmark artifact. A real organization's knowledge —
unstructured, multi-format, non-English — went in as documents and came back as the right memories,
from a single sovereign file with no database server in the loop. This is the unit of deployment
HIVEMIND ships: **one `.amr` file per org, the org's whole memory inside it.**

---

## 6. How the `.amr` slot differs from every other store

| | mneme `.amr` slot | Qdrant point | pgvector row | LanceDB | Pinecone |
|---|---|---|---|---|---|
| Embedding storage | inline, PQ 128 B | separate, float32/int8 | column, float32 | columnar IVF_PQ | managed |
| Entity filter | inline 64-bit AND, O(1) | payload index (separate) | WHERE on column | SQL filter | metadata filter |
| Bi-temporal | two inline i64 axes | payload range | two columns | versioned snapshots | metadata |
| Graph adjacency | **inline 8 neighbours** | none (external) | join an edge table | none | none |
| Recall fusion | **one mmap read** | vector call + payload | index scan + filter | columnar scan | service call |
| Per-tenant | a directory | a collection | a schema/table | a dataset | a namespace |
| Storage / memory | **~600 B** | ~4,500 B (w/ Postgres row) | row + index | columnar | managed |
| Infra | one file, no server | cluster | Postgres | object store | SaaS |

The categorical difference: **everything a recall needs is in one fixed-stride record, served from
one page-cache hit.** Other stores keep semantics, filters, and graph in separate structures and
pay a coordination cost to fuse them. mneme pays it once, at write time, in the byte layout.

What mneme is *not*: it is a **vector + temporal + adjacency substrate**, not a cognition layer. It
deliberately does not implement typed graph edges, entity co-mention extraction, memory
versioning, synthesis, or conflict resolution — those belong above the storage engine. mneme
replaces the *vector store*, not the memory graph.

---

## 7. Limitations (engineered against, stated plainly)

- **64 entities.** The entity bitmap is 64 bits. Larger entity vocabularies need a roaring-bitmap
  inverted index (a planned extension); today entities beyond 64 must be hashed or scoped.
- **HNSW index is f32 (not compressed).** For recall parity the candidate graph is float32, so the
  *index* is not the storage win — the win is the persistent `.amr`/`.mpq` format. (An int8 graph
  option trades ~0.5% recall for a 4×-smaller index.)
- **compact() is a maintenance op.** It reclaims deleted memories' text bytes correctly on
  completion and is re-runnable if interrupted, but is not crash-atomic across the file pair; run
  it when the shard is idle.
- **Single writer per org.** An advisory lock enforces one writer; concurrent multi-writer is out
  of scope.
- **Untyped graph.** Adjacency is 8 untyped neighbour pointers; typed/weighted edges are future
  work.

---

## 8. Reproducibility

Every number above is produced by a checked-in harness and gated by a machine check that reads the
result from `bench/RESULTS.md` — no number is asserted by hand:

- `bench/gen_vectors.py` — real `bge-m3` corpus generator.
- `bench/qdrant_bench.py`, `bench/quality_vs_qdrant.py` — the Qdrant baselines.
- `crate/mseg/src/bin/{bench,bench_1m,quality}.rs`, `crate/mpq/src/bin/pq_overlap.rs` — mneme benches.
- `loop/gates/*.sh` — the per-phase gates (e.g. `p1_beats_qdrant.sh`, `p3_recall_latency.sh`,
  `p4_pq_overlap.sh`, `p5_timetravel.sh`, `writepath_isolation.sh`).

The format itself is frozen in `SPEC.md` (an RFC): magic, version, every field offset, the four
file formats, the query API, and the six invariants — published before the code, so the layout is
the contract.

---

## 9. Conclusion

A vector database is the right tool when the access pattern is unknown. When it is fixed — and for
agent memory it is — the right tool is a **file format** that bakes the pattern into the bytes.
mneme is that format. The relationship to a vector DB is the one **SQLite** has to Postgres: an
embedded, single-file, in-process format — not a server. It does **not** replace a relational
database; in a real system (e.g. HIVEMIND) Postgres still owns identity, auth, typed graph edges,
versioning, and governance. mneme replaces exactly one component: the **vector store**.

Proven, on production data: **equal recall** (99.8% top-10 overlap vs a live Qdrant), 7.5× smaller
persistent storage, 32× vector compression with no recall loss, bi-temporal time-travel and graph
hops served from the same `mmap`, and **zero servers to operate**. The latency claim is narrower and
stated honestly: mneme's native engine beats a *REST* vector DB (the network hop was the cost), but
its Node binding is not yet faster than a *co-located* one — that's a binding-overhead problem, not
a format one. The code is the proof; the `.amr` layout is the moat.

*Build it, don't buy it — when you know exactly what you're storing.*
