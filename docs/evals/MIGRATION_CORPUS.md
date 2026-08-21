# v0.3 migration corpus

This public fixture manifest covers every published `v0.3.*` tag. Each fixture recreates the
legacy graph contract used by those releases: `.icarus-graph/graph.db`. The Rust harness test
then runs both `icarus migrate --dry-run` semantics and the explicit apply path.

The fixtures use synthetic opaque bytes, not user data. For every covered release tag, the test
asserts that migration:

- does not mutate the repository during a dry run;
- copies, rather than moves, the legacy graph to `.icarus/runtime/graph/graph.db`;
- leaves the legacy graph intact; and
- preserves byte-for-byte every representative shard sidecar, including `shard.amr`.

Run the gate with:

```sh
cd crate
cargo test -p icarus-harness --test runtime published_v03_migration_corpus_preserves_memory_bytes_and_legacy_graph
```

This corpus is intentionally a migration compatibility gate, not evidence that a private shard
has been inspected or rewritten. The harness migration never opens `.amr` content.
