# mneme — GOALS (work-unit queue)

> The loop's queue + cursor. One open unit at a time, top-to-bottom.
> Checkbox states: `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked.
>
> **The orchestrator (`run-loop.sh`) owns the checkboxes.** The agent must NOT
> flip `[ ]`→`[x]` — the script does that, and only after a machine gate proves
> the unit. Each unit is a checkbox line followed by an indented spec block.
> Out-of-SPEC ideas go to `FUTURE.md`, never here.

## Phase P0 — Spec first (gate: frozen SPEC.md, no code yet)

- [x] p0-1: SPEC §1 — fully specify `.mseg` slot header + variable region
      depends_on: none
      acceptance: every field has exact type/size/offset/endianness; variable LZ4 region addressing defined; file header (magic, version, dim, count, free-list) defined
      risk_tier: medium
      rollback: revert SPEC.md §1 to skeleton

- [x] p0-2: SPEC §2 — `.mnsw` HNSW index format (map usearch on-disk index to slot ids)
      depends_on: p0-1
      acceptance: names the reused crate (usearch) per reference/OPENSOURCE_RECON.md; specifies key→slot-id mapping + co-location/mmap strategy; NO bespoke HNSW design
      risk_tier: low
      rollback: revert §2

- [x] p0-3: SPEC §3 — `.mpq` PQ codebook format
      depends_on: p0-1
      acceptance: M subspaces, K centroids, training trigger (first 10k), drift alignment score, on-disk layout all specified
      risk_tier: medium
      rollback: revert §3

- [x] p0-4: SPEC §4 — multi-tenant isolation scheme
      depends_on: p0-1
      acceptance: one .mseg/.mnsw/.mpq triple per org; directory layout + naming + open/mount lifecycle specified
      risk_tier: low
      rollback: revert §4

- [x] p0-5: SPEC §5 — query API surface (exact signatures + semantics)
      depends_on: p0-1
      acceptance: open/insert/recall/compact signatures final; Filter carries entity bitmap + created_at/valid_from ranges; hops semantics defined; all served from one mmap
      risk_tier: medium
      rollback: revert §5

- [x] p0-6: SPEC §6 — invariants
      depends_on: p0-1,p0-5
      acceptance: enumerate — append-only write path; async (never inline) index rebuild; recall never blocks on rebuild; stable slot ids; tombstone deletes until compact. These are the kill-condition guards the later gates check.
      risk_tier: high
      rollback: revert §6

- [ ] p0-freeze: human review + freeze SPEC.md
      depends_on: p0-1,p0-2,p0-3,p0-4,p0-5,p0-6
      acceptance: HUMAN sets Frozen:YES + Reviewed by:<name> in SPEC.md, creates loop/APPROVALS/p0.freeze, and commits as themselves (NOT the loop identity). The loop will AWAIT HUMAN here — it cannot self-freeze. Gate: loop/gates/p0_spec_frozen.sh exits 0.
      risk_tier: human-gate
      rollback: set Frozen:NO

## Done

_(units move here with their sha as they complete)_
