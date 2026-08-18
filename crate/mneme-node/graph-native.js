'use strict';
// Native symbol/call-graph indexer — ICARUS's OWN implementation, not a wrapper. Same shape as
// Tencent's own CodeGraph approach (Tree-sitter parse -> symbol table -> call/import edges ->
// local SQLite), but built here directly against web-tree-sitter (WASM, no native-addon ABI
// coupling across grammars — a real conflict was hit trying to install the native tree-sitter
// bindings: tree-sitter-javascript wants tree-sitter^0.25, tree-sitter-typescript wants ^0.21,
// tree-sitter-rust wants ^0.22, all incompatible as native addons sharing one core lib) and
// better-sqlite3 for storage. Scope for v1 (confirmed with the user): JS/TS + Rust, nodes + call
// edges + query — not the fuller communities/flows/visualize feature set the wrapper exposed.
const fs = require('fs');
const path = require('path');

let ParserMod = null;
async function getParser() {
  if (ParserMod) return ParserMod;
  ParserMod = require('web-tree-sitter');
  await ParserMod.init();
  return ParserMod;
}

const LANG_WASM = {
  javascript: 'tree-sitter-wasms/out/tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-wasms/out/tree-sitter-typescript.wasm',
  rust: 'tree-sitter-wasms/out/tree-sitter-rust.wasm',
};
const EXT_TO_LANG = {
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.rs': 'rust',
};
const _langCache = new Map();
async function loadLanguage(name) {
  if (_langCache.has(name)) return _langCache.get(name);
  const Parser = await getParser();
  const wasmPath = require.resolve(LANG_WASM[name]);
  const lang = await Parser.Language.load(wasmPath);
  _langCache.set(name, lang);
  return lang;
}

function walkFiles(dir) {
  const out = [];
  const skip = new Set(['node_modules', '.git', 'target', '.icarus-graph', 'dist', 'build']);
  (function rec(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p);
      else if (EXT_TO_LANG[path.extname(e.name)]) out.push(p);
    }
  })(dir);
  return out;
}

// One pass per file: collect every function/method-like node (as a symbol) and every call site
// (raw callee text — resolved against the GLOBAL symbol table in a second pass, once every
// file's symbols are known, exactly like the real tool's own "resolved N bare CALLS targets"
// step logged during recon testing).
function extractJsTs(tree, relPath, language) {
  const nodes = [];
  const calls = []; // {calleeName, line, enclosingQualified}
  const imports = []; // {source, line}
  const scopeStack = []; // qualified name prefixes (class names) for method scoping

  function qualify(name) {
    return scopeStack.length ? `${relPath}::${scopeStack.join('.')}.${name}` : `${relPath}::${name}`;
  }
  function calleeName(callExprNode) {
    const fn = callExprNode.namedChild(0);
    if (!fn) return null;
    if (fn.type === 'identifier') return fn.text;
    if (fn.type === 'member_expression') {
      const prop = fn.childForFieldName('property');
      return prop ? prop.text : null;
    }
    return null;
  }
  function enclosing() {
    for (let i = nodes.length - 1; i >= 0; i--) return nodes[i].qualifiedName; // last opened, closest enclosing
    return `${relPath}::<module>`;
  }
  // Stack of currently-open function nodes, so a call nested inside one attributes to the
  // innermost enclosing function, not the file overall.
  const openFns = [];
  function currentEnclosing() {
    return openFns.length ? openFns[openFns.length - 1] : `${relPath}::<module>`;
  }

  function visit(n) {
    switch (n.type) {
      case 'class_declaration': {
        const nameNode = n.childForFieldName('name');
        const name = nameNode ? nameNode.text : '<anon>';
        scopeStack.push(name);
        for (let i = 0; i < n.childCount; i++) visit(n.child(i));
        scopeStack.pop();
        return;
      }
      case 'function_declaration':
      case 'method_definition': {
        const nameNode = n.childForFieldName('name');
        const name = nameNode ? nameNode.text : '<anon>';
        const qn = qualify(name);
        nodes.push({
          kind: n.type === 'method_definition' ? 'method' : 'function',
          name, qualifiedName: qn, filePath: relPath, language,
          startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1,
        });
        openFns.push(qn);
        for (let i = 0; i < n.childCount; i++) visit(n.child(i));
        openFns.pop();
        return;
      }
      case 'variable_declarator': {
        // const foo = () => {} / const foo = function() {} — the two other function shapes.
        const valueNode = n.childForFieldName('value');
        const nameNode = n.childForFieldName('name');
        if (valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression') && nameNode) {
          const name = nameNode.text;
          const qn = qualify(name);
          nodes.push({
            kind: 'function', name, qualifiedName: qn, filePath: relPath, language,
            startLine: valueNode.startPosition.row + 1, endLine: valueNode.endPosition.row + 1,
          });
          openFns.push(qn);
          for (let i = 0; i < valueNode.childCount; i++) visit(valueNode.child(i));
          openFns.pop();
          return;
        }
        break;
      }
      case 'call_expression': {
        const name = calleeName(n);
        if (name) calls.push({ calleeName: name, line: n.startPosition.row + 1, enclosingQualified: currentEnclosing() });
        break;
      }
      case 'import_statement': {
        const src = n.childForFieldName('source');
        if (src) imports.push({ source: src.text.replace(/^['"]|['"]$/g, ''), line: n.startPosition.row + 1 });
        break;
      }
      default:
        break;
    }
    for (let i = 0; i < n.childCount; i++) visit(n.child(i));
  }
  visit(tree.rootNode);
  return { nodes, calls, imports };
}

function extractRust(tree, relPath) {
  const nodes = [];
  const calls = [];
  const imports = [];
  const scopeStack = [];
  const openFns = [];
  function qualify(name) {
    return scopeStack.length ? `${relPath}::${scopeStack.join('.')}.${name}` : `${relPath}::${name}`;
  }
  function currentEnclosing() {
    return openFns.length ? openFns[openFns.length - 1] : `${relPath}::<module>`;
  }
  function calleeName(callExprNode) {
    const fn = callExprNode.childForFieldName('function');
    if (!fn) return null;
    if (fn.type === 'identifier') return fn.text;
    if (fn.type === 'field_expression') {
      const field = fn.childForFieldName('field');
      return field ? field.text : null;
    }
    if (fn.type === 'scoped_identifier') {
      const name = fn.childForFieldName('name');
      return name ? name.text : fn.text;
    }
    return null;
  }
  function visit(n) {
    switch (n.type) {
      case 'impl_item': {
        const typeNode = n.childForFieldName('type');
        scopeStack.push(typeNode ? typeNode.text : '<impl>');
        for (let i = 0; i < n.childCount; i++) visit(n.child(i));
        scopeStack.pop();
        return;
      }
      case 'function_item': {
        const nameNode = n.childForFieldName('name');
        const name = nameNode ? nameNode.text : '<anon>';
        const qn = qualify(name);
        nodes.push({
          kind: scopeStack.length ? 'method' : 'function',
          name, qualifiedName: qn, filePath: relPath, language: 'rust',
          startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1,
        });
        openFns.push(qn);
        for (let i = 0; i < n.childCount; i++) visit(n.child(i));
        openFns.pop();
        return;
      }
      case 'call_expression': {
        const name = calleeName(n);
        if (name) calls.push({ calleeName: name, line: n.startPosition.row + 1, enclosingQualified: currentEnclosing() });
        break;
      }
      case 'use_declaration': {
        imports.push({ source: n.text.replace(/^use\s+/, '').replace(/;$/, ''), line: n.startPosition.row + 1 });
        break;
      }
      default:
        break;
    }
    for (let i = 0; i < n.childCount; i++) visit(n.child(i));
  }
  visit(tree.rootNode);
  return { nodes, calls, imports };
}

async function build(repoDir) {
  const Parser = await getParser();
  const files = walkFiles(repoDir);
  const allNodes = [];
  const allCalls = []; // {calleeName, line, enclosingQualified, filePath}
  const allImports = []; // {source, line, filePath}
  const parsersByLang = {};

  for (const abs of files) {
    const rel = path.relative(repoDir, abs);
    const lang = EXT_TO_LANG[path.extname(abs)];
    if (!parsersByLang[lang]) {
      const language = await loadLanguage(lang);
      const parser = new Parser();
      parser.setLanguage(language);
      parsersByLang[lang] = parser;
    }
    let src;
    try { src = fs.readFileSync(abs, 'utf8'); } catch (_) { continue; }
    let tree;
    try { tree = parsersByLang[lang].parse(src); } catch (_) { continue; } // one bad file must not kill the whole build
    const result = lang === 'rust' ? extractRust(tree, rel) : extractJsTs(tree, rel, lang);
    allNodes.push(...result.nodes);
    for (const c of result.calls) allCalls.push({ ...c, filePath: rel });
    for (const im of result.imports) allImports.push({ ...im, filePath: rel });
  }

  // Second pass: resolve call sites against the GLOBAL bare-name symbol table. Ambiguous bare
  // names (two functions sharing a name in different files/classes) get an edge to EVERY match —
  // representing real ambiguity honestly instead of silently guessing one, matching the real
  // tool's own "evidence-backed" framing (it only claims what it can actually back with a match).
  const byName = new Map();
  for (const n of allNodes) {
    if (!byName.has(n.name)) byName.set(n.name, []);
    byName.get(n.name).push(n.qualifiedName);
  }
  const edges = [];
  for (const c of allCalls) {
    const targets = byName.get(c.calleeName);
    if (!targets) continue; // not a locally-defined symbol (external lib call, builtin, etc.) — no edge, not an error
    for (const t of targets) {
      edges.push({ kind: 'CALLS', sourceQualified: c.enclosingQualified, targetQualified: t, filePath: c.filePath, line: c.line });
    }
  }
  for (const im of allImports) {
    edges.push({ kind: 'IMPORTS', sourceQualified: `${im.filePath}::<module>`, targetQualified: im.source, filePath: im.filePath, line: im.line });
  }

  return { nodes: allNodes, edges, files: files.length };
}

function dbPath(repoDir) {
  return path.join(repoDir, '.icarus-graph', 'graph.db');
}

function openDb(repoDir) {
  const Database = require('better-sqlite3');
  const dir = path.join(repoDir, '.icarus-graph');
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath(repoDir));
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT, name TEXT, qualified_name TEXT, file_path TEXT,
      start_line INTEGER, end_line INTEGER, language TEXT
    );
    CREATE TABLE IF NOT EXISTS edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT, source_qualified TEXT, target_qualified TEXT, file_path TEXT, line INTEGER
    );
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT);
    CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
    CREATE INDEX IF NOT EXISTS idx_nodes_qn ON nodes(qualified_name);
    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_qualified);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_qualified);
  `);
  return db;
}

async function buildAndStore(repoDir) {
  const result = await build(repoDir);
  const db = openDb(repoDir);
  db.exec('DELETE FROM nodes; DELETE FROM edges;'); // full rebuild for v1 — no incremental update yet
  const insNode = db.prepare('INSERT INTO nodes (kind,name,qualified_name,file_path,start_line,end_line,language) VALUES (?,?,?,?,?,?,?)');
  const insEdge = db.prepare('INSERT INTO edges (kind,source_qualified,target_qualified,file_path,line) VALUES (?,?,?,?,?)');
  const tx = db.transaction(() => {
    for (const n of result.nodes) insNode.run(n.kind, n.name, n.qualifiedName, n.filePath, n.startLine, n.endLine, n.language);
    for (const e of result.edges) insEdge.run(e.kind, e.sourceQualified, e.targetQualified, e.filePath, e.line);
    db.prepare('INSERT OR REPLACE INTO metadata (key,value) VALUES (?,?)').run('last_updated', new Date().toISOString());
  });
  tx();
  db.close();
  return { files: result.files, nodes: result.nodes.length, edges: result.edges.length };
}

function status(repoDir) {
  if (!fs.existsSync(dbPath(repoDir))) return null;
  const db = openDb(repoDir);
  const nodes = db.prepare('SELECT COUNT(*) c FROM nodes').get().c;
  const edges = db.prepare('SELECT COUNT(*) c FROM edges').get().c;
  const files = db.prepare('SELECT COUNT(DISTINCT file_path) c FROM nodes').get().c;
  const languages = db.prepare('SELECT DISTINCT language FROM nodes').all().map((r) => r.language);
  const lastUpdated = db.prepare("SELECT value FROM metadata WHERE key='last_updated'").get();
  db.close();
  return { nodes, edges, files, languages, lastUpdated: lastUpdated?.value };
}

// query kinds: callers_of, callees_of, imports_of, find (by bare name)
function query(repoDir, kind, name) {
  if (!fs.existsSync(dbPath(repoDir))) throw new Error('no graph built yet — run `icarus graph build --repo <dir>` first');
  const db = openDb(repoDir);
  let rows;
  if (kind === 'callers_of') {
    rows = db.prepare(`
      SELECT DISTINCT n.qualified_name, n.file_path, n.start_line FROM edges e
      JOIN nodes n ON n.qualified_name = e.source_qualified
      WHERE e.kind='CALLS' AND e.target_qualified LIKE ?
    `).all(`%::${name}`);
  } else if (kind === 'callees_of') {
    rows = db.prepare(`
      SELECT DISTINCT n.qualified_name, n.file_path, n.start_line FROM edges e
      JOIN nodes n ON n.qualified_name = e.target_qualified
      WHERE e.kind='CALLS' AND e.source_qualified LIKE ?
    `).all(`%::${name}`);
  } else if (kind === 'imports_of') {
    rows = db.prepare(`SELECT DISTINCT file_path, line, target_qualified as source FROM edges WHERE kind='IMPORTS' AND target_qualified LIKE ?`).all(`%${name}%`);
  } else if (kind === 'find') {
    rows = db.prepare('SELECT qualified_name, kind, file_path, start_line, end_line, language FROM nodes WHERE name = ?').all(name);
  } else {
    db.close();
    throw new Error(`unknown query kind "${kind}" — use callers_of|callees_of|imports_of|find`);
  }
  db.close();
  return rows;
}

module.exports = { build, buildAndStore, status, query, dbPath, walkFiles };
