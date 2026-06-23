# mneme — Global Execution Plan

> Purpose-built memory filesystem for AI agents. Rust core. Open source (Apache-2.0).
> Node bindings (napi-rs) to drop into HIVEMIND replacing Qdrant. Category-defining.

This is a **16-week milestone-gated program**. Time does not advance the project —
**verifiable artifacts** do. Every phase ends with ONE artifact (a number, a benchmark,
a binary, a passing test). If the artifact does not exist, the phase is not done.
No pivots. No scope expansion. Finish the whole thing, or it means nothing.

---

## The thesis (why this is not "another vector DB")

General-purpose vector databases (Qdrant, Pinecone, Weaviate) are built for **document
retrieval**. AI agent *memory* has a different access pattern:

> "semantic similarity **+** entity filter **+** bi-temporal range **+** 2-hop graph
> traversal — in one shot, under 5 ms, per-tenant isolated."

No existing open-source store serves that combination from a single read. mneme does,
because the **innovation is the byte layout**, not the query engine.

### The `.mseg` storage format (the moat)

Each memory is a fixed-size slot header + variable LZ4-compressed text:

```
slot header  (~194 bytes, fixed):
  id            u32        4B
  flags         u16        2B
  created_at    i64        8B     # ingestion time   (bi-temporal axis 1)
  valid_from    i64        8B     # when fact is true (bi-temporal axis 2)
  text_ptr      u32        4B     # offset into variable section
  vector_pq     [u8; 128]  128B   # 1024-dim float32 -> 128B via Product Quantization (32x)
  entity_bitmap u64        8B     # 64 canonical entities, 1 bit each -> O(1) filter
  adjacency     [u32; 8]   32B    # 8 nearest graph neighbours inline -> no join
```

One `mmap` page-cache hit serves an entire recall. ~600 bytes/memory average vs
~4,500 bytes today (Postgres row + Qdrant point + overhead) = **7.5x smaller**.

### Targets (proven vs aspirational — keep honest)

| Metric | Target | Status |
|---|---|---|
| Vector compression (PQ vs float32) | 32x | TARGET |
| Storage vs Postgres+Qdrant | 7.5x smaller | TARGET |
| recall@10 latency @ 1M memories | < 5 ms | TARGET |
| recall@10 quality vs Qdrant float32 | < 3% loss | TARGET |
| PQ recall@10 overlap vs float32 | > 96% | TARGET |

Nothing above is claimed until its phase gate proves it. Update Status to PROVEN
with the benchmark number when the gate passes.

---

## The rule that prevents death

Milestone gates, not time gates (this is how hard things actually ship). The vCPU
runs autonomously, but the **human reviews the artifact before unlocking the next
phase**. See `loop/PHASE_GATES.md` for the exact, machine-checkable exit gate per phase.

---

## Phases

### P0 — Spec first, code second *(Week 1)*
Write `SPEC.md`: the complete `.mseg` binary layout, `.mnsw` HNSW index format,
`.mpq` PQ codebook format, multi-tenant isolation scheme, and the query API surface
(`open`, `insert`, `recall(query, filter, hops)`, `compact`). **Freeze it.** No code
until the spec exists and is reviewed.

**Gate:** `SPEC.md` exists, covers all four formats + API, reviewed by human.

### P1 — Proof of physics *(Week 2)*
Rust probe binary: raw format + brute-force int8 cosine scan, no HNSW yet. Load
**real HIVEMIND memories** (synthetic proves nothing). Benchmark recall@10 latency
vs Qdrant REST on identical 10k / 100k / 1M datasets.

**Gate:** `bench/RESULTS.md` shows mneme linear scan beats Qdrant REST at N=10k.
This is the go/no-go for the whole project.

### P2 — Core library *(Weeks 3–4)*
Production Rust crate. Format fully implemented. CRUD complete. Tests written first.

**Gate:** `cargo test` 100% green, `cargo clippy -D warnings` clean, `cargo bench` baseline recorded.

### P3 — HNSW + entity bitmap *(Weeks 5–7)*
Reuse the `usearch` crate for HNSW (do not reimplement). HNSW graph in `.mnsw`,
memory-mapped alongside `.mseg`. Entity bitmap O(1) filter via bitwise AND.

**Gate:** recall@10 with entity filter < 5 ms at 1M memories, < 3% quality loss vs Qdrant float32.

### P4 — Product Quantization *(Weeks 8–9)*
Real PQ (M=8 subspaces, K=256 centroids). Per-org codebook trained on first 10k
memories. Centroid **drift detection** (alignment score < 0.85 → flag retrain).

**Gate:** recall@10 overlap > 96% vs float32 ground truth.

### P5 — Bi-temporal + graph hops *(Week 10)*
`created_at` + `valid_from` independent filters (time-travel recall without duplicate
memories). 2-hop adjacency BFS over mmap'd adjacency lists — no Postgres touch.

**Gate:** time-travel query returns correct memories across 1M slots in < 8 ms (integration test).

### P6 — Node bindings + HIVEMIND integration *(Weeks 11–12)*
`napi-rs` bindings → `mneme-node` npm package. Swap `QdrantVectorStore` for
`MnemeVectorStore` in `core/src/ingestion/indexer.js` (same interface). Run on a test org.

**Gate:** HIVEMIND eval-harness (14 golden cases) ≥ current Qdrant baseline; 72h soak clean; storage reduction measured (> 5x).

### P7 — Paper + open-source launch *(Weeks 13–16)*
arXiv paper (cs.DB + cs.IR). Design `xMEM` benchmark (5 orgs × 6 sizes × 4 query types
× 3 baselines: Qdrant, pgvector, LanceDB). GitHub public, HN launch, integration outreach
(Letta, Mem0, LangGraph). Paper written **incrementally** — each phase writes its section.

**Gate:** paper submitted to arXiv; repo public with reproducible benchmark.

---

## Kill conditions (engineer against these from day one)

| Kill cause | Prevention |
|---|---|
| Scope creep | Scope frozen at P0 `SPEC.md`. New ideas → `FUTURE.md`, never the current phase. |
| HNSW rebuild-on-write bottleneck | Separate append-only write path from async index rebuild. Recall stale by seconds, never broken. |
| PQ centroid drift (silent quality rot) | Auto-detect drift + background retrain. Gate at P4: recall@10 overlap < 93% = stop and fix. |
| No real users → invisible | HIVEMIND **is** the first user. P6 integration is mandatory, not optional. |
| No paper → invisible | Paper written incrementally, each phase its section. |
| Motivation dying at month 2 | P1 benchmark is the psychological proof point. Unimpressive there = something structurally wrong; fix at P1. |

---

## Naming

`mneme` — Greek goddess of memory and remembrance. Short, globally unique namespace,
technically accurate. The **file-format spec is the moat**; the code is the proof.
Publish the format as an RFC before the code ships.
