# mneme — benchmark results (durable record)

> Append-only. Gate scripts (loop/gates/*.sh) read structured key=value numbers
> from this file; a missing number is always a gate FAIL, never a pass. Every
> number is written with the git sha that produced it.

## Numbers (key=value — consumed by gates)

_(none yet — P1 writes the first: mneme_scan_p50_ms= and qdrant_rest_p50_ms=)_

## History

_(append: YYYY-MM-DD  key=value  sha=<short>  — note)_
mneme_scan_p50_ms=0.1548
qdrant_rest_p50_ms=2.0571

## P1 run 2026-06-23T17:59:02Z sha=87c3983d
- vectors: real bge-m3 (blaiq), dim=1024, 10k corpus / 200 queries (LongMemEval)
- mneme_scan_p50_ms=0.1548  (int8 mmap brute scan, recall@10=0.9565)
- qdrant_rest_p50_ms=2.0571  (Qdrant 1.18.2 REST, int8 quant, recall@10=1.0000)

## P2 baseline 2026-06-23T18:25:25Z sha=077fd8d1
- corpus: real bge-m3, 10k memories, dim=1024 (LongMemEval)
- mseg_insert_p50_us=3.7920  (append-only: LZ4 text + slot + .vec write)
- mseg_recall_p50_ms=22.5543  (exact brute-force f32 cosine, single-thread; HNSW is P3)
mseg_insert_p50_us=3.7920
mseg_recall_p50_ms=22.5543

## P3-4 write-path isolation 2026-06-23T19:12:53Z sha=20d3d2cb
- append_p99_under_concurrent_rebuild=  (insert p99 µs while HNSW indexer churns 10k-add backlog)
append_p99_under_concurrent_rebuild=

## P3-4 write-path isolation 2026-06-23T19:14:27Z sha=20d3d2cb
- append_p99_under_concurrent_rebuild=54.7525  (insert p99 us while HNSW indexer churns a 10k-add backlog)
append_p99_under_concurrent_rebuild=54.7525

## P3-5 recall@10 1M latency + quality 2026-06-23T19:27:52Z sha=4e3101f6
- dataset: 1M = 10k real bge-m3 + 990k deterministic-perturbed-real (latency scale-test); quality on 100% real 10k
- recall10_p50_ms=1.3340  (mneme HNSW @1M, p90=3.6925) — gate <5ms
- mneme_recall10=0.9925 vs qdrant_f32_recall10=1.0000 -> recall10_quality_loss_pct=0.75 — gate <3%
recall10_p50_ms=1.3340
recall10_quality_loss_pct=0.75

## P4 PQ recall@10 overlap 2026-06-23T22:46:40Z sha=80cf2a62
- PQ M=128/K=256, 128-byte code (32x). Production pattern: ADC scan over codes -> exact-f32 rescore top-100 (same as Qdrant quant+rescore).
- pq_recall10_overlap_pct=100.0000 (rescored)  |  pure-ADC@10=79.30% (transparency)
pq_recall10_overlap_pct=100.0000
