'use strict';
const { z } = require('zod');
const lib = require('./cli-lib.js');

async function webRequest(path, body, cfg = lib.loadCfg()) {
  if (!lib.hivemindConfigured(cfg) || String(cfg.hivemind.token).startsWith('icarus_dev_')) {
    throw new Error('Web Intelligence requires a separately configured HIVEMIND customer credential with web scopes. Developer sign-in grants identity only. Local memory remains available.');
  }
  const base = process.env.HIVEMIND_API_URL || cfg.hivemind.apiUrl;
  const response = await fetch(`${base.replace(/\/$/, '')}${path}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${cfg.hivemind.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Web Intelligence HTTP ${response.status}; check customer web scopes and quota`);
  return response.json();
}

function registerExtraTools(server, memoryCall) {
  const output = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  const wrap = handler => async args => {
    try { return output(await handler(args)); }
    catch (error) { return { isError: true, content: [{ type: 'text', text: `Error: ${error.message}` }] }; }
  };
  const filters = {
    org: z.string().default('default'), memory_id: z.string().optional(),
    query: z.string().optional(), memory_query: z.string().optional(), file_path: z.string().optional(),
    tags: z.array(z.string()).default([]), project: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(20), max_records: z.number().int().min(1).max(100000).default(10000),
  };
  const time = z.union([z.string().datetime({ offset: true }), z.number().finite()]);
  for (const action of ['at', 'diff', 'timeline', 'code_at']) {
    const inputSchema = { ...filters };
    if (action === 'diff') { inputSchema.time_a = time; inputSchema.time_b = time; }
    else if (action !== 'timeline') {
      inputSchema.transaction_time = time.optional(); inputSchema.valid_time = time.optional();
      if (action === 'code_at') inputSchema.file_path = z.string();
    }
    server.registerTool(`icarus_${action}`, {
      title: `Local memory ${action}`,
      description: 'Inspect retained local structured-memory history: at/code_at require transaction_time (when learned) or valid_time (when true); diff uses time_a/time_b; timeline follows Updates chains. No embeddings. Deleted memories are excluded. Old corrections lacking transaction stamps cannot produce exact snapshots and return an explicit limitation. This is local AMR history, not the hosted MemoryVersion ledger.',
      inputSchema,
    }, wrap(args => memoryCall('history', { ...args, action })));
  }
  server.registerTool('icarus_query_with_ai', {
    title: 'Ground an answer in local memory',
    description: 'Retrieve bounded local evidence, then synthesize with the user-configured OpenRouter model. Without an LLM key returns grounded evidence and answer:null for the calling agent to reason over. Does not need embeddings or access hosted memory. Use only when synthesis is requested.',
    requires: 'local recall; optional user-configured LLM for synthesis',
    inputSchema: { question: z.string(), org: z.string().default('default'), context_limit: z.number().int().min(1).max(20).default(5),
      scope: z.enum(['repo', 'user', 'all', 'project']).default('all').describe('project aliases the local repository scope'), project: z.string().optional() },
  }, wrap(async ({ question, org, context_limit, scope, project }) => {
    const hits = await memoryCall('recall', { query: question, org, topK: context_limit, scope: scope === 'project' ? 'repo' : scope, project });
    const cfg = lib.loadCfg();
    if (cfg.llm?.disabled || !lib.openRouterApiKey(cfg)) return { question, answer: null, memories: hits, synthesis: 'calling-agent', requires: 'Optional LLM key; the calling agent can answer from these memories.' };
    const result = await lib.chatWithOpenRouter(question, org, cfg, { topK: context_limit, hits });
    return { question, answer: result.answer, memories: hits, model: result.model };
  }));

  const web = (action, title, inputSchema, handler) => server.registerTool(`icarus_${action}`, {
    title, description: 'Optional hosted HIVEMIND Web Intelligence. Public-web inputs are sent to the configured service; requires customer web scopes/quota, not developer sign-in. Never forwards local memory or repository contents automatically. Jobs are asynchronous; poll job_status explicitly. Does not require an embedding model.',
    requires: 'network + HIVEMIND customer web scopes/quota', inputSchema,
  }, wrap(handler));
  web('web_search', 'Search the public web', { query: z.string(), domains: z.array(z.string()).optional(), limit: z.number().int().min(1).max(20).default(10) }, args => webRequest('/api/web/search/jobs', args));
  web('web_research', 'Research the public web', { input: z.string(), model: z.string().default('auto'), citation_format: z.enum(['numbered', 'markdown']).default('numbered') }, args => webRequest('/api/web/research/jobs', args));
  web('web_crawl', 'Crawl public web pages', { urls: z.array(z.string().url()).min(1).max(50), depth: z.number().int().min(1).max(3).default(1), page_limit: z.number().int().min(1).max(50).default(10) }, args => webRequest('/api/web/crawl/jobs', args));
  web('web_job_status', 'Read a web job result', { job_id: z.string() }, args => webRequest(`/api/web/jobs/${encodeURIComponent(args.job_id)}`));
  web('web_usage', 'Inspect web quota', {}, () => webRequest('/api/web/usage'));
  web('web_retry_job', 'Retry one failed web job', { job_id: z.string() }, args => webRequest(`/api/web/jobs/${encodeURIComponent(args.job_id)}/retry`, {}));
}
module.exports = { registerExtraTools, webRequest };
