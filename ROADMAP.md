# mneme / `.amr` — Roadmap (two-tier wedge)

> Strategy: ship the narrow thing (embedded vector store) to win adoption, let adoption GATE the
> hard thing (single-file memory engine). The `.amr` file is a superset — Tier-1 files become
> Tier-2 capable by adding fields, never a rewrite. Frame: **"SQLite for agent memory"**, NOT
> "Qdrant replacement." Real competitor is **LanceDB** (embedded), not Qdrant (server).

---

## Current production state (do not regress)

- `singulance-amr@0.1.0` published on npm (macOS arm64). Public repo `github.com/amar3012005/mneme`.
- LIVE in HIVEMIND production: org `723f0f5b` (sai@bundb.de) served by `.amr`; **only that org**.
  All other 13 orgs on Qdrant, byte-identical. Verified: routing isolated, recall 5/5 self-top1,
  storage 2.0M vs 23M (11.5×), recall p50 1.16ms vs 1.50ms, parity (upsert-replace/delete/
  score_threshold) live. Kill switch = `core/data/mneme/enabled-orgs`.
- **Pinned: sai stays on `.amr`. Do not enable another prod org without a deliberate decision.**

---

## TIER 1 — the wedge: "SQLite for agent memory" (embedded vector store)

Goal: a *real product* people embed, not a demo. This is the asset that gates everything else.

- [ ] T1-1: **Multi-OS publish.** Set a Granular/Automation npm token as the GH `NPM_TOKEN` secret →
      tag → CI publishes linux-x64/arm64 + win-x64 + mac sub-packages. `npm i singulance-amr` works
      on every OS, zero toolchain. (Builds already pass in CI; only the token blocks it.)
- [ ] T1-2: **Stable public API + types.** Freeze `MnemeVectorStore` (upsert/search/delete/compact)
      + `.d.ts`. Semver. Document the `.amr` format as an RFC (SPEC.md is the seed).
- [ ] T1-3: **Filtering parity.** score_threshold (done) + payload field filters + metric choice.
      Enough that an embedder isn't forced back to a server for a basic WHERE.
- [ ] T1-4: **The killer benchmark — vs LanceDB, not Qdrant.** Same corpus, embedded-to-embedded:
      storage, recall@10, p50/p99, cold-open time. Publish it. (Honest: include where we lose.)
- [ ] T1-5: **Node-binding latency.** Today the napi path is slower than the Rust engine at scale
      (4ms @ 8k). Trim it (narrower ef path / avoid Float32Array re-marshalling) so the embedded
      win holds past ~10k vectors. Target: binding p50 within 1.5× of native.
- [ ] T1-6: **Docs + 3 quickstarts** (Node, CLI, "replace your local Chroma/LanceDB in 5 lines").

### ADOPTION GATE (hard, 60-day)
> The memory engine is the prize; adoption of the wedge is the gate. Do NOT start Tier 2 until:
- [ ] **≥5 real teams** embedding `singulance-amr` who are not us, OR
- [ ] meaningful OSS pull (stars/issues/forks from strangers) on the "SQLite for agent memory" line.
- If the gate does NOT open in 60 days → the platform dream is a fantasy; stop, and sell the 11×
  embedded vector store as what it is. (We still have a good product.)

---

## TIER 2 — the prize: single-file memory engine (GATED on Tier-1 adoption)

Goal: `.amr` holds the WHOLE memory — not vectors. Then a company's brain is **one file**:
encryptable, movable, auditable, sovereign. Collapses Postgres + Qdrant + Redis → one mmap.
This is the only 10x no *server* DB can follow us into.

- [x] T2-PROBE — **PASSED** (commit 8b121616). Typed-edge slot {target,type,weight} + bi-temporal
      version chain; 2-hop typed traversal + "what did we know on date X" served from one reopened
      mmap, matching the reference. The graph-mutation-in-mmap wall is cleared. It IS a single-file
      memory engine.
- [x] T2-4.1 — **unbounded typed edges** via `.edg` overflow region (4f280a56). 50 edges spill +
      survive reopen + traverse. Real memories' relationship count is no longer capped.
- [x] T2-4.2 — **write-path versioning** (52d86aee). `update()` self-builds the Updates chain +
      marks old SUPERSEDED; recall returns only latest (HIVEMIND is_latest parity), `as_of` reaches
      history.
- [x] T2-4.3 — **scale** (d63903c5). 1M memories, typed 2-hop p50 **1.2µs inline / 16µs overflow**
      (cache-cold) — 300× under the 5ms gate. vs HIVEMIND Postgres-edge-join baseline (~ms): **100×+
      latency win on the relationship axis.**
- [x] T2 Node binding (d03a35fb) — traverseTyped / asOf / update / addEdge exposed: HIVEMIND
      `traverse_graph` + `hivemind_at`/`timeline` can be served by `.amr`. `.edg` leak closed via
      compact (ce7e251e).
- [ ] **T2-4.4 DOGFOOD (next, the only proof that counts):** rebuild the linux binary with the
      graph methods → backfill sai's typed edges from HIVEMIND's Postgres graph → wire HIVEMIND
      traverse_graph/at to serve from mneme for sai → compare latency + correctness vs Postgres →
      then one org runs with the relationship/time-travel path served by `.amr`.
- [ ] T2-5: entity table (>64 entities) + encryption-at-rest = the sovereignty artifact (one
      encrypted file = a company's whole brain).

---

## Kill conditions (the whole thesis)
1. **Building Tier 1 + Tier 2 in parallel** → ship two 60%-done things, lose to focused comps. Sequence.
2. **Positioning as "Qdrant replacement"** → feature war on a server's turf, we have 5% of the surface, we lose. Frame embedded.
3. **`.amr` stays vectors-only** → we built a faster Qdrant shard the world already has. The probe (T2-PROBE) is the fork between revolution and forgettable optimization.

## Next move (this week)
T1-1 (multi-OS publish — token-gated) + T1-4 (LanceDB benchmark). Cheapest path to the adoption gate.
