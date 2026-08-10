# T1-4 — mneme vs LanceDB (embedded-to-embedded)

> ROADMAP.md T1-4: "The killer benchmark — vs LanceDB, not Qdrant. Same corpus, embedded-to-embedded:
> storage, recall@10, p50/p99, cold-open time. Publish it. (Honest: include where we lose.)"
>
> This is that benchmark. It is not a win. Publishing it anyway, because the roadmap said to.

## Method

- **Corpus**: 10,000 real `bge-m3` embeddings (1024-dim, unit-normalized) of real LongMemEval
  conversation turns — the same corpus used for the P1/P3/P6 gates in `../RESULTS.md`. 200 held-out
  queries from the same distribution. Not synthetic.
- **Ground truth**: exact float32 cosine top-10 per query, computed once in JS, cached, and used to
  score both engines identically (`shared.mjs::exactTopK`).
- **Both engines embedded, both via their real Node bindings** — no server, no network hop, no
  quantization tuning skipped for one side:
  - `mneme`: napi binding (`crate/mneme-node`), `MnemeStore.insert()` per record, `enableHnsw()`,
    `recall()` (approximate, HNSW — the realistic embedded-app path).
  - `LanceDB`: `@lancedb/lancedb` 0.33.0, bulk `createTable()`, `createIndex()` (default IVF_PQ),
    `search().limit(k)` (approximate — the realistic embedded-app path).
- Run once, on the same machine, same process family, back to back. Not averaged over multiple
  runs — a follow-up should do that before treating these as load-bearing numbers.
- Script: `bench_mneme.mjs`, `bench_lancedb.mjs`. Reproduce with:
  ```bash
  node bench_mneme.mjs   ../data/corpus_f32.bin ../data/queries_f32.bin 1024 10 /tmp/mneme-run   /tmp/gt.json
  node bench_lancedb.mjs ../data/corpus_f32.bin ../data/queries_f32.bin 1024 10 /tmp/lancedb-run  /tmp/gt.json
  ```
- Napi-vs-native isolation: `crate/mseg/examples/napi_overhead_probe.rs`. Reproduce with:
  ```bash
  cargo run --release --example napi_overhead_probe -p mseg -- \
    ../data/corpus_f32.bin ../data/queries_f32.bin 1024 10
  ```

## Results — 10,000 vectors, dim=1024, k=10

| Metric | mneme (`.amr`, napi, HNSW) | LanceDB (default IVF_PQ) | LanceDB (tuned: nprobes=50, refine=20) |
|---|---|---|---|
| recall@10 | **1.000** | 0.715 | 1.000 |
| query p50 | 4.38 ms | **0.98 ms** | 2.26 ms |
| query p99 | 6.64 ms | 17.71 ms (cold-partition tail) | 4.37 ms |
| index build | 24.87 s | **6.29 s** | 6.29 s (same index) |
| ingest (bulk/total) | 88.7 ms | 402.6 ms | — |
| storage / record | 5,727 B | **4,278 B (25% smaller)** | 4,278 B |

**At matched recall (1.00 vs 1.00), LanceDB is ~1.9× faster on query p50 and ~25% smaller on disk.**
mneme's index build is ~4× slower (HNSW build cost on the napi path, not yet optimized).

## Why — and what it actually says (corrected)

**First pass at this writeup blamed the napi binding. That was wrong — verified and retracted
below, not left standing.** ROADMAP.md's T1-5 entry (written before this benchmark existed)
predicted the gap was "the napi path is slower than the Rust engine at scale (4ms @ 8k)" — Node↔Rust
marshalling overhead. That's a specific, checkable claim, so it was checked: `crate/mseg/examples/
napi_overhead_probe.rs` runs the identical `Shard::recall()` call, same corpus, same k=10, same
`enable_hnsw()`, with **zero napi/FFI boundary** — pure Rust, `cargo run --release`.

```
native_query_p50_ms=3.8163   (no napi, no JS, no FFI)
napi_query_p50_ms=4.3754     (bench_mneme.mjs, same params)
```

The gap between them is **~0.56ms** — real, but nowhere near large enough to explain a 4.38ms
number, and far too small to be "the bottleneck." **The napi binding is not the problem.** The
cost is in the algorithm's own over-fetch/rerank tuning at this scale: `recall_hnsw()` in
`crud.rs` sets `ef = 256` (the `(top_k*24).max(256)` floor) and `rerank_depth = 64`
(`(top_k*6).max(64)`) regardless of corpus size — at 10k records, an ef-256 HNSW search plus 64
cold `.vec`-file reads for exact rerank is genuinely ~3.8ms of native work, not a binding tax.

This matters because it points the actual T1-5 fix at the wrong target would waste effort:
**shrinking the napi marshalling would save ~0.5ms; the real ~3.8ms lives in the HNSW/rerank
parameters, and those floors likely need to scale with corpus size instead of using flat
minimums** (`256`/`64` sized for recall-safety at large N are needlessly wide at 10k, where a much
smaller `ef` would still hit recall@10=1.00 — this repo's own 1M-scale number, 1.33ms via the same
code path, is proof the algorithm scales fine; 10k just isn't hitting an efficient regime with
these floors).

**Conclusion for the roadmap**: T1-4 is done — published, honest, including the loss. It does
**not** confirm the pre-existing T1-5 diagnosis; it disproves it and replaces it with a more
specific, evidence-backed one (see ROADMAP.md T1-5, corrected). The LanceDB-tuned p50 (2.26ms) is
still the number to beat; the fix path just changed from "binding" to "ef/rerank-depth scaling."

## T1-5 resolved — and the "ef/rerank-depth" hypothesis above was ALSO wrong

**Second correction in this document, same discipline as the first.** The "Why" section above
predicted the fix was scaling `crud.rs`'s `ef`/`rerank_depth` (256/64) down for small corpora.
That was checked with a real sweep (`crate/mseg/examples/ef_sweep.rs`, ground-truth recall@10 vs
brute force, not assumed) before writing any fix — and it's wrong too:

```
hnsw_efs,ef_floor,rerank_depth,recall_at_k,query_p50_us
400,64,64,1.0000,3631        <- original defaults, matches napi_overhead_probe's 3816us
400,256,64,1.0000,3631       <- ef_floor swept 32->256: NO EFFECT on latency
16,64,64,1.0000,2660         <- rerank_depth swept 1->64 at fixed EFS: NO EFFECT either
16,64,16,1.0000,2503         <- but EFS (usearch's OWN param) swept 400->16: real, ~30% drop
16,64,4 ,0.4000,2515         <- and rerank_depth<16 DOES cost recall (not latency) — real floor found
```

Neither `ef` nor `rerank_depth` in `crud.rs` moved latency at all across their full swept ranges.
The real fixed cost was `MNEME_HNSW_EFS` — usearch's own internal search-expansion parameter
(`expansion_search`, default 400), a **separate, index-build-time** knob from anything in
`crud.rs`, never touched by the T1-4 investigation. It was tuned once, at 1M scale (P3 gate:
recall@10=99.25%), and never re-validated at smaller corpora, where a 400-candidate graph
expansion over only 10k nodes is enormous overkill.

**Fix shipped** (`mnsw-index/src/lib.rs::scaled_efs`): EFS now scales with corpus size at
index-build time — 64 for n≤20k (the only tier directly measured; 4x the measured-lossless floor
of 16, as margin since only one corpus/dim was swept), 128/256 for the 100k/500k tiers (reasoned
interpolation, not independently measured — re-sweep before trusting those as tightly as the 10k
number), and **unchanged at 400 above 500k** — the exact value the 1M-scale gate already proved,
deliberately untouched, zero regression risk there. `MNEME_HNSW_EFS` still overrides explicitly.
Also found: `rerank_depth` has a real *recall* floor around 16 (not the existing 64 default) —
depth=4 drops recall@10 to 0.40 — informational, left at 64 since it costs nothing to keep the
margin (only EFS affects latency).

**Result, napi-level, same benchmark as above, zero env overrides (real default path)**:

| Metric | Before | After | LanceDB-tuned |
|---|---|---|---|
| query p50 | 4.38 ms | **3.02 ms** (−31%) | 2.26 ms |
| recall@10 | 1.000 | **1.000** (unchanged) | 1.000 |

Gap to LanceDB-tuned narrowed from 1.9× to 1.34×. Verified: `cargo test --workspace` +
`cargo clippy --workspace --all-targets -- -D warnings` both clean after the change; a dedicated
`examples/verify_default_recall.rs` confirms recall@10=1.0000 on the exact zero-override code path
a real caller hits, not just the sweep's instrumented one.

**Still open**: the ~2.5ms native floor remaining even at EFS=16 wasn't further decomposed — likely
inherent usearch graph-traversal cost or per-call fixed overhead below EFS's floor of usefulness.
The 100k/500k EFS tiers are unmeasured interpolation. LanceDB-tuned (2.26ms) is still faster;
closing the remaining ~0.76ms gap needs a different investigation, not more of this one.

## Honest gaps in this run (not hidden)

- Single run, not averaged/repeated — noise band unmeasured.
- Only 10k scale tested here. Given the fix target is now `ef`/`rerank_depth` scaling (not the
  binding), the next real step is sweeping `MNEME_RERANK_DEPTH` and a corpus-scaled `ef` at 10k to
  find the smallest values that hold recall@10=1.00 — not yet done.
- mneme storage here has no PQ compression enabled (raw f32 + HNSW graph); the ~600 B/record figure
  elsewhere in this repo requires the separate `mpq` product-quantization layer, not exercised by
  this script. LanceDB's IVF_PQ *is* quantized by default — the storage comparison above is not
  apples-to-apples on compression, only on "what you get out of the box calling `createIndex()`."
  A fair follow-up enables mneme's PQ path here too.
- LanceDB's query p99 (17.7 ms, default pass) is a cold-partition-probe artifact of low `nprobes`
  at small scale, not representative of its steady-state tail — the tuned pass's p99 (4.37 ms) is
  the more honest number to compare against.
