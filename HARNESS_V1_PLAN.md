# ICARUS Harness: v0.3.46 to Production Open-Source v1.0

## Summary

ICARUS will evolve from a local memory filesystem into a deterministic harness around existing coding agents. Claude, Codex, Grok, or another agent supplies the intelligence; ICARUS supplies trusted context, task state, permissions, verification, resumability, and governed learning.

Locked product decisions:

- The harness performs no LLM inference. The coding agent creates plans, summaries, contracts, and skill proposals through structured ICARUS tools.
- ICARUS remains local-first and fully usable offline. HIVE-MIND is an optional organizational authority for shared decisions, approvals, and team synchronization.
- `icarus run <agent>` is the fully governed execution path. Existing `/setup` and MCP installation remain compatibility paths.
- The public GitHub repository becomes canonical before community contributions are accepted.
- Skill promotion is policy-gated: low-risk skills may auto-promote after sufficient proof; high-risk skills require owner approval.
- Release train: v0.4 preview → v0.5 beta → v0.9 release candidate → v1.0 stable.
- v1 certification targets Claude Code and Codex CLI. Grok Build, Cursor, and arbitrary MCP agents launch in compatibility or experimental tiers until they satisfy the same enforcement contract.
- Existing `.amr` shards and memory APIs remain compatible.

The target operating loop is:

```text
Orient → Contract → Plan → Execute → Verify → Seal → Learn → Replay
```

The coding model proposes actions at every reasoning step. ICARUS deterministically controls whether those actions are authorized and whether the result is proven.

## Target Architecture and Public Interfaces

### Final repository state

Tracked and reviewable:

```text
.icarus/
  manifest.yaml
  policies/
    execution.yaml
    tools.yaml
    learning.yaml
    retention.yaml
  decisions/
    refs.yaml
  skills/
    active/
    retired/
    registry.json
  evaluations/
    regression-corpus/
  schemas/
    manifest.schema.json
    contract.schema.json
    checkpoint.schema.json
    receipt.schema.json
    skill.schema.json
```

Ignored local runtime state:

```text
.icarus/runtime/
  graph/graph.db
  tasks/TASK-*/
    contract.v1.json
    checkpoints.jsonl
    final-result.json
  evidence/TASK-*/
    commands.jsonl
    test-results/
    runtime-probes/
    diff.patch
    artifact-receipt.json
  state/
    current-task.json
    worktree.json
    budget.json
    engine.json
  skills/proposed/
  logs/
```

Raw embeddings, credentials, transcripts, large logs, and private history never enter Git. Selected redacted receipts may be exported explicitly.

### Stable CLI design

```text
icarus harness init [--agent claude|codex|cursor|grok|all]
icarus run --agent <agent> [--task <id>] [--workspace auto|current] -- [agent args]

icarus task start --objective <text> [--contract <file>]
icarus task status [--task <id>]
icarus task checkpoint --phase <phase> [--input <json>]
icarus task verify --criterion <id> -- <command>
icarus task seal [--task <id>]
icarus task block --reason <text>
icarus task resume <id>
icarus task export <id> [--redact]

icarus context build [--task <id>] [--budget <tokens>] [--format json|markdown]
icarus context inspect [--task <id>]

icarus learn propose --task <sealed-task-id> --skill <directory>
icarus learn evaluate <skill-id>
icarus learn promote <skill-id>
icarus learn retire <skill-id> --reason <text>

icarus policy check [--task <id>]
icarus policy explain <denial-id>
icarus doctor
```

Existing `icarus verify` continues to mean memory-signature verification. Harness verification stays namespaced under `icarus task verify`.

### New MCP tools

- `icarus_task_start`
- `icarus_task_status`
- `icarus_context_get`
- `icarus_action_check`
- `icarus_checkpoint`
- `icarus_verify_run`
- `icarus_task_seal`
- `icarus_task_block`
- `icarus_skill_propose`
- `icarus_skill_evaluate`
- `icarus_skill_promote`
- `icarus_policy_explain`

Every response includes `execution_id`, `task_id`, `status`, `issues`, and relevant evidence references. No tool returns an unstructured success string for lifecycle-critical operations.

### Managed-agent certification contract

An adapter is "certified" only when it supports:

1. Pre-action authorization.
2. Post-action event capture.
3. Completion/seal interception.
4. Stable session identity and resume.
5. Transcript or structured event access.
6. Tool allow/deny configuration.
7. Workspace isolation.
8. External-write approval interception.

Agents missing any capability are labeled `compatible`, not `certified`.

## Phased Delivery

### Phase 0 — Stabilize the Current Product and Open-Source Workflow

Target: v0.3.47–v0.3.x maintenance releases.

- Make the public GitHub repository canonical. The private monorepo consumes a pinned ICARUS release, Git subtree, or package instead of overwriting public development.
- Preserve the current private-to-public scanner as a pre-publish security check, no longer as the source-authority mechanism.
- Introduce a root CLI `VERSION` source used by the compiled binary, release tags, and update checks. Keep the `singulance-amr` engine package on its independent package version.
- Restore functioning GitHub Actions and require green checks before merge.
- Add Node-layer CI for CLI, TUI, MCP, setup installers, recall, ingestion, skill behavior, and compiled-binary smoke tests; current CI primarily protects Rust and Python.
- Automate release creation, asset naming, SHA-256 checksums, draft detection, cold download, and version execution.
- Publish contributor documentation, governance, security reporting, code of conduct, and an RFC template.
- Record v0.3.46 behavior as the compatibility baseline.

Exit gate:

- A public pull request can be merged without being overwritten by private synchronization.
- CI is green on macOS and Linux.
- A release is built from the public commit and cold-verified automatically.
- Existing shards open without migration.

### Phase 1 — Repository Manifest and Deterministic Runtime

Target: v0.4.0 preview.

- Add `icarus harness init`, creating the tracked manifest, default policies, schemas, runtime `.gitignore`, and repository identity.
- Validate YAML configuration against versioned schemas before any managed session starts.
- Store a stable `repo_id`, policy version, harness version, Git remote fingerprint, and repository root.
- Move the existing `.icarus-graph/graph.db` convention into `.icarus/runtime/graph/graph.db`. Read the old location during migration and copy safely; never delete it automatically.
- Introduce one append-only runtime event envelope:

```json
{
  "schema_version": 1,
  "execution_id": "exec-...",
  "task_id": "TASK-...",
  "sequence": 12,
  "event_type": "checkpoint",
  "timestamp": "...",
  "repo_id": "...",
  "worktree_id": "...",
  "payload": {},
  "previous_hash": "...",
  "event_hash": "..."
}
```

- Use atomic write-then-rename for current-state snapshots and append-only JSONL for history.
- Hash-chain the runtime log locally. Cryptographic signing remains optional; integrity checking does not require HIVE-MIND.
- Add `icarus doctor` checks for repository identity, policy validity, graph health, stale locks, adapter availability, writable runtime state, and upgrade compatibility.

Exit gate:

- Initialization is idempotent.
- A crash during state persistence leaves either the previous valid state or the new valid state.
- Tampered events are detected.
- Existing memory, graph, CLI, TUI, and MCP behavior still works.

### Phase 2 — Task Contract and Resumable State Machine

Target: v0.4.1 preview.

- Implement explicit states:

```text
created
→ orienting
→ contracted
→ planned
→ executing
→ verifying
→ sealed | failed | blocked | waiting_for_approval
```

- Read-only `observe` and `plan` sessions may run without an execution contract. The first write requires a contract.
- Contracts contain objective, allowed and forbidden paths, acceptance criteria, risk, budgets, authority, external-write policy, and terminal states.
- Once execution begins, the contract is immutable. A change creates `contract.v2.json`, records the reason, invalidates affected evidence, and requires the configured approval.
- Every managed task receives one task ID and one execution ID. Resumed sessions retain the task ID and start a linked execution attempt.
- Checkpoints record Git SHA, dirty-state fingerprint, files touched, graph version, context-pack hash, budget consumption, open risks, and next valid action.
- `icarus task resume` reconstructs state from events, validates the worktree, and reports divergence instead of silently continuing.
- Add task lifecycle MCP tools so the coding agent—not ICARUS—writes the objective, plan, and checkpoint summaries.

Exit gate:

- A task interrupted after planning, editing, and verification can resume in a fresh agent session.
- Out-of-order transitions are rejected.
- A code write without a contract is rejected in managed mode.
- Contract amendments are attributable and cannot rewrite history.

### Phase 3 — Context Window Compiler

Target: v0.4.2 preview.

- Build `icarus context build` as a deterministic context compiler, not an LLM summarizer.
- Inputs:

  - Current task contract and phase.
  - Git HEAD, changed files, and worktree divergence.
  - Relevant code-graph slice.
  - Applicable repository policies.
  - Referenced HIVE-MIND decisions or their local cache.
  - Active verified skills matching task type and file patterns.
  - Relevant prior failures and unresolved risks.
  - Remaining acceptance criteria.
  - Memory/evidence recall from the task query.

- Rank context by mandatory policy, direct dependency proximity, decision authority, task relevance, recency, and verified-skill confidence.
- Enforce an explicit token budget. Mandatory rules and acceptance criteria cannot be truncated; lower-priority evidence becomes referenced pointers.
- Produce both structured JSON and rendered Markdown from the same context object.
- Every item contains source, digest, freshness, authority, and retrieval reason.
- Generate delta context packs after checkpoints so agents receive changed state rather than the entire repository repeatedly.
- Refuse to mark a graph "current" when fingerprints show structural changes after its build receipt.
- Update setup instructions so the coding agent calls `icarus_context_get` before planning and after compaction, resume, or major repository changes.

Exit gate:

- Context packs always fit the requested budget or return a deterministic `budget_unsatisfied` error.
- The same repository state and task produce the same pack.
- Every factual context item is traceable.
- Benchmark tasks use materially fewer startup tokens than the current broad instruction-loading path without reducing task success.

### Phase 4 — Managed Launcher and Agent Adapter SDK

Target: v0.5.0 alpha.

- Implement `icarus run` as the production harness entry point.
- Default to an isolated Git worktree. `--workspace current` is explicit and refuses ambiguous dirty-state adoption without acknowledgment.
- Define an adapter interface:

```text
detect()
capabilities()
prepareSession()
launch()
authorizeAction()
captureEvent()
requestApproval()
resume()
stop()
```

- Claude Code adapter:

  - Install task-scoped MCP configuration.
  - Use lifecycle hooks for pre-tool, post-tool, stop, session start, and session end.
  - Restrict available tools according to policy.
  - Stream hook events into the ICARUS task log.

- Codex CLI adapter:

  - Launch with a task-scoped profile, sandbox, MCP configuration, hook policy, and controlled writable directories.
  - Capture app-server or structured execution events where available.
  - Require the same pre-action and stop/seal gates before certification.

- Grok Build adapter:

  - Supply task rules, permission allow/deny sets, worktree, MCP server, and session identity.
  - Remain experimental until pre-action and completion interception meet the certification contract.

- Cursor and arbitrary MCP clients:

  - Continue receiving project instructions and MCP registration.
  - Clearly display `compatibility mode: policy guidance is active, hard enforcement is not guaranteed`.

- Route external writes through explicit approval tokens. Repository-local edits allowed by contract do not require repeated approval.
- Track tool calls, model calls when reported by the agent, wall time, and configured budgets without inspecting model reasoning.
- ICARUS never selects, calls, or pays for the coding model; the launched agent owns model configuration.

Exit gate:

- Claude Code and Codex cannot seal a managed task without ICARUS.
- An out-of-scope edit is stopped before execution where hooks permit it, or quarantined immediately where only post-action interception is available.
- Killing and restarting the coding agent preserves task state.
- Compatibility agents are never presented as fully governed.

### Phase 5 — Evidence Verifier and Deterministic Seal

Target: v0.5.1 beta.

- Support acceptance criteria of type `test`, `build`, `lint`, `runtime_probe`, `artifact`, `manual_review`, and `external_approval`.
- `icarus task verify` runs commands itself in the managed workspace and records:

  - Exact command and working directory.
  - Start/end timestamps and exit code.
  - Git SHA and worktree fingerprint.
  - Toolchain versions.
  - Bounded stdout/stderr plus complete local output file.
  - Output digest.
  - Files and artifacts produced.
  - Criterion satisfied or failed.

- Never accept model prose such as "tests pass" as verification.
- Automatically invalidate receipts when relevant files, contract criteria, environment fingerprints, or commands change.
- Seal only when:

  - Every required criterion has a current passing receipt.
  - Changed files remain in contract scope.
  - Required approvals exist and are unexpired.
  - The task has no unresolved high-risk issue.
  - The audit chain verifies.
  - The final diff and artifact receipt are stored.

- A failed seal returns structured unmet criteria and the next permissible action.
- Generate a concise final receipt suitable for a pull request or CI artifact.

Exit gate:

- A healthy repository check cannot substitute for a route-level criterion.
- Stale test evidence is rejected after relevant edits.
- A task with one missing criterion cannot seal.
- Sealed results reproduce from the exported receipt and commit.

### Phase 6 — Governed Self-Evolving Skills

Target: v0.5.2 beta/RC.

- Separate concepts clearly:

  - Persona profiles control optional memory-chat style.
  - Harness skills are verified operating procedures.
  - Existing persona files never become execution skills automatically.

- Remove ICARUS-owned LLM generation from the harness skill path. The coding agent calls `icarus_skill_propose` with a structured candidate derived from a sealed task.
- A skill contains triggers, instructions, allowed tools, policy requirements, verification steps, source tasks, decision references, risk, owner, version, confidence, proof dates, and replay results.
- Promotion pipeline:

  1. Validate schema and referenced sealed tasks.
  2. Scan for secrets and repo-specific leakage.
  3. Run required static checks.
  4. Replay against matching regression tasks in isolated worktrees.
  5. Compare success, tool count, token use when available, duration, and policy violations against baseline.
  6. Produce a signed evaluation result.
  7. Apply promotion policy.

- Default low-risk auto-promotion requires at least three independent sealed source runs, two successful replay tasks, no safety regression, and measurable improvement.
- High-risk skills—security, deployment, credentials, migrations, destructive operations, or external writes—always require owner approval.
- Demote after three applicable failures, an explicit safety violation, incompatible policy/schema change, or 30 days beyond its configured proof window.
- Retired skills remain auditable but cannot enter context packs.
- Move existing LLM-based `/skill create` and `connect-llm` behavior behind the optional memory-chat compatibility surface. It has no authority in managed tasks.

Exit gate:

- An unverified candidate cannot become active.
- Replaying a harmful or regressive candidate prevents promotion.
- A promoted skill always links to source tasks and evidence.
- Skill rollback and retirement work without deleting history.

### Phase 7 — Optional HIVE-MIND Organizational Authority

Target: v0.6.x.

- Keep every local lifecycle functional with no account or network.
- Add opt-in synchronization for:

  - Canonical organizational decisions.
  - Team-owned active skills.
  - Approval policies and approval tokens.
  - Redacted task receipts.
  - Cross-repository learning metadata.

- Bind user, organization, repository, project, worktree, task, and execution ID into every remote request.
- Cache decision and policy snapshots locally with authority, revision, expiry, and digest.
- Offline behavior:

  - Local work may continue under cached policy.
  - External actions requiring a remote approval cannot proceed offline.
  - Expired organizational policy produces `waiting_for_approval`, never silent fallback.

- Keep recall local by default. Fetch targeted decision references rather than exposing a broad shared tenant index.
- Never upload raw embeddings, credentials, complete transcripts, or unrestricted repository content through implicit synchronization.
- Provide `icarus sync inspect`, `icarus sync push`, and `icarus sync pull`; automatic background writes remain disabled unless policy explicitly enables them.

Exit gate:

- Disconnecting HIVE-MIND does not break local tasks.
- Cross-org and cross-project denial tests pass.
- Approval revocation is reflected before an external mutation.
- Sync conflicts create explicit competing revisions rather than last-write-wins loss.

### Phase 8 — Production Hardening and Open-Source Release Candidate

Target: v0.9.x.

- Migrate v0.3 users through `icarus migrate --dry-run` followed by explicit migration. Preserve `.amr` format and shard contents unchanged.
- Add schema migration fixtures from every public preview version. **Implemented:** the public
  `v0.3.*` corpus exercises the legacy graph contract for every published v0.3 tag and proves
  dry-run non-mutation, copy-only graph migration, and byte-for-byte shard preservation.
- Complete platform binaries for macOS ARM64/x64, Linux ARM64/x64, and Windows x64.
- Add:

  - Rust storage and property tests.
  - Node CLI/MCP contract tests.
  - Real PTY tests for TUI behavior. **Implemented:** a Rust portable-PTY integration starts the
    checked-in Node TUI under an actual pseudo-terminal and proves alternate-screen entry, raw
    interactive input, `/help`, and clean `/quit` on macOS and Linux CI.
  - Fake-agent adapter conformance tests.
  - Crash/restart tests for every task phase. **Implemented:** a child process dies after the
    task snapshot rename for every recoverable lifecycle state; a fresh process must repair the
    missing audit transition and continue through a legal next state.
  - Permission and path-escape tests.
  - Symlink, worktree, submodule, and nested-repository tests.
  - Secret-redaction tests.
  - HIVE-MIND cross-tenant tests.
  - Replay/promotion regression tests.
  - Installer/update rollback tests.

- Publish a threat model covering malicious repositories, prompt injection, compromised skills, tool escape, poisoned context, forged receipts, symlink traversal, and untrusted remote policy.
- Generate SBOMs, checksums, provenance attestations, and reproducible release receipts.
- Sign release assets and verify signatures during `/update`.
- Run a public beta corpus across multiple real Rust, JavaScript, Python, and mixed-language repositories.
- Add an adapter certification page showing tested agent versions and exact supported capabilities.
- Freeze schemas and public command behavior before the final release candidate.

Exit gate:

- No critical or high-severity unresolved security issue.
- Upgrade and rollback work from v0.3.46.
- All certified adapters pass the same conformance suite.
- Release artifacts are built from public source and independently verifiable.
- Documentation contains no private-monorepo-only instruction.

### Phase 9 — ICARUS Harness v1.0

Production status requires all of the following:

- At least Claude Code and Codex CLI are certified against the complete adapter contract.
- Cursor and generic MCP behavior are explicitly labeled compatibility mode.
- A task can be stopped in every lifecycle phase and resumed by a fresh agent process.
- Out-of-scope edits and unapproved external writes are rejected.
- No task seals without current evidence for every acceptance criterion.
- Context packs remain within budget and demonstrate at least 50% lower startup/context overhead on the published evaluation corpus without lower completion quality.
- ICARUS harness operations make zero LLM API calls, proven by network-isolated integration tests.
- Low-risk skill auto-promotion and high-risk approval-gated promotion both pass end-to-end tests.
- Local-only operation passes without HIVE-MIND credentials or network.
- Optional organizational synchronization passes isolation and revocation tests.
- Public CI, release provenance, installation, update, migration, rollback, security documentation, contributor workflow, and adapter documentation are all operational.
- A minimum 30-day release-candidate dogfood period completes with at least 100 managed tasks and no unresolved data-loss, scope-escape, false-seal, or cross-tenant incident.

After v1.0:

- Public schemas and commands follow semantic-versioning compatibility.
- New agents enter compatibility mode first and earn certification through the conformance suite.
- New skills enter `proposed` first and earn activation through evidence.
- The `.amr` engine remains the durable memory substrate; the harness remains the deterministic operating layer around replaceable coding models.

## Testing and Release Strategy

Each phase ships only after its own exit gate, using the Apex contract-first and evidence-chain discipline:

- Define lifecycle schemas and invariants before handlers.
- Implement shared logic once and expose it through CLI, TUI, and MCP adapters.
- Add failure-path tests before declaring a feature complete.
- Verify source, compiled binary, release asset digest, latest-release routing, installation, and cold-start execution.
- Publish evaluation fixtures and raw aggregate results so context and learning claims are reproducible.
- Never use a healthy process, an agent's prose, or a passing unrelated test as acceptance evidence.

## Assumptions and Defaults

- Apache-2.0 remains the license.
- The public repository becomes authoritative.
- `.amr` remains format-compatible; harness state is layered above it.
- Managed runs use isolated worktrees by default.
- HIVE-MIND is optional and adds organizational authority, not basic functionality.
- The agent's selected model performs all linguistic reasoning.
- Existing `/chat`, `/model`, and persona functionality may remain as an optional memory-chat compatibility surface, but never participates in task contracts, context compilation, verification, sealing, or skill promotion.
- Initial engineering estimate: approximately 18–24 focused engineer-weeks, with v0.4 preview after the first 6–8 weeks and v0.5 managed beta after roughly 12–16 weeks. Release gates, not dates, determine readiness.
