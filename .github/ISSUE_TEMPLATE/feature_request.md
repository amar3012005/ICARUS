---
name: Feature request
about: Propose new functionality or a format/API change
labels: enhancement
---

**What you're trying to do** — the actual use case, not the mechanism you assume solves it.

**Why the current engine can't do it** — what you tried, what's missing.

**Format impact**: does this need a `.amr` byte-layout change? `SPEC.md` is a frozen RFC — field
offsets/sizes don't change. If your idea needs one, say so explicitly and explain why an additive
change (new layer, new edge type, new sidecar file) isn't enough; see CONTRIBUTING.md.

**Benchmarks**: if this is a performance proposal, real `bge-m3`-embedded data only — no synthetic
vectors (they don't reproduce real cluster structure, so ANN behavior on them isn't evidence).
