# mneme loop — NOTES (durable findings across phases)

## P1 — proof of physics (2026-06-23)

### What worked
- Real bge-m3 vectors via blaiq LiteLLM gateway (api.blaiq.ai/v1/embeddings, LITELLM_API_KEY)
  = the EXACT model+endpoint HIVE-MIND prod uses. 10k+200 LongMemEval memories, 1024-dim,
  normalized, ~4min via 4-worker batched REST (batch=96). Deterministic (stream order).
- Reuse spine compiled clean first try: memmap2 (wrapped owner) + zerocopy (header cast) +
  rayon (parallel scan). No bespoke index — exactly the recon mandate.
- int8 scalar quant (unit-vec × 127 → i8), i32-accumulated dot, rayon TopK fold/reduce.
  recall@10 = 0.957 vs exact f32 oracle (int8 loses ~4%, acceptable for P1; PQ/HNSW later).
- Steelmanned Qdrant: keep-alive HTTP session, int8 scalar quant + always_ram (prod parity).
  Still lost 13x — the REST hop is the moat, exactly the thesis.

### Numbers (sha 87c3983d)
- mneme_scan_p50_ms = 0.1548 (p90 0.2533, mean 0.177)  recall@10 0.957
- qdrant_rest_p50_ms = 2.0571 (p90 2.149, mean 2.070)  recall@10 1.000
- mneme 13.3x faster.

### Reusable fixtures (for P2+)
- bench/gen_vectors.py — real-vector generator (any N, prod bge-m3). Reuse for P3/P4/P6.
- bench/data/{corpus_f32.bin,queries_f32.bin,meta.json} — the canonical real eval set.
- bench/qdrant/qdrant (1.18.2 arm64) + qdrant_bench.py — the standing Qdrant baseline harness.
- crate/mneme-probe — load_f32_matrix, quantize_i8, exact_topk_f32 oracle reused by all bench bins.
- venv MUST run with PYTHONNOUSERSITE=1 PYTHONPATH="" (host has a leaking py3.9 user-site).

### Gotchas
- macOS host PYTHONPATH globally points at ~/Library/Python/3.9 user-site → poisons venvs.
  Always PYTHONNOUSERSITE=1 PYTHONPATH="" for the bench venv.
- Qdrant ships an aarch64-apple-darwin binary (no docker needed); clear com.apple.quarantine.
- First GitHub release download truncated at 11MB; verify file size before tar xzf.

## P2 — production crate (next)
- Promote the probe into the real .mseg format (full 202B slot header, LZ4 text region,
  free-list, tombstones, CRUD). proptest byte round-trips + Miri over the unsafe mmap path.
