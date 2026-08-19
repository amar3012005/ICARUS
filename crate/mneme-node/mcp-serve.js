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
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  loadCfg, ingestDir, recallQuery, statusReport, openStore,
  hivemindConfigured, hivemindIngestDir, hivemindSaveMemory, saveLocalMemory,
} = require('./cli-lib.js');

function textResult(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}
function errorResult(err) {
  return { content: [{ type: 'text', text: `Error: ${err.message || String(err)}` }], isError: true };
}

async function run() {
  const server = new McpServer({ name: 'icarus', version: '1.0.0' });

  server.registerTool(
    'icarus_status',
    {
      title: 'ICARUS status',
      description: 'List every org shard on this machine (the .amr memory filesystem) and its disk usage.',
      inputSchema: {},
    },
    async () => {
      try { return textResult(statusReport(loadCfg())); } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_ingest',
    {
      title: 'Ingest a folder into ICARUS',
      description: 'Extract and store files under a directory into an org\'s memory shard. If icarus connect has a HIVEMIND token, routes through HIVEMIND\'s real hosted API instead -- accepts everything that server supports (pdf/docx/xlsx/pptx/images/audio, a much broader set than the local engine\'s text-only formats) -- set local=true to force the local .amr engine even when connected (text-only: txt/md/json/csv/log). By default, segment text processed by HIVEMIND is also pulled back and re-embedded + stored in the LOCAL shard (mirrorLocal=false to skip and leave it purely server-side) -- the server never exposes its own embedding vectors over HTTP (checked, confirmed absent), so this is cloud chunking + local re-embedding, not cloud embedding. There is no real way to request "evidence-only vs full memory generation" on this endpoint -- the server decides based on what it actually extracts, not a request parameter.',
      inputSchema: {
        dir: z.string().describe('Absolute path to the directory to ingest'),
        org: z.string().default('default').describe('Org/shard name to store into'),
        local: z.boolean().default(false).describe('Force the local .amr engine even if a HIVEMIND token is configured'),
        force: z.boolean().default(false).describe('Matches the real FE\'s own "force" field (bypass the same-checksum dedup gate) -- not yet read server-side, sent to match the real upload contract exactly'),
        mirrorLocal: z.boolean().default(true).describe('When routed through HIVEMIND, also pull back the processed segment text and store it (re-embedded) in the local .amr shard. Set false to leave data purely server-side.'),
      },
    },
    async ({ dir, org, local, force, mirrorLocal }) => {
      try {
        const cfg = loadCfg();
        if (hivemindConfigured(cfg) && !local) {
          return textResult(await hivemindIngestDir(dir, org || 'default', cfg, undefined, { force: !!force, mirrorLocal: mirrorLocal !== false }));
        }
        return textResult(await ingestDir(dir, org || 'default', cfg));
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_recall',
    {
      title: 'Recall memories from ICARUS',
      description: 'Recall over a previously ingested org\'s memory shard. LOCAL ONLY, always -- never routes to HIVEMIND\'s shared /api/recall: a real cross-tenant leak was found there in testing (other orgs\' private content came back for this org\'s own queries). Real parallel hybrid retrieval: dense (HNSW, using an embedding provider or HIVEMIND\'s free embed service if connected) and lexical (BM25) run concurrently, merged via Reciprocal Rank Fusion -- not a single-modality either/or fallback. If HIVEMIND is connected, the merged wide candidate set gets a narrow re-score from the real bge-reranker-v2-m3 cross-encoder; if not, the hybrid merge itself is the final answer. Set usePq=true only if train_pq has already run for that org AND an embedding provider is configured (see icarus_train_pq) -- it is NOT a universal upgrade over the default hybrid recall, see icarus_train_pq\'s description.',
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
        const hits = await recallQuery(query, org || 'default', cfg, topK || 5, !!usePq);
        return textResult(hits);
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_save',
    {
      title: 'Save a real memory to ICARUS',
      description: 'Saves text as a real, deliberate memory -- full embedding + smart-router when HIVEMIND-routed (mode:\'atomic\', the same primitive MCP\'s own save_memory tool uses server-side), real local embedding otherwise. NOT evidence-only -- recallable via icarus_recall alongside anything icarus_ingest promoted. Set local=true to force the local .amr engine even if a HIVEMIND token is configured.',
      inputSchema: {
        text: z.string().describe('The memory content to save'),
        org: z.string().default('default'),
        local: z.boolean().default(false).describe('Force the local .amr engine even if a HIVEMIND token is configured'),
      },
    },
    async ({ text, org, local }) => {
      try {
        const cfg = loadCfg();
        if (hivemindConfigured(cfg) && !local) {
          const r = await hivemindSaveMemory(text, org || 'default', cfg);
          await saveLocalMemory(text, org || 'default', cfg); // mirror — icarus_recall is local-only
          return textResult(r);
        }
        await saveLocalMemory(text, org || 'default', cfg);
        return textResult({ ok: true, org: org || 'default', mode: 'local' });
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_train_pq',
    {
      title: 'Train PQ codebook for an org',
      description:
        'Trains a Product Quantization codebook and enables icarus_recall\'s usePq option for this org. Real, measured tradeoff (not a universal upgrade): PQ builds much faster than the default index always, and queries FASTER only on small/medium shards -- on large shards PQ queries SLOWER than the default at equal recall (PQ stays O(n) per query with a cheap per-item cost; the default index\'s near-O(log n) traversal wins as the shard grows). Good fit: shards you rebuild often. Blocks for its full duration (k-means over every live vector) -- call it after a bulk ingest, not per-request.',
      inputSchema: {
        org: z.string().default('default'),
        seed: z.number().int().default(42).describe('Deterministic training seed'),
      },
    },
    async ({ org, seed }) => {
      try {
        const cfg = loadCfg();
        const store = openStore(cfg, org || "default");
        const live = store.liveCount();
        if (!live) throw new Error(`org "${org || 'default'}" has no memories yet — nothing to train on`);
        const t0 = Date.now();
        store.trainPq(seed ?? 42);
        return textResult({ org: org || 'default', liveVectors: live, trainedInSeconds: (Date.now() - t0) / 1000 });
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_compact',
    {
      title: 'Compact an org shard',
      description: 'Reclaims dead bytes from deleted/rewritten memories in an org\'s shard (the engine is append-only, so this must be run periodically to reclaim space).',
      inputSchema: { org: z.string().default('default') },
    },
    async ({ org }) => {
      try {
        const cfg = loadCfg();
        const store = openStore(cfg, org || "default");
        const reclaimed = store.compact();
        return textResult({ org: org || 'default', reclaimedBytes: Number(reclaimed) || 0 });
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_graph_build',
    {
      title: 'Build the native symbol/call graph for a codebase',
      description: 'Tree-sitter parse (JS/TS + Rust) into a local symbol/call-graph SQLite index at <repo>/.icarus-graph/graph.db. Full rebuild each call -- run again after significant changes. Native, no Python/uvx dependency.',
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
      description: 'Node/edge/file counts and last-build time for a previously built graph. Returns null if icarus_graph_build has not run yet for this repo.',
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
      description: 'callers_of/callees_of: who calls, or is called by, a function (bare name match). imports_of: which files import a given module. find: locate a symbol by name across the codebase. Requires icarus_graph_build to have run first.',
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
