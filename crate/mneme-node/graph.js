'use strict';
// `icarus graph` — ICARUS's OWN native symbol/call-graph indexer (graph-native.js): Tree-sitter
// (WASM, via web-tree-sitter) parse -> symbol table -> call/import edges -> local SQLite. Same
// shape as Tencent's own CodeGraph approach, built here directly rather than wrapped — no
// Python, no uvx/pipx dependency at runtime. `icarus mcp install` also registers a native MCP
// tool set (icarus_graph_build/status/query) directly, not a passthrough to a separate process.
const graph = require('./graph-native.js');

async function run(flags) {
  const sub = flags._[0];
  const repo = flags.repo || process.cwd();
  if (sub === 'build') {
    console.log(`building graph for ${repo}...`);
    const t0 = Date.now();
    let lastRendered = '';
    let lastCompleted = -1;
    const progress = (update) => {
      const total = Number.isInteger(update.total) ? update.total : '?';
      const completed = Number.isInteger(update.completed) ? update.completed : '?';
      const suffix = update.file ? ` · ${update.file}` : '';
      const line = `graph ${update.stage}: ${completed}/${total}${suffix}`;
      // Avoid noisy output on large repositories while still proving liveness in captured agent
      // terminals. Interactive TTYs redraw one line; captured logs see periodic milestones.
      if (process.stderr.isTTY) {
        process.stderr.write(`\r${line}`);
        lastRendered = line;
      } else if (completed === 0 || update.stage !== 'parsing' || completed - lastCompleted >= 100) {
        console.error(`[icarus] ${line}`);
        lastCompleted = typeof completed === 'number' ? completed : lastCompleted;
      }
    };
    let r;
    try {
      r = await graph.buildAndStore(repo, progress);
    } finally {
      if (lastRendered) process.stderr.write('\n');
    }
    console.log(`✓ ${r.files} files, ${r.nodes} nodes, ${r.edges} edges (${Date.now() - t0}ms)`);
    return;
  }
  if (sub === 'status') {
    const s = await graph.status(repo);
    if (!s) return console.log(`no graph built yet for ${repo} — run: icarus graph build --repo ${repo}`);
    const freshness = s.current
      ? 'current'
      : 'stale — supported source changed; run: icarus graph build';
    console.log(`Nodes: ${s.nodes}\nEdges: ${s.edges}\nFiles: ${s.files}\nLanguages: ${s.languages.join(', ')}\nFreshness: ${freshness}\nLast updated: ${s.lastUpdated}`);
    return;
  }
  if (sub === 'query') {
    const kind = flags.kind;
    const name = flags.name || flags._[1];
    if (!kind || !name) throw new Error('usage: icarus graph query --kind <callers_of|callees_of|imports_of|find> --name <symbol> [--repo <dir>]');
    const rows = await graph.query(repo, kind, name);
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  throw new Error('usage: icarus graph <build|status|query> [--repo <dir>] [--kind <k> --name <n>]');
}

module.exports = { run, build: graph.build, buildAndStore: graph.buildAndStore, status: graph.status, query: graph.query };
