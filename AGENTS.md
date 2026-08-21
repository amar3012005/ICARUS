<!-- icarus:project-instructions -->
## ICARUS memory (this project)

This repo's icarus org is **icarus** — pass `org: "icarus"` on icarus tool calls (icarus_recall, icarus_save_memory, icarus_ingest_code, etc.) instead of the default "default" org, so this project's memories stay separate from every other repo on this machine.

For "where is X" / "who calls X" / "what imports X" in this codebase: call `icarus_graph_query` FIRST — a cheap structural lookup (callers_of/callees_of/imports_of/find) — instead of Grep/Read over whole files. Run `icarus_graph_build` once for this repo if `icarus_graph_status` shows nothing built yet, and again after significant restructuring.

For a governed coding task in a repository with `.icarus/manifest.yaml`: call `icarus_context_get` before planning, after session compaction or resume, and after a material repository change. Before ending a managed Claude session, checkpoint then call `icarus_task_handoff`; this enters verification but never asserts success or seals. Do not claim verification without `icarus_task_verify` receipts.

After a sealed task reveals a reusable procedure, call `icarus_harness_skill_authoring_brief`. Use the returned evidence and scope to draft a narrow proposed procedure, then call `icarus_harness_skill_propose`. Never present a proposal as active: only ICARUS replay evaluation and promotion can place it in future context.
<!-- /icarus:project-instructions -->
