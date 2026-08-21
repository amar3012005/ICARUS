# Context compiler evaluation

`context-corpus-v1.json` is a public, deterministic regression corpus for the Rust context
compiler. It deliberately has no model, network, private repository, or hidden embedding
dependency.

Each case defines a task objective, a required evidence anchor, and a set of unrelated local
evidence records. The runtime test writes those records to a real repository-local AMR shard,
compiles context through the production Rust API, and proves both of these properties:

1. The required anchor survives ranked local retrieval.
2. The compiled startup pack is at least 50% smaller than a transparent unbounded baseline.

The baseline is not a summary or a guessed tokenizer count. It is the exact same mandatory
task/policy/runtime material with every local evidence document included. Size is measured in
UTF-8 bytes, the compiler's documented conservative token upper-bound when a selected coding
agent does not provide its tokenizer.

Run it locally:

```sh
cd crate
cargo test -p icarus-harness --test runtime \
  published_context_corpus_retains_required_evidence_and_halves_unbounded_startup_context \
  -- --nocapture
```

The test prints compiled/baseline units and the observed reduction for every case. It fails if a
required anchor disappears or the reduction drops below the declared case threshold.

This is a release regression gate, not a claim that three synthetic cases cover every repository.
The corpus can grow only through a public reviewable change that adds a task, required anchor, and
transparent baseline definition.
