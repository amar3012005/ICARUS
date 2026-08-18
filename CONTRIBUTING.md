# Contributing

Thanks for looking at mneme. It is a small, deliberately-scoped project: an embedded
memory filesystem (`.amr`) for AI agents. Rust core, Node binding, no server.

## Layout

```
crate/
  mseg-format/   the .amr byte layout — the frozen format RFC in code (see SPEC.md)
  mseg/          the engine: slots, append, index, graph, segment, compaction
  mnsw-index/    HNSW overlay (usearch) for approximate recall above a size threshold
  mpq/           product quantization (32x vector compression)
  mneme-node/    napi-rs Node binding — the public JS API (index.d.ts)
  mneme-probe/   probe/diagnostic binary
bench/           reproducible benchmarks vs Qdrant on real bge-m3 embeddings
```

## Build + test

Requires Rust **1.77+** (stable `core::mem::offset_of!`, used by the spec-lock test) and
Node **18+**.

```bash
cd crate
cargo test --workspace
cargo build --release

cd mneme-node
npm install
npm run build
npm run build:debug
```

`cargo test --workspace` runs the engine + format tests, including the spec-lock test.
`npm run build` runs `napi build --release`, producing the native addon + `index.d.ts`; `npm run
build:debug` is the same but faster and unoptimised.

## The format is a contract

`SPEC.md` is a frozen RFC. The 202-byte slot survived production without a field change,
and a spec-lock test asserts the layout. **Do not change field offsets or sizes.** If you
believe the format must change, open an issue describing why before writing code — a
format break invalidates every existing `.amr` file on disk.

Additive changes (new layers, new edge types, new sidecars) are the intended path.

## Benchmarks must be real

Every number in this repo comes from **real `bge-m3` embeddings of real records**, never
synthetic vectors, and is compared against a real Qdrant instance. If you submit a
performance change, include the before/after from `bench/` and say what hardware it ran
on. A benchmark on random vectors is not evidence — random vectors have no cluster
structure, so ANN indexes behave nothing like they do on real data.

## Pull requests

- One concern per PR.
- Include a test. Engine changes need a `cargo test` case; binding changes need a JS case.
- Explain *why* in the commit body — the failure it fixes or the measurement that
  motivated it. This codebase's comments carry root causes on purpose; keep that.
- Don't add a dependency without saying what it replaces.

## Reporting bugs

Include: the operation, shard size (`liveCount()`), whether HNSW was enabled, and the
platform. If a shard is corrupt, **do not send us the file** — it contains the tenant's
memories. Send the header bytes and the error.

Security issues: see [SECURITY.md](./SECURITY.md) — please do not open a public issue.
