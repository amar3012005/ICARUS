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
};
