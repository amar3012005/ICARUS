'use strict';
// `icarus mcp install` — finds coding-agent config files already on this machine (Claude Code,
// Codex, Cursor) and registers icarus's MCP server in each one. Detects INSTALLED CONFIGS, not
// live running processes: there is no reliable, standard signal broadcast by an agent process to
// arbitrary tools it invokes, but every agent's own config file on disk is a real, mechanical
// fact — if it exists, that agent is installed, and this is the file it reads at its own startup.
// No Docker, no network: this only ever writes a `{command, args}` stdio entry — the agent
// launches icarus itself as a local process, exactly like every filesystem/git MCP server.
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
// install.sh's own default (ICARUS_HOME) — if the real wrapper exists there, prefer its
// absolute path over the bare "icarus" string: a GUI-launched agent (not started from an
// interactive shell) does not reliably inherit the PATH update install.sh appends to
// ~/.bashrc/~/.zshrc, so a bare command name can silently fail to launch for exactly the
// audience this feature targets.
function resolveIcarusCommand() {
  const wrapper = path.join(process.env.ICARUS_HOME || path.join(HOME, '.icarus'), 'bin', 'icarus');
  if (fs.existsSync(wrapper)) return wrapper;
  return 'icarus'; // fall back to PATH resolution
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}
function writeJsonPreserving(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

// Every MCP entry `mcp install`/`icarus setup` can register, name -> {command, args}. Just
// icarus itself — the native symbol/call-graph indexer (graph-native.js) is exposed as icarus's
// OWN MCP tools (icarus_graph_build/status/query, see mcp-serve.js) now, not a separate
// registered server for a wrapped external tool.
function mcpEntries(command, _repo) {
  return {
    icarus: { command, args: ['mcp-serve'] },
  };
}

// Claude Code: global ~/.claude.json, top-level `mcpServers.<name> = {command, args, env?}`.
function installClaudeCode(command, repo) {
  const p = path.join(HOME, '.claude.json');
  if (!fs.existsSync(p)) return { agent: 'claude-code', installed: false, reason: 'not found (no ~/.claude.json)' };
  const cfg = readJsonSafe(p);
  if (!cfg) return { agent: 'claude-code', installed: false, reason: 'config exists but failed to parse — left untouched' };
  cfg.mcpServers = cfg.mcpServers || {};
  let wrote = false;
  for (const [name, entry] of Object.entries(mcpEntries(command, repo))) {
    if (cfg.mcpServers[name]) continue;
    cfg.mcpServers[name] = { type: 'stdio', ...entry, env: {} };
    wrote = true;
  }
  if (!wrote) return { agent: 'claude-code', installed: false, reason: 'already registered' };
  writeJsonPreserving(p, cfg);
  return { agent: 'claude-code', installed: true, path: p };
}

// Cursor: global ~/.cursor/mcp.json, same `mcpServers.<name> = {command, args}` shape.
function installCursor(command, repo) {
  const dir = path.join(HOME, '.cursor');
  const p = path.join(dir, 'mcp.json');
  if (!fs.existsSync(dir)) return { agent: 'cursor', installed: false, reason: 'not found (no ~/.cursor)' };
  const cfg = fs.existsSync(p) ? readJsonSafe(p) : { mcpServers: {} };
  if (!cfg) return { agent: 'cursor', installed: false, reason: 'mcp.json exists but failed to parse — left untouched' };
  cfg.mcpServers = cfg.mcpServers || {};
  let wrote = false;
  for (const [name, entry] of Object.entries(mcpEntries(command, repo))) {
    if (cfg.mcpServers[name]) continue;
    cfg.mcpServers[name] = entry;
    wrote = true;
  }
  if (!wrote) return { agent: 'cursor', installed: false, reason: 'already registered' };
  writeJsonPreserving(p, cfg);
  return { agent: 'cursor', installed: true, path: p };
}

// Codex: ~/.codex/config.toml (TOML, not JSON). Appending well-formed new `[mcp_servers.<name>]`
// sections is enough — Codex's own writes go through the same file, and this never re-serializes
// (so no existing content, formatting, or comments elsewhere in the file can be disturbed).
// Deliberately NOT a general TOML editor: it only ever appends, and only for sections absent.
function installCodex(command, repo) {
  const dir = path.join(HOME, '.codex');
  const p = path.join(dir, 'config.toml');
  if (!fs.existsSync(dir)) return { agent: 'codex', installed: false, reason: 'not found (no ~/.codex)' };
  let existing = '';
  if (fs.existsSync(p)) existing = fs.readFileSync(p, 'utf8');
  let block = '';
  let wrote = false;
  for (const [name, entry] of Object.entries(mcpEntries(command, repo))) {
    if (new RegExp(`^\\[mcp_servers\\.${name}\\]`, 'm').test(existing)) continue;
    const argsToml = JSON.stringify(entry.args); // ["a","b"] is valid TOML array syntax too
    block += `\n[mcp_servers.${name}]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${argsToml}\n`;
    wrote = true;
  }
  if (!wrote) return { agent: 'codex', installed: false, reason: 'already registered' };
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(p, (existing && !existing.endsWith('\n') ? '\n' : '') + block);
  return { agent: 'codex', installed: true, path: p };
}

// Existence-check ONLY, no writing — for `icarus setup`'s wizard to ask "register with X?" one
// agent at a time BEFORE committing to any write, instead of installClaudeCode/installCodex/
// installCursor's current all-in-one detect+write behavior (still used as-is by `mcp install`).
function detectAgents() {
  return [
    { agent: 'claude-code', found: fs.existsSync(path.join(HOME, '.claude.json')) },
    { agent: 'codex', found: fs.existsSync(path.join(HOME, '.codex')) },
    { agent: 'cursor', found: fs.existsSync(path.join(HOME, '.cursor')) },
  ];
}

// `icarus prune`'s uninstall counterpart to installClaudeCode/installCursor/installCodex — each
// removes ONLY the icarus key (plus a stray "code-review-graph" entry, in case an earlier
// session of this tool registered one before that concept was dropped in favor of icarus's own
// native graph tools) and leaves every other entry in the file completely untouched. Detection
// only, no writing, so `icarus prune` can show the user what WOULD be removed before doing it.
const REMOVABLE_NAMES = ['icarus', 'code-review-graph'];

function detectClaudeCode() {
  const p = path.join(HOME, '.claude.json');
  if (!fs.existsSync(p)) return { agent: 'claude-code', found: false };
  const cfg = readJsonSafe(p);
  const present = REMOVABLE_NAMES.filter((n) => cfg?.mcpServers?.[n]);
  return { agent: 'claude-code', found: present.length > 0, path: p, entries: present };
}
function removeClaudeCode() {
  const p = path.join(HOME, '.claude.json');
  const cfg = readJsonSafe(p);
  if (!cfg?.mcpServers) return { agent: 'claude-code', removed: false };
  let removed = false;
  for (const n of REMOVABLE_NAMES) {
    if (cfg.mcpServers[n]) { delete cfg.mcpServers[n]; removed = true; }
  }
  if (removed) writeJsonPreserving(p, cfg);
  return { agent: 'claude-code', removed, path: p };
}

function detectCursor() {
  const p = path.join(HOME, '.cursor', 'mcp.json');
  if (!fs.existsSync(p)) return { agent: 'cursor', found: false };
  const cfg = readJsonSafe(p);
  const present = REMOVABLE_NAMES.filter((n) => cfg?.mcpServers?.[n]);
  return { agent: 'cursor', found: present.length > 0, path: p, entries: present };
}
function removeCursor() {
  const p = path.join(HOME, '.cursor', 'mcp.json');
  const cfg = readJsonSafe(p);
  if (!cfg?.mcpServers) return { agent: 'cursor', removed: false };
  let removed = false;
  for (const n of REMOVABLE_NAMES) {
    if (cfg.mcpServers[n]) { delete cfg.mcpServers[n]; removed = true; }
  }
  if (removed) writeJsonPreserving(p, cfg);
  return { agent: 'cursor', removed, path: p };
}

function detectCodex() {
  const p = path.join(HOME, '.codex', 'config.toml');
  if (!fs.existsSync(p)) return { agent: 'codex', found: false };
  const text = fs.readFileSync(p, 'utf8');
  const present = REMOVABLE_NAMES.filter((n) => new RegExp(`^\\[mcp_servers\\.${n}\\]`, 'm').test(text));
  return { agent: 'codex', found: present.length > 0, path: p, entries: present };
}
// Surgical block removal: from a `[mcp_servers.<name>]` header LINE to (but not including) the
// next line that starts a new section header, or EOF — the exact inverse of installCodex's
// append. Line-based on purpose: a character-class regex stopping at the next literal `[` broke
// on `args = ["mcp-serve"]`, since `[` also appears inside TOML array syntax, not just section
// headers — caught by actually running removal against a real generated config and diffing the
// result (it left a garbled `["mcp-serve"]` orphan behind). Only whole lines are ever dropped.
function removeCodex() {
  const p = path.join(HOME, '.codex', 'config.toml');
  if (!fs.existsSync(p)) return { agent: 'codex', removed: false };
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  let removed = false;
  for (const n of REMOVABLE_NAMES) {
    const headerRe = new RegExp(`^\\[mcp_servers\\.${n}\\]\\s*$`);
    const startIdx = lines.findIndex((l) => headerRe.test(l));
    if (startIdx === -1) continue;
    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (/^\[/.test(lines[i])) { endIdx = i; break; }
    }
    lines.splice(startIdx, endIdx - startIdx);
    removed = true;
  }
  if (removed) {
    // collapse any run of 2+ blank lines left behind by the splice, and drop a leading blank
    // line at the very top of the file — cosmetic only, never touches surviving content.
    const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
    fs.writeFileSync(p, text);
  }
  return { agent: 'codex', removed, path: p };
}

function detectRemovable() { return [detectClaudeCode(), detectCodex(), detectCursor()]; }
function removeAll() { return [removeClaudeCode(), removeCodex(), removeCursor()]; }

async function run(_flags) {
  const command = resolveIcarusCommand();
  const results = [installClaudeCode(command), installCodex(command), installCursor(command)];
  console.log(`icarus mcp install — registering as command: ${command}\n`);
  let any = false;
  for (const r of results) {
    if (r.installed) {
      any = true;
      console.log(`  ✓ ${r.agent}: registered in ${r.path}`);
    } else {
      console.log(`  · ${r.agent}: skipped (${r.reason})`);
    }
  }
  if (any) {
    console.log('\nRestart the agent(s) above to pick up the new MCP server.');
  } else {
    console.log('\nNothing to do — either no supported agent was found, or icarus is already registered everywhere it was.');
  }
  console.log('Tools exposed: icarus_status, icarus_ingest, icarus_recall, icarus_train_pq, icarus_compact,');
  console.log('               icarus_graph_build, icarus_graph_status, icarus_graph_query (native symbol/call graph).');
}

module.exports = {
  run, resolveIcarusCommand, detectAgents, installClaudeCode, installCodex, installCursor,
  detectRemovable, removeAll,
};
