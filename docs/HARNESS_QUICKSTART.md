# ICARUS Harness quickstart

The harness is the deterministic operating layer around a coding agent. It owns repository
identity, immutable task contracts, bounded context packs, verification receipts, and the seal
gate. It does **not** choose a model, call an LLM, upload a repository, or silently grant an
external approval.

## 1. Initialize one repository

Run this at the root of a Git repository. Initialization creates a tracked `.icarus/manifest.yaml`
and policy, while runtime state remains under ignored `.icarus/runtime/`.

```bash
icarus harness init --agent claude
icarus doctor
```

Use `icarus migrate --dry-run` before `icarus migrate` for a repository created with an older
ICARUS preview. Migration copies legacy graph metadata only; it never rewrites `.amr` shards.

## 2. Define the work before launching an agent

Write a reviewed contract. The allowed path set and acceptance criteria are authority, not agent
suggestions.

```json
{
  "allowed_paths": ["src/**"],
  "forbidden_paths": ["secrets/**", ".env"],
  "acceptance_criteria": [
    { "id": "unit", "type": "test", "command": "npm test", "required": true }
  ],
  "risk": "low",
  "budgets": { "wall_time_minutes": 30 },
  "authority": "local",
  "external_write_policy": "approval_required",
  "decision_references": []
}
```

```bash
icarus task start --objective "Add scoped authentication" --contract contract.json
# Copy the returned TASK-… id into the commands below.
icarus task transition TASK-… orienting
icarus task transition TASK-… contracted
icarus task transition TASK-… planned
```

## 3. Inspect deterministic context, then launch

`context build` is local Rust work: it has no model or network dependency. It records why every
included item was selected and respects the given budget.

```bash
icarus context build --task TASK-… --budget 20000 --format markdown
icarus run --task TASK-… --agent claude
```

Managed runs use an isolated Git worktree by default. The authoritative checkout must be clean.
`--workspace current` exists only for an explicit, acknowledged current-workspace run. ICARUS
refuses paths that escape the checkout, symlink escapes, and writes inside nested Git repositories
or submodules.

The command starts the coding client already installed on the machine. A client labelled
**compatible** in [adapter certification](ADAPTER_CERTIFICATION.md) is useful, but is not a
claim that every client operation is hard-intercepted.

## 4. Verify and seal

An agent exit is not proof. Run each immutable acceptance criterion, then seal only when current
receipts satisfy the contract.

```bash
icarus task handoff TASK-…
icarus task verify TASK-… --criterion unit
icarus task seal TASK-…
icarus task export TASK-… --redact
```

If a task is interrupted, use `icarus task status --task TASK-…` and `icarus task resume --task TASK-…`. The
task, execution linkage, checkpoints, and event chain are persisted by Rust; a fresh agent process
does not get to invent a completed state.

## Optional HIVE-MIND organizational context

Local use does not require an account or network. The optional authority channel is explicit:

```bash
icarus sync inspect
icarus sync pull --remote --project PROJECT-UUID
```

Only an authenticated, scoped snapshot of explicitly approved project decisions can enter local
context. A newer unexpired revision produces a visible conflict and blocks outbound export until a
human reviews it and reruns the pull with `--accept-revision`. Cached authority is never sufficient
for an external action; live remote approval is required and this transport is not yet production
certified.

## What to trust

- `icarus doctor` checks the manifest, policy, event chain, graph state, and adapter availability.
- `icarus context inspect --task TASK-…` shows source/freshness/digests without printing content.
- `icarus policy explain DENIAL-…` returns the Rust-recorded reason for a real refusal.
- `icarus task export --redact` emits a receipt without objective text, paths, output excerpts, or
  attestation identities.

See [the threat model](HARNESS_THREAT_MODEL.md), [adapter certification](ADAPTER_CERTIFICATION.md),
and [the phase-status ledger](PHASE_STATUS.md) for implemented boundaries and remaining release
gates.
