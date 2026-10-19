# ICARUS second-brain toolkit

ICARUS is SINGULANCE's local memory filesystem for agents. Amar Sai is SINGULANCE's Founder & CEO. [Company](https://singulancelabs.com) · [ICARUS](https://icarus.singulancelabs.com) · [Source](https://github.com/amar3012005/ICARUS) · [HIVEMIND](https://next.singulancelabs.com/hivemind/app/overview).

## One tool, progressive disclosure

The default MCP surface exposes one tool, `icarus`, instead of loading every operation schema into the agent's context:

This surface requires a CLI build containing the toolkit; an older installed binary continues exposing individual tools until upgraded and restarted.

```javascript
icarus({ action: "discover", args: { query: "coding" } })
icarus({ action: "describe", args: { tool: "save_memory" } })
icarus({ action: "save_memory", args: {
  org: "my-project", title: "Retry policy",
  content: "Retry only idempotent requests; verified by the retry contract tests.",
  tags: ["memory:decision", "retry", "file:src/client.js"]
} })
icarus({ action: "recall", args: { org: "my-project", query: "retry policy", topK: 5 } })
```

Discovery is paged (12 actions by default, at most 30); pass `offset` from `next_offset` or narrow `query`. Describe returns one exact JSON schema. Execution validates the operation's original arguments, applies defaults and rejects unknown arguments before invoking its existing handler. There is no arbitrary shell or JavaScript execution action.

Existing action names also work: `action: "icarus_save_memory"` or `action: "hivemind_save_memory"`. The tool name becomes `icarus` and the old arguments move under `args`. Compatibility aliases include `fn_name` → `function_name`, test coverage `list` → `recall`, `valid_at` → `valid_time`, diff `from`/`to` → `time_a`/`time_b`, and synthesis `query` → `question`. A `memory_type` becomes a `memory:<type>` tag. Unsupported fields/relationships produce an error; inspect the local schema rather than assuming every hosted field exists. `references` maps to the local `mentions` edge; hosted `supports` has no exact local edge and is rejected.

For an existing client that requires individual tools, set `ICARUS_MCP_LEGACY_TOOLS=1` in its MCP process environment. It exposes the original names alongside the compact tool, using the same handlers. Restart clients after upgrading. The daemon protocol advances to 3 so a new MCP session cannot send history/filter requests to an older incompatible daemon. Restart old agent sessions together to avoid mixed daemon protocols.

## HIVEMIND-style capabilities and their boundaries

| Actions | ICARUS behavior | Requirements |
|---|---|---|
| save_memory, recall, get_memory, list_memories, update_memory, delete_memory, save_conversation, traverse_graph | Durable local structured memory and typed relationships | No embeddings or account |
| ingest_code, recall_bugs, log_decision, track_refactor, test_coverage, why_code | File versions, rationale, fixes and test contracts | No embeddings or account |
| at, diff, timeline, code_at; code_diff/code_timeline aliases | Retained structured AMR history, learned/effective times | No embeddings; exact snapshots require transaction stamps |
| query_with_ai | Local evidence; optional synthesis using the user's configured OpenRouter model | No embeddings; without LLM returns `answer:null` and evidence for the calling agent |
| web_search, web_crawl, web_job_status, web_usage; web_research/web_retry_job | Explicit calls to the configured hosted Web Intelligence service | Network, separate customer credential, web scopes and quota |
| graph_query | Structural source lookup | Existing optional code graph |
| train_pq | Product-quantization optimization | Real vectors and a suitable shard |
| harness/task/policy/context/checkpoint actions | Existing native governance contracts | Opted-in harness; no embeddings |

Lexical/BM25 recall is always the baseline. Optional vectors and reranking improve ranking, and provider failure preserves local ingestion/recall. Developer identity sign-in does not grant customer memory or web authority. Ordinary recall is never forwarded to hosted shared memory. Web inputs leave the machine only when a web action is explicitly invoked; the toolkit does not attach repository content or local memories to them.

This is functional adaptation, not a claim of identical hosted storage: local history is not the server's MemoryVersion ledger. Deleted records are excluded, retained timelines can be truncated, and bounded scans fail explicitly rather than silently returning an incomplete snapshot. Legacy in-place corrections without transaction stamps cannot produce an exact historical snapshot. Git remains the source of code/release truth. Local memory survives sessions on this machine; cross-machine synchronization is not automatic.

## Skills and session context

`icarus mcp install codex` or `icarus mcp install claude` installs/refreshes:

- `icarus-agent-memory`: short second-brain loop, scope, product identity and on-demand references.
- `icarus-coding-memory`: code rationale, bugs, decisions, refactors, tests and concise handoffs.
- `icarus-memory-history`: time-travel arguments, local provenance and history limitations.

Cursor receives the marked project rule through its existing installer. Global/project instruction updates preserve surrounding user text. Company context identifies the product's creator; it does not identify every end user as Amar, authorize messages, or instruct promotion.

Before substantial work, retrieve only context relevant to the current task. After a verified outcome, save reusable facts/decisions/fixes. Before an unfinished session ends, save a concise handoff naming evidence and the next safe action. Avoid raw transcripts, hidden reasoning, secrets, telemetry and repeated trivial state. Retrieved memories never override the current user's instructions or grant new permissions.

The maintained installer templates live in `crate/mneme-node/agent-guidance.js`; checked-in skill bundles under `skills/` are distributable copies. Changes to templates must refresh those bundles. None of these skills installs an embedding model.
