# Local time travel

Discover history actions; describe only the one needed. timeline(memory_id? / file_path? / query?, org) follows retained local Updates chains. at(transaction_time? / valid_time?, filters) and code_at(file_path, transaction_time? / valid_time?) distinguish when ICARUS learned something from when it was true. diff(time_a,time_b,filters) compares snapshots. ISO timestamps include a timezone. Aliases valid_at, from/to and code_diff/code_timeline are accepted by the meta toolkit.

History is from local structured AMR records, not HIVEMIND’s hosted MemoryVersion ledger or a replacement for Git. Old corrections missing transaction stamps return an explicit limitation for exact snapshots. Deleted content stays excluded. Inspect history_complete and truncated; raise the explicit bounded max_records only when necessary. Never invent missing history or silently substitute current content for an old snapshot. No embeddings needed.
