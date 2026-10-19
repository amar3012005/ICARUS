'use strict';
const { z } = require('zod');

function canonicalAction(value) {
  return String(value || '').replace(/^(?:icarus|hivemind)_/, '').replace(/^code_diff$/, 'diff').replace(/^code_timeline$/, 'timeline');
}

function compatibleArgs(action, input = {}) {
  const args = { ...input };
  const rename = (from, to) => { if (args[from] !== undefined && args[to] === undefined) args[to] = args[from]; delete args[from]; };
  rename('fn_name', 'function_name');
  if (action === 'test_coverage' && args.action === 'list') args.action = 'recall';
  if (['at', 'code_at'].includes(action)) rename('valid_at', 'valid_time');
  if (action === 'diff') { rename('from', 'time_a'); rename('to', 'time_b'); }
  if (action === 'query_with_ai') rename('query', 'question');
  if (action === 'save_memory' && args.memory_type) {
    args.tags = [...(args.tags || []), `memory:${args.memory_type}`];
    delete args.memory_type;
  }
  if (args.relationship) {
    const relationships = { updates: 'update', extends: 'extend', derives: 'derive', contradicts: 'contradict', references: 'mentions' };
    const lower = String(args.relationship).toLowerCase();
    args.relationship = relationships[lower] || lower;
  }
  return args;
}

function createToolkit() {
  const entries = new Map();
  const registerTool = (name, config, handler) => {
    const action = canonicalAction(name);
    const requires = config.requires || (action === 'train_pq' ? 'real embedding vectors; optional optimization'
      : /^(harness_|task_|context_|action_|checkpoint|policy_)/.test(action) ? 'opted-in repository harness; no embedding model'
      : action === 'graph_query' ? 'existing code graph index; no embedding model'
      : 'local; no embedding model');
    entries.set(action, { name, config: { ...config, requires }, handler });
  };
  async function call({ action = 'discover', args = {} }) {
    action = canonicalAction(action);
    if (action === 'discover') {
      const query = String(args.query || '').toLowerCase();
      const matches = [...entries.entries()].filter(([name, e]) => !query || `${name} ${e.config.title} ${e.config.description}`.toLowerCase().includes(query));
      const offset = Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : 0;
      const limit = Number.isSafeInteger(args.limit) ? Math.max(1, Math.min(30, args.limit)) : 12;
      return { content: [{ type: 'text', text: JSON.stringify({
        usage: 'icarus({action:"describe",args:{tool:"recall"}}), then icarus({action:"recall",args:{query:"topic",org:"project"}}). Existing icarus_ and hivemind_ action prefixes are accepted. Local memory needs no embedding model; hosted web and AI synthesis have separate requirements.',
        total: matches.length, next_offset: offset + limit < matches.length ? offset + limit : null,
        tools: matches.slice(offset, offset + limit).map(([action, e]) => ({ action, title: e.config.title, requires: e.config.requires || 'local; no embedding model' })),
      }) }] };
    }
    if (action === 'describe') {
      const e = entries.get(canonicalAction(args.tool || args.action));
      if (!e) throw new Error('Unknown action; use discover with a narrow query.');
      return { content: [{ type: 'text', text: JSON.stringify({ action: canonicalAction(e.name), description: e.config.description,
        requires: e.config.requires || 'local; no embedding model', inputSchema: z.toJSONSchema(z.object(e.config.inputSchema || {})) }) }] };
    }
    const entry = entries.get(action);
    if (!entry) throw new Error(`Unknown ICARUS action "${action}"; use discover.`);
    const parsed = z.object(entry.config.inputSchema || {}).strict().parse(compatibleArgs(action, args));
    return entry.handler(parsed);
  }
  return { entries, registerTool, call };
}

function installToolkit(server, toolkit, { legacy = false } = {}) {
  server.registerTool('icarus', {
    title: 'ICARUS second brain',
    description: 'Persistent local memory across sessions. Start with action=discover (args.query narrows tools), describe (args.tool returns one schema), then call that action with its existing arguments in args. Memory, coding context, history, graph and optional governance; optional hosted web and model synthesis are explicitly gated. Recall relevant context before non-trivial work; save durable verified findings afterwards. No embedding model needed for local memory.',
    inputSchema: { action: z.string().default('discover'), args: z.record(z.string(), z.unknown()).default({}) },
  }, async (input) => {
    try { return await toolkit.call(input); }
    catch (error) { return { isError: true, content: [{ type: 'text', text: `Error: ${error.message}` }] }; }
  });
  if (legacy) for (const e of toolkit.entries.values()) {
    const { requires, ...config } = e.config;
    server.registerTool(e.name, config, e.handler);
  }
}
module.exports = { createToolkit, installToolkit, canonicalAction, compatibleArgs };
