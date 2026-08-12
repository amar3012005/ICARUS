---
name: Bug report
about: Something in the engine or a binding is broken
labels: bug
---

**Operation**: what call(s) triggered it (`insert`, `recall`, `compact`, ingest CLI, etc).

**Shard size**: `liveCount()` at the time, and whether HNSW was enabled (above/below
`MNEME_HNSW_MIN`, default 50k).

**Platform**: OS/arch, Node or Python version, binding version (`singulance-amr`/`mneme-python`).

**Expected vs actual**: what you expected, what happened instead.

**Repro**: minimal code, or a description if you can't share the exact record.

**Do not attach a real `.amr` shard or its contents** — it contains tenant memories. If a shard
is corrupt, send the 202-byte header bytes and the error instead (see CONTRIBUTING.md).
