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
    const r = await graph.buildAndStore(repo);
    console.log(`✓ ${r.files} files, ${r.nodes} nodes, ${r.edges} edges (${Date.now() - t0}ms)`);
    return;
  }
  if (sub === 'status') {
    const s = await graph.status(repo);
    if (!s) return console.log(`no graph built yet for ${repo} — run: icarus graph build --repo ${repo}`);
    console.log(`Nodes: ${s.nodes}\nEdges: ${s.edges}\nFiles: ${s.files}\nLanguages: ${s.languages.join(', ')}\nLast updated: ${s.lastUpdated}`);
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
