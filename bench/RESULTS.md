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
