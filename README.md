# mneme

**A purpose-built memory filesystem for AI agents.** Rust core, Apache-2.0,
Node bindings (via [napi-rs](https://napi.rs)) that drop into HIVEMIND in place of
Qdrant. The innovation is a byte layout, not a query engine.

---

## Thesis

General-purpose vector databases — Qdrant, Pinecone, Weaviate, pgvector — are built
for **document retrieval**: one big similarity search over an opaque blob, with metadata
filtering bolted on through a separate index. AI-agent *memory* has a different access
pattern. A single recall needs, **at once**:

> semantic similarity **+** entity filter **+** bi-temporal range **+** 2-hop graph
> traversal — per-tenant isolated, in under 5 ms.

No open-source store serves that combination from one read, because in every existing
system those four capabilities live in four different data structures (HNSW graph,
payload index, timestamp column, edge table) that must be joined at query time. mneme
collocates all four into **one fixed-size slot per memory**, so a single `mmap`
page-cache hit answers the whole recall. The on-disk byte layout — the `.mseg` format —
is the moat. Everything else (HNSW, mmap plumbing, compression, the Node bridge) is a
reused, battle-tested open-source crate.

## The `.mseg` storage format

Each memory is a fixed ~194-byte slot header plus variable LZ4-compressed text. The
authoritative layout, endianness, alignment, and invariants live in
[`SPEC.md`](./SPEC.md) — the design intent:

```
slot header (~194 bytes, fixed, little-endian, repr(C)):
  id            u32        4B
  flags         u16        2B
  created_at    i64        8B     # ingestion time   (bi-temporal axis 1)
  valid_from    i64        8B     # when the fact is true (bi-temporal axis 2)
  text_ptr      u32        4B     # offset into the variable LZ4 region
  vector_pq     [u8; 128]  128B   # 1024-dim f32 -> 128B via per-org Product Quantization (32x)
  entity_bitmap u64        8B     # 64 canonical entities, 1 bit each -> O(1) AND filter
  adjacency     [u32; 8]   32B    # 8 nearest graph neighbours inline -> no join
+ variable region:               # LZ4-compressed text, addressed by text_ptr; decompressed
                                  # only for the winning rows after ANN, never whole-file
```

One read serves the entire recall: ANN over `vector_pq`, entity filter by bitwise-AND
on `entity_bitmap`, bi-temporal range over `created_at`/`valid_from`, and a 2-hop BFS
over `adjacency` — all from the same mapped shard.

## Headline targets — proven vs targeted

mneme is a milestone-gated build. **Nothing below is claimed as fact until its phase
gate produces the measured number.** This table mirrors `GLOBAL_PLAN.md`; both are
updated to PROVEN (with the git SHA of the benchmark) only when the gate passes.
As of this writing every row is a TARGET — no code has been benchmarked.

| Metric | Target | Status | Proven by |
|---|---|---|---|
| Vector compression (PQ vs f32) | 32x | TARGET | P4 gate (`BENCH.md`) |
| Storage vs Postgres row + Qdrant point | 7.5x smaller | TARGET | P6 gate |
| recall@10 latency @ 1M memories | < 5 ms | TARGET | P3 gate |
| recall@10 quality vs Qdrant f32 | < 3% loss | TARGET | P3 gate |
| PQ recall@10 overlap vs f32 | > 96% | TARGET | P4 gate |
| Beats Qdrant REST latency @ N=10k | yes | TARGET | P1 gate (go/no-go) |

If you are reading this and the table still says TARGET everywhere, mneme has not yet
proven its physics. Treat every number as a hypothesis.

## What is reused, what is built

The entire innovation budget is the `.mseg` byte layout. Three things — and only three —
are built net-new: the `.mseg` format reader/writer + CRUD, the entity-bitmap AND
filter, and the per-org PQ codebook + drift detection. Everything else is a dependency:

| Concern | Crate (reused) | Notes |
|---|---|---|
| HNSW graph index | [`usearch`](https://crates.io/crates/usearch) (Apache-2.0) | mandated for P3; do **not** hand-roll HNSW. Provides graph index + int8 scalar quant + mmap view + filter-during-traversal. |
| Memory-mapped IO | [`memmap2`](https://crates.io/crates/memmap2) | maps the `.mseg` file; wrapped in a thin safe owner. |
| Zero-copy struct casts | [`zerocopy`](https://crates.io/crates/zerocopy) | reads the fixed slot header off the mmap with no copy. |
| Text compression | [`lz4_flex`](https://crates.io/crates/lz4_flex) | pure-Rust LZ4 for the per-slot text blob; >2 GB/s decompress. |
| Node bridge | [`napi-rs`](https://crates.io/crates/napi) v3 (MIT) | mandated for P6; async `fn` -> JS Promise. No node-gyp / hand-rolled FFI. |
| Parallelism / bench / fuzz | `rayon` / `criterion` / `proptest` | parallel scans, gate benchmarks, format property tests. |

PQ is built (usearch does scalar i8, not product quantization);
[faiss](https://github.com/facebookresearch/faiss)'s `ProductQuantizer.h` and the PQ
paper (arXiv:2401.08281) are the *reference* for the math, ported into a small pure-Rust
module. Full open-source assessment and licensing audit:
[`reference/OPENSOURCE_RECON.md`](./reference/OPENSOURCE_RECON.md).

## Repo layout

```
mneme/
├── README.md              # you are here — pitch + orientation
├── GLOBAL_PLAN.md         # the 16-week, 8-phase (P0..P7) milestone program
├── SPEC.md                # frozen P0 byte-format RFC — single source of truth for .mseg
├── INSTRUCTIONS.md        # the production constitution the autonomous agent obeys, every iteration
├── FUTURE.md              # scope-freeze sink: every new idea goes here, never into the current phase
├── BENCH.md               # durable record of every measured number + the git SHA that produced it
├── crate/                 # the Rust core (.mseg format, CRUD, HNSW overlay, PQ) — built P2 onward
├── bench/                 # benchmark harnesses + RESULTS.md (P1 go/no-go lives here)
├── reference/             # OPENSOURCE_RECON.md and other read-only study material
└── loop/                  # the autonomous execution engine
    ├── LOOP_ENGINE.md     # how the two-tier phase-gate loop runs
    ├── PHASE_GATES.md     # the exact machine-checkable exit predicate per phase
    ├── PROGRESS.md        # living cursor — read at start of every iteration, written at end
    ├── STATE.json         # runaway + dedup state (phase, iter, max_iter, last_shipped_sha)
    └── prompts/           # iteration prompts driving the loop
```

## The 16-week program

Eight phases, each ending in **one verifiable artifact** — a number, a benchmark, or a
binary. Time does not advance the project; artifacts do. Full detail in
[`GLOBAL_PLAN.md`](./GLOBAL_PLAN.md); the literal pass/fail predicate per gate is in
[`loop/PHASE_GATES.md`](./loop/PHASE_GATES.md).

| Phase | Weeks | Artifact (the gate) |
|---|---|---|
| **P0** Spec first | 1 | frozen `SPEC.md` (all four formats + API + invariants), human-reviewed |
| **P1** Proof of physics | 2 | `bench/RESULTS.md`: brute-force int8 scan beats Qdrant REST @ N=10k on **real** HIVEMIND memories — go/no-go |
| **P2** Core library | 3–4 | `cargo test` 100% green, `cargo clippy -D warnings` clean, `cargo bench` baseline |
| **P3** HNSW + entity bitmap | 5–7 | recall@10 < 5 ms @ 1M with entity filter, < 3% quality loss vs Qdrant f32 |
| **P4** Product Quantization | 8–9 | recall@10 overlap > 96% vs f32 ground truth + codebook drift detection |
| **P5** Bi-temporal + graph hops | 10 | time-travel query correct across 1M slots in < 8 ms |
| **P6** Node bindings + integration | 11–12 | HIVEMIND eval-harness ≥ Qdrant baseline + 72h soak clean, swapping `core/src/ingestion/indexer.js` |
| **P7** Paper + launch | 13–16 | arXiv paper submitted + public repo with reproducible `xMEM` benchmark |

Two kill conditions are engineered against from day one: **HNSW rebuild-on-write**
(the append write-path is physically separate from async index rebuild — recall may be
stale by seconds, never broken) and **PQ centroid drift** (auto-detected, background
retrain enqueued, never run inline). See `GLOBAL_PLAN.md` § Kill conditions.

## How to run the loop

mneme is built by an autonomous Claude Code agent running unattended on a dedicated
vCPU. It is governed by [`INSTRUCTIONS.md`](./INSTRUCTIONS.md) — the production
constitution — and driven by the engine documented in
[`loop/LOOP_ENGINE.md`](./loop/LOOP_ENGINE.md).

```sh
# the loop reads loop/PROGRESS.md + loop/STATE.json, decomposes the current phase into
# work-units, and grinds each through: recon -> plan -> TDD -> gates -> commit.
# It rests only when STATE.json.phase == "P7" and P7's launch artifacts exist.

# inspect where the build is:
cat loop/PROGRESS.md          # current phase, task, next artifact
cat loop/STATE.json           # iter / max_iter / phases_done / last_shipped_sha
cat BENCH.md                  # every proven number so far, with its SHA

# halt the loop cleanly at the next checkpoint:
touch loop/PAUSE              # remove the file to resume
```

Once the Rust crate exists (P2+), the standard verification chain is:

```sh
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features          # must be 100% green
cargo bench                        # records numbers into BENCH.md
```

## Honesty policy

This README contains no vaporware. Anything in the targets table marked TARGET is a
hypothesis the build has not yet confirmed. When a gate passes, the row flips to PROVEN
with the SHA of the commit whose benchmark proved it. If a gate is failing, that is
recorded in `loop/PROGRESS.md`, not hidden. The project is "done" only when
`STATE.json.phase == "P7"` and the launch artifacts exist — there is no other definition.

## License

Apache-2.0. The `.mseg` format is published as an RFC ([`SPEC.md`](./SPEC.md)) before
the code ships, so the format can be implemented independently.
