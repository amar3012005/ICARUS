<!-- icarus:project-instructions -->
## ICARUS memory (this project)

This repo's icarus org is **icarus** — pass `org: "icarus"` on icarus tool calls (icarus_recall, icarus_save_memory, icarus_ingest_code, etc.) instead of the default "default" org, so this project's memories stay separate from every other repo on this machine.

### Mandatory first-session bootstrap

At the beginning of **every new agent session** in this repository, before code search, planning, edits, or implementation answers: check for `.icarus/manifest.yaml`. If it is absent, call `icarus_harness_init` with this repository root (or run `icarus harness init --repo <repo-root>`) exactly once. Treat an initialization failure as a blocker: do not invent harness state or manually write `.icarus`. If the graph is absent or stale, call `icarus_graph_build`. For every coding task, call `icarus_context_get` before planning once a task exists. Do not silently skip ICARUS because it is inconvenient.

For "where is X" / "who calls X" / "what imports X" in this codebase: call `icarus_graph_query` FIRST — a cheap structural lookup (callers_of/callees_of/imports_of/find) — instead of Grep/Read over whole files. Run `icarus_graph_build` once for this repo if `icarus_graph_status` shows nothing built yet, and again after significant restructuring.

For a governed coding task in a repository with `.icarus/manifest.yaml`: call `icarus_context_get` before planning, after session compaction or resume, and after a material repository change. Before ending a managed Claude session, checkpoint then call `icarus_task_handoff`; this enters verification but never asserts success or seals. Do not claim verification without `icarus_task_verify` receipts.

After a sealed task reveals a reusable procedure, call `icarus_harness_skill_authoring_brief`. Use the returned evidence and scope to draft a narrow proposed procedure, then call `icarus_harness_skill_propose`. Never present a proposal as active: only ICARUS replay evaluation and promotion can place it in future context.

After a sealed task has a verified decision or lesson worth retrieving later, call `icarus_harness_learning_capture`. Review its receipt-bound evidence and author a concise factual structured memory, then call `icarus_harness_learning_capture_approve` with the returned capture digest and `org: "icarus"`. Never treat a capture as saved until the approval call returns its local AMR memory id; unreviewed model prose must not enter ICARUS memory.
<!-- /icarus:project-instructions -->
