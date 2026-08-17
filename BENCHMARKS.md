# Benchmark methodology

Every number in the README and `THESIS.md` traces to a run recorded in
[`bench/RESULTS.md`](./bench/RESULTS.md), append-only, each line stamped with the git SHA that
produced it. This file explains *how* those numbers were produced, so a claim can be checked
rather than trusted.

## The one rule: real embeddings, never synthetic vectors

Every benchmark corpus is real `bge-m3` embeddings of real text (the LongMemEval dataset for the
10k-scale runs). Random/synthetic vectors are never used for a performance number in this repo —
they have no cluster structure, so an ANN index (HNSW, PQ, IVF, anything) behaves nothing like it
does on real data. A benchmark on random vectors is not evidence of anything; it's a number that
happens to exist.

## Scale-test corpora are real-base + deterministic perturbation, not synthetic

The 1M-vector latency numbers (P3-5, `bench_1m.rs`) fan a real 10k `bge-m3` base out to 1M by
seeded, deterministic small-noise perturbation + renormalization of the real vectors — not random
vectors. This is valid for *latency* (HNSW/PQ traversal cost depends on graph/codebook size and
real-ish cluster structure, not on every vector being a unique real memory) but NOT valid for
*recall quality* — quality numbers are measured separately on the 100%-real 10k corpus
(`bench/quality_vs_qdrant.py`), never on the perturbed 1M set. Every entry in `RESULTS.md` says
which kind of number it is.

## Comparison baseline

Qdrant 1.18.2, REST API, int8 scalar quantization (Qdrant's own recommended production config —
comparing against Qdrant's *worst* config would be a rigged comparison). Same real embeddings
inserted into both systems, same queries, same machine, same run.

## Reproduce it yourself

```bash
cd crate
bash ../bench/run_p1.sh          # the headline number, mneme vs Qdrant, on your own machine
```

Nothing in `bench/` requires network access beyond the initial embedding fetch (the corpus is
cached after the first run) — reproduce the exact numbers on your own hardware, not just ours.

## What's measured vs what's asserted

| Claim | Measured how | Where |
|---|---|---|
| 13x faster than Qdrant REST | `mseg_scan_p50_ms` vs `qdrant_rest_p50_ms`, real 10k bge-m3 | RESULTS.md P1 |
| 1.33ms recall@10 @ 1M | HNSW p50, real-base perturbed 1M | RESULTS.md P3-5 |
| recall quality parity (1.00) | recall@5 vs exact float32 ground truth, 100% real 10k | RESULTS.md P6 |
| 32x PQ compression, near-zero quality loss | PQ M=128/K=256, ADC scan + exact rescore top-100 | RESULTS.md P4 |
| PQ vs HNSW scale-dependent tradeoff (PQ wins small/medium, loses large) | Direct A/B, same corpus/queries, both paths | see PQ section below |

## The PQ-vs-HNSW tradeoff, honestly

This is the one number in this repo that does NOT resolve to "ours is better" — it's a genuine
tradeoff, measured at two scales with the *same* harness (`mseg/src/bin/pq_bench.rs`):

| scale | HNSW build | PQ build | HNSW query (recall=1.0) | PQ query (recall=1.0) |
|---|---|---|---|---|
| 10k | ~4s | 7.2s | 2.76ms | **1.71ms — PQ wins both** |
| 100k | 341.5s | **54.2s (6.3x faster)** | 4.44ms | 13.58ms — HNSW wins query |

PQ scans every code at O(n) with a cheap per-item cost; HNSW's near-O(log n) traversal wins on
query latency once the shard grows. Neither is "the right default" — `recall_pq()` is opt-in for
exactly this reason. See `crate/mneme-node/mcp-serve.js`'s `icarus_train_pq` tool description for
the same tradeoff surfaced to an agent calling it directly.

## A regression we shipped, then reverted, on purpose

Early in this repo's history, HNSW index *build* time was parallelized by default (rayon
concurrent insertion) for a real ~6x build-speed win at 10k. Re-measured at 100k/1M before trusting
it further: query latency regressed 34%-100% at those scales (concurrent insertion changes the
graph's shape in a way that degrades search-time navigability — recall stayed correct, latency
didn't). Reverted to opt-in-only (`MNEME_BUILD_PARALLEL=1`). Documented here because "we measured a
regression and reverted it" is the kind of thing benchmark claims should survive, not hide.
