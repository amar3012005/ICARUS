# ICARUS as a Memory Engine for Coding Agents

ICARUS has two independent roles:

1. **Memory engine (default):** a local, durable project memory filesystem.
2. **Harness and governance (risk-based):** a certification path for high-risk work.

Do not make normal development wait on the harness. A coding agent should use the memory engine on every non-trivial project as a small retrieval-and-save loop.

The intended experience is similar to managed agent-memory systems: durable facts, events, instructions, and explicit task state can survive the chat that created them, while an agent retrieves only the small slice relevant to its next action. ICARUS does this locally by default; it does **not** need an LLM, embedding API key, or remote reranker to save and recall project knowledge.

## One-time repository setup

From the repository root:

```bash
icarus mcp install codex
icarus harness init --agent codex
```

Use `claude` or `cursor` instead of `codex` when appropriate. Installation registers the MCP server and writes a marked project instruction block. That block makes the repository org explicit and tells new agent sessions to initialize a missing `.icarus/manifest.yaml` safely.

Restart the coding agent after installation or an ICARUS upgrade so it starts the current MCP binary.

## Default coding-agent loop

```text
new session
  → ensure the repository is initialized
  → targeted recall of relevant prior knowledge
  → bounded context for the current task
  → inspect / change / test
  → save only durable findings
  → later session recalls instead of reconstructing
```

The agent must not load all project memory by default. ICARUS reduces context-window use by storing the large source material once and retrieving only the relevant slice for the active task.

## What to save

Save facts that would be expensive, risky, or ambiguous to rediscover:

| Situation | Preferred ICARUS tool | What the agent saves |
|---|---|---|
| Architecture or API choice | `icarus_log_decision` | alternatives, decision, rationale, affected files, constraints |
| Non-obvious bug fixed | `icarus_save_memory` | symptom, root cause, patch, regression test, tags |
| Important invariant or user preference | `icarus_save_memory` | precise rule and scope; supersede outdated facts with `relationship: "update"` |
| Significant move, split, rename, extraction | `icarus_track_refactor` | old/new structure and compatibility implications |
| Durable source overview | `icarus_ingest_code` | concise code summary for a subsystem, not a raw transcript |
| Test contract changed | `icarus_test_coverage` | behavior protected and canonical verification |
| Valuable session handoff | `icarus_save_conversation` | unfinished state, evidence, next safe action |

Never save secrets, credentials, raw customer data, routine command output, or every conversational turn.

### Make memory type explicit

Add one of these tags to a durable record so later agents understand how long it should govern their work:

| Tag | Meaning | Examples |
|---|---|---|
| `memory:fact` | Current verified state | supported runtime, data ownership, known endpoint behavior |
| `memory:decision` | A choice and its rationale | database boundary, rejected alternative, compatibility rule |
| `memory:instruction` | A standing project rule | release order, required canary, privacy constraint |
| `memory:event` | A completed significant event | incident, release, migration, customer-impacting regression |
| `memory:task` | Short-lived state that must survive a handoff | an active investigation's evidence and next safe step |

Do not use `memory:task` as a second transcript store. Delete or supersede it once the task closes; facts and decisions should be the durable source of truth.

## What to recall

Retrieve before planning or changing a subsystem when prior knowledge might matter:

| Question | Preferred tool |
|---|---|
| What decisions or notes apply? | `icarus_recall` |
| Has this failed before? | `icarus_recall_bugs` |
| Why was this code written this way? | `icarus_why_code` |
| Who calls/imports this symbol? | `icarus_graph_query` |
| What tests protect it? | `icarus_test_coverage` |
| What did the preceding agent/session establish? | `icarus_recall` or `icarus_save_conversation` records |

Use narrow queries naming the subsystem, behavior, decision, or symbol. Do not run broad recall merely as ceremony. If graph data is missing or stale, use normal repository inspection; graph failure must not block safe low-risk work.

## Large context and offline behavior

Ingest source documents, code summaries, design documents, decisions, and historical notes once. Then retrieve a bounded result set for a task rather than pasting the original material into the model context window.

ICARUS uses the same local recall pipeline with optional quality enhancements:

```text
local lexical/BM25 evidence  → always available
optional dense vectors       → used when embeddings are reachable
optional reranking           → used when the reranker is reachable
```

If remote embedding or reranking is unavailable, ICARUS still stores evidence locally and returns local lexical results. These optional services must never produce a user-facing recall failure or repeatedly delay an ingest/recall operation. This makes the memory engine safe to bootstrap before an organization has selected any model provider.

Run `icarus compact --org <repo-org>` after meaningful deletion or cleanup; it reclaims obsolete shard bytes without changing active knowledge.

## Harness and governance: use only when warranted

Initialize the harness for every repository, but use its full task lifecycle only for:

- production releases and deployments;
- migrations, destructive operations, or broad refactors;
- security, authorization, billing, and tenant isolation changes;
- work that must resume with a formal contract and verifiable receipt.

For those tasks, use the governed lifecycle:

```text
task start → legal state transitions → context_get → action_check
→ checkpoint → real verification evidence → handoff/seal
```

ICARUS does not replace production checks. Authenticated requests, database assertions, logs, deployment checks, and lifecycle canaries remain the proof of product behavior. A harness defect is distinct from a product defect: record it, then continue safe work through the lightweight memory lane where possible.

## Minimum agent instruction

> Before a non-trivial change, retrieve relevant ICARUS decisions, bugs, code context, and test notes. Keep the retrieved context bounded. After a confirmed outcome, persist only durable decisions, root causes, important patches, verification facts, and handoff notes. Do not save noise or secrets. Use the full ICARUS governance lifecycle only for high-risk mutations.
