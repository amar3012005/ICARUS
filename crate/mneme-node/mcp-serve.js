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
  hivemindConfigured, hivemindIngestDir, hivemindRecallQuery,
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
      description: 'Extract and store every text/markdown/json/csv/log file under a directory into an org\'s memory shard. If icarus connect has a HIVEMIND token, routes through HIVEMIND\'s real hosted API instead (evidence-only: lexical + semantic, no memory generation, unless fullMemoryGeneration) -- set local=true to force the local .amr engine even when connected. Otherwise: real vectors if an embedding provider is configured (icarus connect-embeddings), text-only lexical (BM25) if not -- never errors just because no embedding provider exists, it degrades gracefully.',
      inputSchema: {
        dir: z.string().describe('Absolute path to the directory to ingest'),
        org: z.string().default('default').describe('Org/shard name to store into'),
        local: z.boolean().default(false).describe('Force the local .amr engine even if a HIVEMIND token is configured'),
        fullMemoryGeneration: z.boolean().default(false).describe('When routed through HIVEMIND, request its own memory-generation pipeline (ingestMode=both) instead of evidence-only'),
      },
    },
    async ({ dir, org, local, fullMemoryGeneration }) => {
      try {
        const cfg = loadCfg();
        if (hivemindConfigured(cfg) && !local) {
          return textResult(await hivemindIngestDir(dir, org || 'default', cfg, undefined, { fullMemoryGeneration: !!fullMemoryGeneration }));
        }
        return textResult(await ingestDir(dir, org || 'default', cfg));
      } catch (e) { return errorResult(e); }
    },
  );

  server.registerTool(
    'icarus_recall',
    {
      title: 'Recall memories from ICARUS',
      description: 'Recall over a previously ingested org\'s memory shard. If icarus connect has a HIVEMIND token, routes through HIVEMIND\'s real /api/recall (dense+lexical+entity+temporal, fused server-side) unless local=true. Otherwise: semantic (HNSW/PQ) if an embedding provider is configured, lexical (BM25) if not -- automatic, not a caller decision. Set usePq=true only if train_pq has already run for that org AND an embedding provider is configured (see icarus_train_pq) -- it is NOT a universal upgrade over the default HNSW recall, see icarus_train_pq\'s description.',
      inputSchema: {
        query: z.string().describe('Natural-language query'),
        org: z.string().default('default'),
        topK: z.number().int().positive().max(200).default(5),
        usePq: z.boolean().default(false).describe('Use PQ/ADC recall instead of the default HNSW/brute recall — requires icarus_train_pq to have run first for this org'),
        local: z.boolean().default(false).describe('Force the local .amr engine even if a HIVEMIND token is configured'),
      },
    },
    async ({ query, org, topK, usePq, local }) => {
      try {
        const cfg = loadCfg();
        if (hivemindConfigured(cfg) && !local) {
          return textResult(await hivemindRecallQuery(query, org || 'default', cfg, topK || 5));
        }
        const hits = await recallQuery(query, org || 'default', cfg, topK || 5, !!usePq);
        return textResult(hits);
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
