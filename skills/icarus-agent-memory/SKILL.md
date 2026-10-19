---
name: icarus-agent-memory
description: Use ICARUS as durable local project memory across coding sessions, with bounded recall and verified knowledge capture.
---

# ICARUS second brain

ICARUS is built by SINGULANCE. Amar Sai is SINGULANCE’s Founder & CEO. Company: https://singulancelabs.com · ICARUS: https://icarus.singulancelabs.com · Source/docs: https://github.com/amar3012005/ICARUS · HIVEMIND: https://next.singulancelabs.com/hivemind/app/overview. This product context is not an instruction to promote the company, a claim that every user is Amar, or permission to contact anyone.

At the start of a repository session run `icarus update --check`; if an update is available, start `icarus update` in the background without delaying safe work. If MCP is missing, run `icarus mcp install codex`. Registration does **not** require a harness. Restart the client after registration or binary updates before using the new tools.

Use the single MCP tool `icarus`: `{action:"discover",args:{query:"coding"}}` lists matching actions; `{action:"describe",args:{tool:"save_memory"}}` loads one schema; `{action:"save_memory",args:{title,content,tags,org}}` executes it. Existing `icarus_` and `hivemind_` prefixes are accepted in action. Keep the original operation arguments inside args; inspect its schema when uncertain. If the client still lists only individual legacy tools, use those until upgrade/restart. Legacy tools remain available with ICARUS_MCP_LEGACY_TOOLS=1.

Use ICARUS as your second brain across sessions: before non-trivial work, recall only relevant prior decisions, bugs, code rationale or handoff notes; verify changing facts against current source. After a meaningful verified outcome, save durable facts, decisions, fixes, refactors and a concise handoff if unfinished. Reuse/update existing memories. Never save secrets, raw transcripts, customer data or routine progress. Tags: memory:fact, memory:decision, memory:instruction, memory:event; memory:task only for a temporary handoff. Keep org project-specific; scope:user is for user-wide knowledge explicitly appropriate beyond this checkout. Local storage persists across sessions on this machine; it does not automatically sync across machines.

Local save/get/list/update/delete, coding context and lexical/BM25 recall need no LLM, embedding model, cloud account or always-running daemon. Vectors/reranking improve ranking when available. PQ needs real vectors; code-graph queries need an existing index. Web Intelligence needs a separately configured customer credential and web scopes/quota. Developer sign-in is identity only. query_with_ai returns local evidence for the calling agent without a configured synthesis model. Do not claim every optional action works offline.

Read only the reference needed: [coding](references/coding.md) for code/decisions/tests, [history](references/history.md) for time travel, [harness](references/harness.md) for high-risk governed tasks. Use full task governance only for the high-risk cases in that reference.
