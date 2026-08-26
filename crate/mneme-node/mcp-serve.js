'use strict';
// icarus MCP server — exposes the same operations as the CLI (icarus ingest/recall/status/
// train-pq) as MCP tools over stdio, so any MCP-capable coding agent (Claude Code, Codex,
// Cursor, ...) can call them directly. No Docker, no port, no network: this is a plain local
// process the agent launches itself via `command: "icarus", args: ["mcp-serve"]` — the exact
// same mechanism every filesystem/git MCP server uses.
//
// Deliberately thin: every tool handler calls straight into cli-lib.js, the SAME module
// mneme-cli.js uses — so a fix or behavior change made for the CLI is automatically visible
// here too, not a second copy that silently drifts.
//
// Tool descriptions here are deliberately written in HIVEMIND's own directive style ("Use
// when...", "Call FIRST...") rather than plain capability statements. Real reason, not
// cosmetic: an MCP client picks a tool by matching the user's request against each tool's
// description at inference time — a description that only states WHAT a tool does gets picked
// far less reliably than one that also states WHEN to reach for it. This is the actual lever
// for "does the agent start using icarus on its own", not the tool's name.
//
// Structured memory tools (icarus_save_memory/get/list/update/delete/traverse_graph) are the
// AGENT-facing surface — matching HIVEMIND's own hivemind_save_memory schema exactly
// (title/content/tags/source_type/relationship/related_to) on purpose: the calling agent IS the
// LLM here, and fills that schema in thoughtfully the same way it would for hivemind_save_memory
// server-side. icarus does no entity/relationship extraction of its own — it just stores what
// the agent already decided, real typed edges (native addEdge()) and all. That's different from
// icarus_save's own /save-equivalent path (raw text, no schema) — a human typing in the TUI has
// nothing to fill a schema with.
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  loadCfg,
  hivemindConfigured, hivemindIngestDir, hivemindSaveMemory,
} = require('./cli-lib.js');
const { callMemory } = require('./daemon-client.js');

function textResult(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}
function errorResult(err) {
  return { content: [{ type: 'text', text: `Error: ${err.message || String(err)}` }], isError: true };
}

const RELATIONSHIP_ENUM = z.enum(['update', 'extend', 'derive', 'contradict', 'partof', 'mentions']);
const RELATIONSHIP_ENUM_WITH_ALL = z.enum(['update', 'extend', 'derive', 'contradict', 'partof', 'mentions', 'all']);

async function run() {
  const server = new McpServer({ name: 'icarus', version: '1.0.0' });
  const memoryCall = (operation, args) => callMemory(operation, args, loadCfg());

  server.registerTool(
    'icarus_status',
    {
      title: 'ICARUS status',
      description: 'Use to check what ICARUS already knows before deciding whether to ingest/recall — lists every org shard on this machine and its disk usage. Call when the user asks "what does icarus have stored" or you need to confirm an org exists before writing to it.',
      inputSchema: {},
    },
    async () => {
      try { return textResult(await memoryCall('status', {})); } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_ingest',
    {
      title: 'Ingest a folder into ICARUS',
      description: 'Use when the user points at a folder/file of documents (pdf/docx/pptx/images/audio/txt/md) and wants it searchable — NOT for a single fact or decision (use icarus_save_memory for that instead). Extracts and stores files under a directory into an org\'s memory shard. If icarus connect has a HIVEMIND token, routes through HIVEMIND\'s real hosted API instead -- accepts everything that server supports, a much broader set than the local engine\'s text-only formats -- set local=true to force the local .amr engine even when connected (text-only: txt/md/json/csv/log). By default, segment text processed by HIVEMIND is also pulled back and re-embedded + stored in the LOCAL shard (mirrorLocal=false to skip and leave it purely server-side) -- the server never exposes its own embedding vectors over HTTP, so this is cloud chunking + local re-embedding, not cloud embedding. HIVEMIND is used as a stateless extraction PIPELINE only: once segments are mirrored locally, the document icarus itself just created server-side is deleted (purgeCloud=false to skip and leave it there) -- a pre-existing duplicate found server-side is never deleted, only what this run itself created.',
      inputSchema: {
        dir: z.string().describe('Absolute path to the directory to ingest'),
        org: z.string().default('default').describe('Org/shard name to store into'),
        local: z.boolean().default(false).describe('Force the local .amr engine even if a HIVEMIND token is configured'),
        force: z.boolean().default(false).describe('Matches the real FE\'s own "force" field (bypass the same-checksum dedup gate) -- not yet read server-side, sent to match the real upload contract exactly'),
        mirrorLocal: z.boolean().default(true).describe('When routed through HIVEMIND, also pull back the processed segment text and store it (re-embedded) in the local .amr shard. Set false to leave data purely server-side.'),
        purgeCloud: z.boolean().default(true).describe('After mirroring locally, delete the HIVEMIND document this run itself created (never a pre-existing duplicate). Set false to leave it server-side.'),
      },
    },
    async ({ dir, org, local, force, mirrorLocal, purgeCloud }) => {
      try {
        const cfg = loadCfg();
        if (hivemindConfigured(cfg) && !local) {
          return textResult(await memoryCall('ingest_hivemind', { dir, org: org || 'default', options: { force: !!force, mirrorLocal: mirrorLocal !== false, purgeCloud: purgeCloud !== false } }));
        }
        return textResult(await memoryCall('ingest', { dir, org: org || 'default' }));
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_recall',
    {
      title: 'Recall memories and evidence from ICARUS',
      description: 'Use when prior project knowledge could materially affect the answer or implementation: a past decision, preference, incident, code rationale, or ingested evidence. Do not broad-recall for greetings, routine status, or a self-contained small edit. LOCAL ONLY, always -- never routes to HIVEMIND\'s shared /api/recall (a real cross-tenant leak was found there in testing). Dense (HNSW, when a bounded auxiliary embedding is available) and lexical (BM25) retrieval merge via Reciprocal Rank Fusion; a connected bge-reranker-v2-m3 may narrow-rescore that local result. Provider failure or timeout silently leaves the local lexical/RRF result intact; ingestion and recall never fail because vectors or reranking are unavailable. Automatically excludes superseded memories (anything replaced via relationship:"update" or icarus_update_memory) -- only the latest version of a corrected fact surfaces. Note: there is deliberately no separate "AI-powered synthesis" recall tool here (unlike hivemind_query_with_ai) -- the calling agent already IS the reasoning layer; call this for raw grounded results, then reason over them directly.',
      inputSchema: {
        query: z.string().describe('Natural-language query'),
        org: z.string().default('default'),
        topK: z.number().int().positive().max(200).default(5),
        usePq: z.boolean().default(false).describe('Use PQ/ADC recall instead of the default hybrid recall — requires icarus_train_pq to have run first for this org'),
      },
    },
    async ({ query, org, topK, usePq }) => {
      try {
        const cfg = loadCfg();
        const hits = await memoryCall('recall', { query, org: org || 'default', topK: topK || 5, usePq: !!usePq });
        return textResult(hits);
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_save',
    {
      title: 'Save raw text as a local memory',
      description: 'Use for a quick, unstructured save when you have plain text and no real title/tags/relationship to attach -- for anything with real structure (a fact worth tagging, a decision, a relationship to an existing memory), use icarus_save_memory instead, which matches HIVEMIND\'s own schema and supports real typed relationships. LOCAL ONLY by default -- never touches HIVEMIND\'s cloud memory box on its own. Set cloud=true to also create a real, permanent HIVEMIND memory (mode:\'atomic\') -- still mirrored locally either way, so icarus_recall keeps working regardless.',
      inputSchema: {
        text: z.string().describe('The memory content to save'),
        org: z.string().default('default'),
        cloud: z.boolean().default(false).describe('Also create a real, permanent memory in HIVEMIND\'s cloud (mode:\'atomic\') -- opt-in, off by default'),
      },
    },
    async ({ text, org, cloud }) => {
      try {
        const cfg = loadCfg();
        if (hivemindConfigured(cfg) && cloud) {
          const r = await hivemindSaveMemory(text, org || 'default', cfg);
          await memoryCall('save_raw', { text, org: org || 'default', options: { viaCloud: true } }); // mirror — icarus_recall is local-only
          return textResult(r);
        }
        await memoryCall('save_raw', { text, org: org || 'default' });
        return textResult({ ok: true, org: org || 'default', mode: 'local' });
      } catch (e) { return errorResult(e); }
    },
  );

  // ── Structured memory tools (agent-facing, HIVEMIND schema parity) ────────────────────────

  server.registerTool(
    'icarus_save_memory',
    {
      title: 'Save a fact, decision, or preference to persistent memory',
      description: 'Use when the user shares a fact, preference, decision, code snippet, or anything worth remembering across sessions. Always tag with 2-5 specific tags for precise future retrieval. When a fact CHANGES (not a new, separate fact — the same thing corrected or superseded), set relationship:"update" and related_to:<the old memory\'s id> instead of just saving a duplicate — the old one is marked superseded and excluded from future icarus_recall results automatically, while icarus_traverse_graph can still walk the history. LOCAL ONLY -- never touches HIVEMIND\'s cloud memory box.',
      inputSchema: {
        title: z.string().describe('Short descriptive title'),
        content: z.string().describe('The content to remember'),
        tags: z.array(z.string()).default([]).describe('Topic tags, e.g. ["react","api-design"]'),
        source_type: z.enum(['text', 'code', 'conversation', 'documentation', 'decision']).optional(),
        org: z.string().default('default'),
        project: z.string().optional().describe('Project this belongs to'),
        relationship: RELATIONSHIP_ENUM.optional().describe('Real typed edge to an existing memory -- update|extend|derive|contradict|partof|mentions. "update" also marks the target superseded (excluded from future recall).'),
        related_to: z.string().optional().describe('Memory id this relates to -- required together with relationship'),
      },
    },
    async ({ title, content, tags, source_type, org, project, relationship, related_to }) => {
      try {
        const cfg = loadCfg();
        const r = await memoryCall('save_structured', { content, org: org || 'default', options: {
          title, tags, sourceType: source_type, project, relationship, relatedTo: related_to,
        } });
        return textResult(r);
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_get_memory',
    {
      title: 'Get full memory by id',
      description: 'Use when you have a memory id (from icarus_save_memory, icarus_recall\'s memoryId field, or icarus_list_memories) and need the complete stored record, not just the recall snippet.',
      inputSchema: { memory_id: z.string().describe('The memory id'), org: z.string().default('default') },
    },
    async ({ memory_id, org }) => {
      try {
        const cfg = loadCfg();
        const rec = await memoryCall('get_structured', { memory_id, org: org || 'default' });
        if (!rec) return errorResult(new Error(`no live memory with id "${memory_id}" in org "${org || 'default'}"`));
        return textResult(rec);
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_list_memories',
    {
      title: 'Browse memories with filters',
      description: 'Use when the user asks "show me my memories about X" or wants to browse rather than search semantically. Only lists structured memories saved via icarus_save_memory (plain /save text and ingest evidence aren\'t tag-indexed) -- use icarus_recall for semantic search over everything.',
      inputSchema: {
        tags: z.array(z.string()).default([]).describe('AND-filter -- only memories carrying every listed tag'),
        org: z.string().default('default'),
        limit: z.number().int().positive().max(100).default(20),
        include_superseded: z.boolean().default(false).describe('Include memories that were superseded by a relationship:"update"'),
      },
    },
    async ({ tags, org, limit, include_superseded }) => {
      try {
        const cfg = loadCfg();
        const list = await memoryCall('list_structured', { org: org || 'default', options: { tags, limit: limit || 20, includeSuperseded: !!include_superseded } });
        return textResult(list);
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_update_memory',
    {
      title: 'Correct or modify a stored memory',
      description: 'Use when a stored fact is OUTDATED and needs correction IN PLACE (same memory id, history preserved via a real typed edge) -- for a genuinely NEW, separate fact that happens to relate to an old one, use icarus_save_memory with relationship:"update" instead, which creates a new memory rather than editing this one.',
      inputSchema: {
        memory_id: z.string().describe('Memory id to update'),
        content: z.string().optional().describe('New content (re-embedded if provided)'),
        title: z.string().optional().describe('New title'),
        tags: z.array(z.string()).optional().describe('New tags (replaces existing entirely)'),
        org: z.string().default('default'),
      },
    },
    async ({ memory_id, content, title, tags, org }) => {
      try {
        const cfg = loadCfg();
        const r = await memoryCall('update_structured', { memory_id, patch: { content, title, tags }, org: org || 'default' });
        return textResult(r);
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_delete_memory',
    {
      title: 'Permanently delete a memory',
      description: 'Use ONLY when the user explicitly asks to forget something. Deletion is permanent (tombstoned in the shard) -- there is no undo.',
      inputSchema: {
        memory_id: z.string().describe('Memory id to delete'),
        reason: z.string().optional().describe('Reason for deletion (audit-trail only, never sent anywhere)'),
        org: z.string().default('default'),
      },
    },
    async ({ memory_id, reason, org }) => {
      try {
        const cfg = loadCfg();
        return textResult(await memoryCall('delete_structured', { memory_id, reason, org: org || 'default' }));
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_save_conversation',
    {
      title: 'Save a conversation summary to memory',
      description: 'Use at the end of a meaningful conversation. Summarize -- don\'t dump the raw transcript verbatim; you are the LLM here, condense it yourself before calling this.',
      inputSchema: {
        title: z.string().describe('Conversation topic'),
        messages: z.array(z.object({ role: z.string(), content: z.string() })).describe('Array of {role, content} -- a summary, not a full transcript'),
        tags: z.array(z.string()).default([]),
        platform: z.enum(['claude', 'cursor', 'chatgpt', 'other']).optional(),
        org: z.string().default('default'),
      },
    },
    async ({ title, messages, tags, platform, org }) => {
      try {
        const cfg = loadCfg();
        const content = messages.map((m) => `${m.role}: ${m.content}`).join('\n');
        const r = await memoryCall('save_structured', { content, org: org || 'default', options: {
          title, tags: [...tags, 'conversation', ...(platform ? [`platform:${platform}`] : [])], sourceType: 'conversation',
        } });
        return textResult(r);
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_traverse_graph',
    {
      title: 'Walk relationships from a seed memory',
      description: 'Use when the user asks "what\'s related to X" or "what changed" -- BFS walk from a seed memory along real typed edges (update/extend/derive/contradict/partof/mentions), native to the .amr engine, exact HIVEMIND traverse_graph parity. Omit relationship (or pass "all") to walk every edge type and union the results.',
      inputSchema: {
        memory_id: z.string().describe('Seed memory id'),
        relationship: RELATIONSHIP_ENUM_WITH_ALL.default('all'),
        depth: z.number().int().min(1).max(5).default(2),
        org: z.string().default('default'),
      },
    },
    async ({ memory_id, relationship, depth, org }) => {
      try {
        const cfg = loadCfg();
        return textResult(await memoryCall('traverse_structured', { memory_id, org: org || 'default', options: { relationship, depth } }));
      } catch (e) { return errorResult(e); }
    },
  );

  // ── Coding-intelligence tools ──────────────────────────────────────────────────────────────

  server.registerTool(
    'icarus_ingest_code',
    {
      title: 'Save a code file/snippet — auto-links to prior version',
      description: 'Call after writing or significantly modifying a file. Auto-detects a prior memory tagged file:<path> and sets an UPDATE relationship to it automatically, building a real version chain (native typed edge, walkable via icarus_traverse_graph) instead of duplicates.',
      inputSchema: {
        file_path: z.string().describe('Path to the file, e.g. src/auth/middleware.ts'),
        content: z.string().describe('Full file content or relevant snippet'),
        summary: z.string().optional().describe('Human-readable summary (1-3 sentences)'),
        project: z.string().optional(),
        tags: z.array(z.string()).default([]),
        org: z.string().default('default'),
      },
    },
    async ({ file_path, content, summary, project, tags, org }) => {
      try {
        const cfg = loadCfg();
        const fileTag = `file:${file_path}`;
        const prior = (await memoryCall('list_structured', { org: org || 'default', options: { tags: [fileTag], limit: 1 } }))[0];
        const body = summary ? `${summary}\n\n${content}` : content;
        const r = await memoryCall('save_structured', { content: body, org: org || 'default', options: {
          title: file_path, tags: [...tags, 'code', fileTag], sourceType: 'code', project,
          ...(prior ? { relationship: 'update', relatedTo: prior.id } : {}),
        } });
        return textResult({ ...r, previousVersion: prior ? prior.id : null });
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_recall_bugs',
    {
      title: 'Recall past bugs/fixes/gotchas BEFORE writing code',
      description: 'Call before writing code in an area to avoid repeating known bugs. Filters recall to entries tagged bug, fix, or gotcha -- only memories YOU (or a prior session) explicitly tagged that way, not a fuzzy guess.',
      inputSchema: {
        context: z.string().describe('What you are about to implement, or the error you are seeing'),
        file_path: z.string().optional().describe('File currently being edited -- narrows to entries also tagged file:<path>'),
        limit: z.number().int().positive().max(20).default(5),
        org: z.string().default('default'),
      },
    },
    async ({ context, file_path, limit, org }) => {
      try {
        const cfg = loadCfg();
        const hits = await memoryCall('recall_by_tags', { query: context, org: org || 'default', options: {
          requireAnyTags: ['bug', 'fix', 'gotcha'],
          requireAllTags: file_path ? [`file:${file_path}`] : [],
          limit: limit || 5,
        } });
        return textResult(hits);
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_log_decision',
    {
      title: 'Save an architectural/technical decision permanently',
      description: 'Call when choosing between options (library, algorithm, API design). Stores as a tagged decision memory with structured alternatives + affected_files. Future sessions recall it via icarus_why_code.',
      inputSchema: {
        title: z.string().describe('Short decision title'),
        decision: z.string().describe('What was decided'),
        rationale: z.string().describe('Why this decision'),
        alternatives: z.array(z.string()).default([]).describe('Options considered but rejected'),
        affected_files: z.array(z.string()).default([]),
        project: z.string().optional(),
        tags: z.array(z.string()).default([]),
        related_to: z.string().optional().describe('Memory id of an earlier related decision'),
        org: z.string().default('default'),
      },
    },
    async ({ title, decision, rationale, alternatives, affected_files, project, tags, related_to, org }) => {
      try {
        const cfg = loadCfg();
        const parts = [`Decision: ${decision}`, `Rationale: ${rationale}`];
        if (alternatives.length) parts.push(`Alternatives considered: ${alternatives.join('; ')}`);
        if (affected_files.length) parts.push(`Affected files: ${affected_files.join(', ')}`);
        const r = await memoryCall('save_structured', { content: parts.join('\n'), org: org || 'default', options: {
          title, tags: [...tags, 'decision', ...affected_files.map((f) => `file:${f}`)],
          sourceType: 'decision', project,
          ...(related_to ? { relationship: 'derive', relatedTo: related_to } : {}),
        } });
        return textResult(r);
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_track_refactor',
    {
      title: 'Record a rename / move / split / merge / extract',
      description: 'Call after significant restructuring so future sessions understand how code evolved. Creates a real DERIVE typed edge between old and new when related_to is given.',
      inputSchema: {
        refactor_type: z.enum(['rename', 'move', 'split', 'merge', 'restructure', 'extract']),
        old_name: z.string().describe('Original name/path/identifier'),
        new_name: z.string().describe('New name/path/identifier'),
        reason: z.string().describe('Why this refactoring was done'),
        affected_files: z.array(z.string()).default([]),
        project: z.string().optional(),
        related_to: z.string().optional().describe('Memory id of the original code memory'),
        org: z.string().default('default'),
      },
    },
    async ({ refactor_type, old_name, new_name, reason, affected_files, project, related_to, org }) => {
      try {
        const cfg = loadCfg();
        const content = `${refactor_type}: "${old_name}" -> "${new_name}"\nReason: ${reason}${affected_files.length ? `\nAffected files: ${affected_files.join(', ')}` : ''}`;
        const r = await memoryCall('save_structured', { content, org: org || 'default', options: {
          title: `${refactor_type}: ${old_name} -> ${new_name}`,
          tags: ['refactor', refactor_type, ...affected_files.map((f) => `file:${f}`)],
          sourceType: 'code', project,
          ...(related_to ? { relationship: 'derive', relatedTo: related_to } : {}),
        } });
        return textResult(r);
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_test_coverage',
    {
      title: 'Save / recall test coverage for a function or module',
      description: 'action=save records which functions have tests (and what those tests cover). action=recall retrieves coverage BEFORE modifying code so you know what tests must still pass.',
      inputSchema: {
        action: z.enum(['save', 'recall']),
        function_name: z.string().describe('Function, class, or module name'),
        file_path: z.string().optional(),
        test_file: z.string().optional().describe('Path to test file (save action)'),
        test_cases: z.array(z.string()).default([]).describe('Test case descriptions (save action)'),
        coverage_pct: z.number().optional(),
        project: z.string().optional(),
        org: z.string().default('default'),
      },
    },
    async ({ action, function_name, file_path, test_file, test_cases, coverage_pct, project, org }) => {
      try {
        const cfg = loadCfg();
        const fnTag = `fn:${function_name}`;
        if (action === 'save') {
          const parts = [`Test coverage for ${function_name}`];
          if (test_file) parts.push(`Test file: ${test_file}`);
          if (test_cases.length) parts.push(`Cases: ${test_cases.join('; ')}`);
          if (coverage_pct != null) parts.push(`Coverage: ${coverage_pct}%`);
          const r = await memoryCall('save_structured', { content: parts.join('\n'), org: org || 'default', options: {
            title: `test-coverage: ${function_name}`,
            tags: ['test-coverage', fnTag, ...(file_path ? [`file:${file_path}`] : [])],
            sourceType: 'code', project,
          } });
          return textResult(r);
        }
        const hits = await memoryCall('recall_by_tags', { query: function_name, org: org || 'default', options: { requireAnyTags: ['test-coverage'], requireAllTags: [fnTag], limit: 5 } });
        return textResult(hits);
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_why_code',
    {
      title: 'Why does this code exist / work this way?',
      description: 'Call before modifying code you did not write or do not remember the context for. Returns relevant decisions, refactors, bug fixes, and code references, categorised into buckets by tag.',
      inputSchema: {
        query: z.string().describe('What you want to understand'),
        file_path: z.string().optional(),
        function_name: z.string().optional(),
        limit: z.number().int().positive().max(20).default(8),
        org: z.string().default('default'),
      },
    },
    async ({ query, file_path, function_name, limit, org }) => {
      try {
        const cfg = loadCfg();
        const requireAllTags = [
          ...(file_path ? [`file:${file_path}`] : []),
          ...(function_name ? [`fn:${function_name}`] : []),
        ];
        const wide = requireAllTags.length
          ? await memoryCall('recall_by_tags', { query, org: org || 'default', options: { requireAllTags, limit: limit || 8 } })
          : (await memoryCall('recall', { query, org: org || 'default', topK: limit || 8, usePq: false }));
        const buckets = { decisions: [], refactors: [], bugs: [], other: [] };
        for (const h of wide) {
          const tags = h.tags || [];
          if (tags.includes('decision')) buckets.decisions.push(h);
          else if (tags.includes('refactor')) buckets.refactors.push(h);
          else if (tags.some((t) => ['bug', 'fix', 'gotcha'].includes(t))) buckets.bugs.push(h);
          else buckets.other.push(h);
        }
        return textResult(buckets);
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_train_pq',
    {
      title: 'Train PQ codebook for an org',
      description: 'Use only when recall latency on a large, frequently-rebuilt shard actually matters -- NOT a universal upgrade. Real, measured tradeoff: PQ builds much faster than the default index always, and queries FASTER only on small/medium shards -- on large shards PQ queries SLOWER than the default at equal recall. Good fit: shards you rebuild often. Blocks for its full duration (k-means over every live vector) -- call it after a bulk ingest, not per-request.',
      inputSchema: {
        org: z.string().default('default'),
        seed: z.number().int().default(42).describe('Deterministic training seed'),
      },
    },
    async ({ org, seed }) => {
      try {
        const cfg = loadCfg();
        return textResult(await memoryCall('train_pq', { org: org || 'default', seed: seed ?? 42 }));
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_compact',
    {
      title: 'Compact an org shard',
      description: 'Use periodically after heavy delete/update/ingest activity on an org -- reclaims dead bytes from tombstoned/rewritten memories (the engine is append-only, so space is never reclaimed automatically).',
      inputSchema: { org: z.string().default('default') },
    },
    async ({ org }) => {
      try {
        const cfg = loadCfg();
        return textResult(await memoryCall('compact', { org: org || 'default' }));
      } catch (e) { return errorResult(e); }
    },
  );

  // ── Rust-governed harness lifecycle ──────────────────────────────────────────────────────
  // The coding agent supplies objectives, plans, and checkpoint summaries. ICARUS only enforces
  // durable state and authorization; it never invokes a model or invents task content.
  const taskContractSchema = z.object({
    allowed_paths: z.array(z.string()).min(1),
    forbidden_paths: z.array(z.string()).default([]),
    acceptance_criteria: z.array(z.unknown()).default([]),
    risk: z.string(),
    budgets: z.record(z.unknown()).default({}),
    authority: z.string(),
    external_write_policy: z.string(),
  });
  const harnessFor = () => require('./harness.js');

  server.registerTool(
    'icarus_harness_init',
    {
      title: 'Initialize the ICARUS harness for this repository',
      description: 'Call at the start of every new coding-agent session before code search, planning, or edits when <repo>/.icarus/manifest.yaml is absent. It creates the tracked repository identity and policy exactly once; repeated calls are idempotent and report the existing harness. Do not manually invent or write .icarus state if this fails.',
      inputSchema: { repo: z.string().default(process.cwd()), agents: z.array(z.string()).default([]).describe('Optional adapter instruction targets, for example ["claude"] or ["codex"].') },
    },
    async ({ repo, agents }) => {
      try { return textResult(harnessFor().initHarness(repo, { agents: agents || [] })); } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_task_start',
    {
      title: 'Start a governed ICARUS coding task',
      description: 'Call before the first managed code write. The calling agent writes the objective and explicit contract; ICARUS persists an immutable v1 contract and returns task_id plus execution_id. This tool makes no LLM or network call.',
      inputSchema: { repo: z.string().default(process.cwd()), objective: z.string(), contract: taskContractSchema },
    },
    async ({ repo, objective, contract }) => {
      try { return textResult(harnessFor().startTask(repo, { objective, contract })); } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_task_status',
    {
      title: 'Read a governed task state',
      description: 'Call after compaction, interruption, or before resuming a governed coding task. Returns the durable task, immutable contract version, execution attempt, and current state from the Rust harness.',
      inputSchema: { repo: z.string().default(process.cwd()), task_id: z.string() },
    },
    async ({ repo, task_id }) => {
      try { return textResult(harnessFor().taskStatus(repo, task_id)); } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_task_transition',
    {
      title: 'Advance a governed ICARUS task through its durable lifecycle',
      description: 'Call after icarus_task_start to move a task through created → orienting → contracted → planned → executing. Before the first managed code write, the task MUST be executing; use this tool one legal state at a time. Rust validates every transition and records the audit event, so this cannot bypass policy or jump from created directly to executing.',
      inputSchema: {
        repo: z.string().default(process.cwd()),
        task_id: z.string(),
        target: z.enum(['orienting', 'contracted', 'planned', 'executing', 'verifying', 'waiting_for_approval', 'blocked', 'failed', 'sealed']),
      },
    },
    async ({ repo, task_id, target }) => {
      try { return textResult(harnessFor().transitionTask(repo, task_id, target)); } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_action_check',
    {
      title: 'Check whether a task action is authorized',
      description: 'Call immediately before a managed write. Rejects writes outside the executing task contract, forbidden paths, absolute paths, and writes attempted before execution. Do not bypass a denial with a shell command.',
      inputSchema: { repo: z.string().default(process.cwd()), task_id: z.string(), kind: z.string().default('write'), path: z.string().optional() },
    },
    async ({ repo, task_id, kind, path: actionPath }) => {
      try {
        const harness = harnessFor();
        const decision = harness.authorizeAction(repo, task_id, { kind, path: actionPath });
        const task = harness.taskStatus(repo, task_id);
        return textResult({ task_id: task.task_id, execution_id: task.execution_id, status: task.status, ...decision, issues: decision.allowed ? [] : [decision.reason] });
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_harness_migrate',
    {
      title: 'Inspect or apply a non-destructive ICARUS Harness migration',
      description: 'Use dry_run first when upgrading a v0.3 repository. Migration creates tracked harness metadata and copy-migrates the legacy graph while retaining the source. It never opens, moves, or rewrites .amr shards.',
      inputSchema: { repo: z.string().default(process.cwd()), dry_run: z.boolean().default(true), agents: z.array(z.enum(['claude', 'codex', 'cursor', 'grok'])).default([]) },
    },
    async ({ repo, dry_run, agents }) => {
      try { return textResult(harnessFor().migrateHarness(repo, { dryRun: dry_run, agents })); } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_policy_check',
    {
      title: 'Validate the governed repository policy',
      description: 'Read and validate .icarus/policies/default.yaml in the Rust authority. Call before a managed session when policy state is uncertain. Invalid or unknown policy settings fail closed and cannot be overridden by agent instructions.',
      inputSchema: { repo: z.string().default(process.cwd()) },
    },
    async ({ repo }) => {
      try { return textResult(harnessFor().policyCheck(repo)); } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_policy_explain',
    {
      title: 'Read a durable Rust-recorded policy denial',
      description: 'Use only with a DENIAL id returned by a rejected managed adapter write. ICARUS reads the immutable decision-time receipt from the Rust runtime; it does not infer a new explanation from current policy, agent prose, or file content.',
      inputSchema: { repo: z.string().default(process.cwd()), denial_id: z.string() },
    },
    async ({ repo, denial_id }) => {
      try { return textResult(harnessFor().policyExplain(repo, denial_id)); } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_checkpoint',
    {
      title: 'Checkpoint governed task progress',
      description: 'Call after planning, a material edit, test execution, or before ending a session. The agent supplies structured risks, budget consumption, and next action; ICARUS captures Git/worktree/graph fingerprints for safe resume. This is not an LLM summary service.',
      inputSchema: { repo: z.string().default(process.cwd()), task_id: z.string(), phase: z.string(), input: z.record(z.unknown()).default({}) },
    },
    async ({ repo, task_id, phase, input }) => {
      try { return textResult(harnessFor().checkpointTask(repo, task_id, phase, input)); } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_task_handoff',
    {
      title: 'Hand a managed implementation session to ICARUS verification',
      description: 'Call after checkpointing when implementation is ready for deterministic verification. It moves only the prepared executing task to verifying and records an audit boundary; it does not assert tests passed, accept model prose, or seal the task.',
      inputSchema: { repo: z.string().default(process.cwd()), task_id: z.string() },
    },
    async ({ repo, task_id }) => {
      try { return textResult(harnessFor().handoffManagedTask(repo, task_id)); } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_task_resume',
    {
      title: 'Resume a governed task in a new agent session',
      description: 'Call only after icarus_task_status. Retains task_id, starts a linked execution attempt, and refuses silent worktree divergence from the last checkpoint.',
      inputSchema: { repo: z.string().default(process.cwd()), task_id: z.string() },
    },
    async ({ repo, task_id }) => {
      try { return textResult(harnessFor().resumeTask(repo, task_id)); } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_task_amend_contract',
    {
      title: 'Create an attributable new task-contract version',
      description: 'Use only when a governed task scope genuinely changes. Creates contract.vN.json without rewriting prior history; changes during execution require an explicit approval reference.',
      inputSchema: { repo: z.string().default(process.cwd()), task_id: z.string(), contract: taskContractSchema, reason: z.string(), approval_id: z.string().optional() },
    },
    async ({ repo, task_id, contract, reason, approval_id }) => {
      try { return textResult(harnessFor().amendTaskContract(repo, task_id, contract, reason, approval_id)); } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_task_block',
    {
      title: 'Block a governed task with attributable reason',
      description: 'Use when progress cannot safely continue. Transitions the task to blocked and persists a checkpoint containing the stated blocker, so the next session can resolve it instead of guessing.',
      inputSchema: { repo: z.string().default(process.cwd()), task_id: z.string(), reason: z.string() },
    },
    async ({ repo, task_id, reason }) => {
      try {
        const harness = harnessFor();
        const task = harness.transitionTask(repo, task_id, 'blocked');
        const checkpoint = harness.checkpointTask(repo, task_id, 'blocked', { open_risks: [reason], next_valid_action: 'resolve blocking condition' });
        return textResult({ task_id: task.task_id, execution_id: task.execution_id, status: task.status, checkpoint, issues: [reason] });
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_task_verify',
    {
      title: 'Run one immutable acceptance criterion and store a receipt',
      description: 'Use in verifying state. ICARUS runs only the command or artifact check declared in the immutable task contract, stores complete local output plus a bounded excerpt and workspace fingerprints, and never accepts a model statement that a check passed.',
      inputSchema: { repo: z.string().default(process.cwd()), task_id: z.string(), criterion_id: z.string() },
    },
    async ({ repo, task_id, criterion_id }) => {
      try { return textResult(harnessFor().verifyTaskCriterion(repo, task_id, criterion_id)); } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_task_attest',
    {
      title: 'Record an attributable manual review or external approval',
      description: 'Use only for a manual_review or external_approval criterion in the immutable task contract. This stores the approver and approval reference as a receipt; external approvals must include a future RFC3339 expiry and are rejected by seal after expiry.',
      inputSchema: { repo: z.string().default(process.cwd()), task_id: z.string(), criterion_id: z.string(), approval_id: z.string(), approver: z.string(), expires_at: z.string().optional() },
    },
    async ({ repo, task_id, criterion_id, approval_id, approver, expires_at }) => {
      try { return textResult(harnessFor().attestTaskCriterion(repo, task_id, criterion_id, approval_id, approver, expires_at)); } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_task_seal',
    {
      title: 'Seal a governed task only after native evidence checks pass',
      description: 'Call only in verifying state after every required immutable criterion has a current passing receipt. ICARUS checks receipt freshness, approvals, scope, unresolved high-risk issues, and the event chain itself. A seal result is structured evidence, never an agent claim that work is complete.',
      inputSchema: { repo: z.string().default(process.cwd()), task_id: z.string() },
    },
    async ({ repo, task_id }) => {
      try {
        const result = harnessFor().sealTask(repo, task_id);
        const task = harnessFor().taskStatus(repo, task_id);
        return textResult({ task_id: task.task_id, execution_id: task.execution_id, status: task.status, ...result, issues: result.issues || [] });
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_task_export',
    {
      title: 'Export a sealed task receipt',
      description: 'Read-only export of a sealed task’s final deterministic receipt. Set redacted=true before sharing outside the repository: it removes objective text, paths, output excerpts, artifact lists, and attestations while retaining status and evidence digests.',
      inputSchema: { repo: z.string().default(process.cwd()), task_id: z.string(), redacted: z.boolean().default(true) },
    },
    async ({ repo, task_id, redacted }) => {
      try { return textResult(harnessFor().exportTask(repo, task_id, redacted)); } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_harness_skill_authoring_brief',
    {
      title: 'Derive a skill-authoring brief from sealed work',
      description: 'Call after a sealed task when you detect a reusable procedure. ICARUS returns source task evidence, exact scope, and promotion gates for you to draft a candidate with your own reasoning. It never calls an LLM, writes a skill, or activates one automatically.',
      inputSchema: { repo: z.string().default(process.cwd()), task_id: z.string() },
    },
    async ({ repo, task_id }) => {
      try { return textResult(harnessFor().skillAuthoringBrief(repo, task_id)); } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_harness_learning_capture',
    {
      title: 'Derive a reviewed-memory candidate from sealed work',
      description: 'Call after a task is sealed when its verified decisions, receipts, or patch outcome may be useful in future work. ICARUS returns immutable task provenance and review instructions only; it does not infer a lesson, call an LLM, or write a memory. Use the approval tool only after authoring a concise factual draft grounded in this evidence.',
      inputSchema: { repo: z.string().default(process.cwd()), task_id: z.string() },
    },
    async ({ repo, task_id }) => {
      try { return textResult(harnessFor().createLearningCapture(repo, task_id)); } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_harness_learning_capture_approve',
    {
      title: 'Approve and persist a provenance-bound learning memory',
      description: 'Use only after icarus_harness_learning_capture and an explicit review. Submit a concise caller-authored memory supported by the sealed receipt. ICARUS validates the capture digest first, adds immutable task/capture provenance tags, saves only to the selected local AMR org, then records the returned memory id in the hash-chained harness audit. It never sends this memory to a remote service.',
      inputSchema: {
        repo: z.string().default(process.cwd()),
        capture_id: z.string(),
        capture_digest: z.string(),
        title: z.string(),
        content: z.string(),
        tags: z.array(z.string()).default([]),
        source_type: z.enum(['text', 'code', 'conversation', 'documentation', 'decision']).optional(),
        project: z.string().optional(),
        org: z.string().default('default'),
      },
    },
    async ({ repo, capture_id, capture_digest, title, content, tags, source_type, project, org }) => {
      try {
        const draft = { title, content, tags: tags || [], source_type, project };
        const approval = harnessFor().approveLearningCapture(repo, capture_id, capture_digest, draft);
        const combinedTags = [...new Set([...(tags || []), ...approval.provenance_tags])];
        const memory = await memoryCall('save_structured', { content, org: org || 'default', options: {
          title, tags: combinedTags, sourceType: source_type, project,
        } });
        const saved = harnessFor().recordLearningCaptureSaved(repo, capture_id, memory.id, approval.draft_digest);
        return textResult({ memory, saved, provenance_tags: combinedTags });
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_harness_skill_propose',
    {
      title: 'Propose a governed ICARUS harness procedure',
      description: 'Use only after sealed tasks demonstrate a reusable procedure. This stores an untrusted candidate; it never makes the procedure available to an agent context or grants execution authority.',
      inputSchema: { repo: z.string().default(process.cwd()), skill: z.record(z.unknown()) },
    },
    async ({ repo, skill }) => {
      try { return textResult(harnessFor().proposeSkill(repo, skill)); } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_harness_skill_evaluate',
    {
      title: 'Record a native governed-skill replay evaluation',
      description: 'Bind a proposed procedure to an independent sealed replay task and a distinct sealed baseline task of the same immutable task type. ICARUS compares native duration and observed managed-tool actions; candidate-supplied replay claims never count toward promotion.',
      inputSchema: { repo: z.string().default(process.cwd()), skill_id: z.string(), replay_task_id: z.string(), baseline_task_id: z.string() },
    },
    async ({ repo, skill_id, replay_task_id, baseline_task_id }) => {
      try { return textResult(harnessFor().evaluateSkill(repo, skill_id, replay_task_id, baseline_task_id)); } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_harness_skill_promote',
    {
      title: 'Promote a replay-verified harness procedure',
      description: 'Promotes only a previously proposed procedure. Low-risk procedures require three sealed source tasks and two successful native replay evaluations with measurable improvement over independent baselines; qualifying low-risk evaluations auto-promote. Candidate-supplied replay claims are ignored. High-risk procedures require an attributable owner approval. The Rust core writes verification state.',
      inputSchema: { repo: z.string().default(process.cwd()), skill_id: z.string(), owner_approval: z.string().optional() },
    },
    async ({ repo, skill_id, owner_approval }) => {
      try { return textResult(harnessFor().promoteSkill(repo, skill_id, owner_approval)); } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_harness_skill_outcome',
    {
      title: 'Record a terminal native outcome for an active harness procedure',
      description: 'Use only after the task ends sealed, blocked, or failed and has checkpointed the active skill id. ICARUS derives pass/fail from the task lifecycle; the agent cannot provide an arbitrary result. Three applicable failures or one safety violation demote the skill on the next governed review.',
      inputSchema: { repo: z.string().default(process.cwd()), skill_id: z.string(), task_id: z.string() },
    },
    async ({ repo, skill_id, task_id }) => {
      try { return textResult(harnessFor().recordActiveSkillOutcome(repo, skill_id, task_id)); } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_harness_skill_review',
    {
      title: 'Apply deterministic active-skill health policy',
      description: 'Demotes only unsafe or stale active procedures: three attributable native failures, a recorded safety violation, incompatible policy/schema, or proof expiry beyond the 30-day grace window. It never promotes a skill.',
      inputSchema: { repo: z.string().default(process.cwd()) },
    },
    async ({ repo }) => {
      try { return textResult(harnessFor().reviewActiveSkills(repo)); } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_harness_skill_retire',
    {
      title: 'Retire a governed harness procedure with an audit trail',
      description: 'Use when an active procedure is unsafe, stale, or superseded. Requires an owner approval reference and a reason. ICARUS preserves an immutable runtime archive and removes the procedure from future context packs.',
      inputSchema: { repo: z.string().default(process.cwd()), skill_id: z.string(), reason: z.string(), owner_approval: z.string() },
    },
    async ({ repo, skill_id, reason, owner_approval }) => {
      try { return textResult(harnessFor().retireSkill(repo, skill_id, reason, owner_approval)); } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_context_get',
    {
      title: 'Compile a bounded, traceable ICARUS context pack',
      description: 'Call before planning and after resume, compaction, or a material repository change. Produces deterministic JSON plus Markdown from the same Rust pack. It includes mandatory contract/policy/worktree items or fails budget_unsatisfied; ICARUS never calls an LLM to summarize it.',
      inputSchema: { repo: z.string().default(process.cwd()), task_id: z.string(), budget_tokens: z.number().int().positive().max(1_000_000).default(12_000), since_checkpoint: z.number().int().positive().optional().describe('Build only the continuation delta after this checkpoint sequence'), format: z.enum(['json', 'markdown', 'both']).default('both') },
    },
    async ({ repo, task_id, budget_tokens, since_checkpoint, format }) => {
      try {
        const result = harnessFor().buildContext(repo, task_id, budget_tokens || 12_000, since_checkpoint);
        if (format === 'json') return textResult(result.pack);
        if (format === 'markdown') return textResult(result.markdown);
        return textResult(result);
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_graph_build',
    {
      title: 'Build the native symbol/call graph for a codebase',
      description: 'Call once per codebase before using icarus_graph_query -- Tree-sitter parse (JS/TS + Rust) into a local symbol/call-graph SQLite index at <repo>/.icarus-graph/graph.db. Full rebuild each call -- run again after significant changes. Native, no Python/uvx dependency.',
      inputSchema: { repo: z.string().describe('Absolute path to the codebase root') },
    },
    async ({ repo }) => {
      try { return textResult(await require('./graph-native.js').buildAndStore(repo)); } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_graph_status',
    {
      title: 'Graph build status for a codebase',
      description: 'Check before icarus_graph_query if unsure whether icarus_graph_build has run for this repo yet. Node/edge/file counts and last-build time. Returns null if never built.',
      inputSchema: { repo: z.string().describe('Absolute path to the codebase root') },
    },
    async ({ repo }) => {
      try { return textResult(await require('./graph-native.js').status(repo)); } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_graph_query',
    {
      title: 'Query the symbol/call graph',
      description: 'Use when the user asks "who calls X", "what does X import", or "where is X defined" in a codebase icarus_graph_build has already indexed. callers_of/callees_of: who calls, or is called by, a function (bare name match). imports_of: which files import a given module. find: locate a symbol by name across the codebase.',
      inputSchema: {
        repo: z.string().describe('Absolute path to the codebase root'),
        kind: z.enum(['callers_of', 'callees_of', 'imports_of', 'find']),
        name: z.string().describe('Symbol or module name to query'),
      },
    },
    async ({ repo, kind, name }) => {
      try { return textResult(await require('./graph-native.js').query(repo, kind, name)); } catch (e) { return errorResult(e); }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

module.exports = { run };
