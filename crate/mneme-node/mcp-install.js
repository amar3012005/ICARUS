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

// Claude Code's SessionEnd hook — a DIFFERENT real file from the MCP registration above:
// ~/.claude/settings.json (hooks config), not ~/.claude.json (MCP servers + app state). Verified
// against real Claude Code hook docs: hooks.SessionEnd is an array of {matcher, hooks:[{type,
// command, timeout}]} groups; an empty matcher "" matches every SessionEnd trigger. This is what
// makes "automatic skill generation during coding sessions" (as opposed to `icarus skill save`,
// which needs a human to remember to run it) actually automatic.
function claudeSettingsPath() { return path.join(HOME, '.claude', 'settings.json'); }

function detectHook() {
  const p = claudeSettingsPath();
  if (!fs.existsSync(p)) return { found: false };
  const cfg = readJsonSafe(p);
  const existing = cfg?.hooks?.SessionEnd || [];
  const already = existing.some((g) => (g.hooks || []).some((h) => (h.command || '').includes('hook session-end')));
  return { found: already, path: p };
}

function installHook(command) {
  const p = claudeSettingsPath();
  const cfg = fs.existsSync(p) ? (readJsonSafe(p) || {}) : {};
  cfg.hooks = cfg.hooks || {};
  cfg.hooks.SessionEnd = cfg.hooks.SessionEnd || [];
  const already = cfg.hooks.SessionEnd.some((g) => (g.hooks || []).some((h) => (h.command || '').includes('hook session-end')));
  if (already) return { installed: false, reason: 'already installed', path: p };
  cfg.hooks.SessionEnd.push({
    matcher: '',
    hooks: [{ type: 'command', command: `${command} hook session-end`, timeout: 30 }],
  });
  writeJsonPreserving(p, cfg);
  return { installed: true, path: p };
}

// Surgical inverse of installHook — removes only entries whose command mentions our own hook
// subcommand, from whichever SessionEnd group(s) contain it, without touching unrelated
// SessionEnd hooks or any other key in the same settings.json.
function removeHook() {
  const p = claudeSettingsPath();
  if (!fs.existsSync(p)) return { removed: false };
  const cfg = readJsonSafe(p);
  if (!cfg?.hooks?.SessionEnd) return { removed: false };
  let removed = false;
  cfg.hooks.SessionEnd = cfg.hooks.SessionEnd
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => {
      const match = (h.command || '').includes('hook session-end');
      if (match) removed = true;
      return !match;
    }) }))
    .filter((g) => g.hooks.length > 0);
  if (cfg.hooks.SessionEnd.length === 0) delete cfg.hooks.SessionEnd;
  if (removed) writeJsonPreserving(p, cfg);
  return { removed, path: p };
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

// Standing instruction — the real lever for "does the agent start using icarus without being
// told to": MCP tool descriptions alone (even directive ones) aren't fully reliable on their
// own — HIVEMIND's own best-practices doc admits this and recommends exactly this kind of
// system-prompt line for OpenClaw ("recall before you act, save what's durable"). Written to
// ~/.claude/CLAUDE.md — Claude Code's real, confirmed-loaded-every-session global instructions
// file (not a project-local CLAUDE.md, which most repos don't have and shouldn't be forced to).
// Marker-wrapped so re-running `mcp install` is idempotent and `icarus prune` can remove exactly
// this block without touching anything else the user has in that file.
const STANDING_MARK_START = '<!-- icarus:standing-instructions -->';
const STANDING_MARK_END = '<!-- /icarus:standing-instructions -->';
const STANDING_BLOCK = `${STANDING_MARK_START}
## ICARUS memory

ICARUS is a local, persistent memory tool registered as an MCP server. Use it reflexively:

- Call \`icarus_recall\` before answering anything that might already be known — a past
  decision, a preference, prior conversation, or code context. It is cheap and local.
- When the user shares a durable fact, preference, or decision, call \`icarus_save_memory\`
  (title/content/tags/relationship) rather than letting it live only in this conversation.
- Before touching unfamiliar code, call \`icarus_why_code\` / \`icarus_recall_bugs\`. After a
  meaningful edit, call \`icarus_ingest_code\`. When choosing between real options, call
  \`icarus_log_decision\`.
- When a stored fact changes, prefer \`relationship: "update"\` (or \`icarus_update_memory\` for
  an in-place correction) over saving a duplicate — the old version is marked superseded and
  excluded from future recall automatically.
${STANDING_MARK_END}`;

function globalClaudeMdPath() { return path.join(HOME, '.claude', 'CLAUDE.md'); }

function detectStandingInstructions() {
  const p = globalClaudeMdPath();
  if (!fs.existsSync(p)) return { found: false, path: p };
  return { found: fs.readFileSync(p, 'utf8').includes(STANDING_MARK_START), path: p };
}

function installStandingInstructions() {
  const p = globalClaudeMdPath();
  const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  if (existing.includes(STANDING_MARK_START)) return { installed: false, reason: 'already installed', path: p };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const sep = existing && !existing.endsWith('\n\n') ? (existing.endsWith('\n') ? '\n' : '\n\n') : '';
  fs.writeFileSync(p, existing + sep + STANDING_BLOCK + '\n');
  return { installed: true, path: p };
}

// Surgical block removal — same start/end marker delete pattern as removeCodex's TOML section
// removal, adapted for markdown: drop every line from the start marker to the end marker
// (inclusive), leave everything else in the file untouched.
function removeStandingInstructions() {
  const p = globalClaudeMdPath();
  if (!fs.existsSync(p)) return { removed: false };
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  const startIdx = lines.findIndex((l) => l.includes(STANDING_MARK_START));
  if (startIdx === -1) return { removed: false, path: p };
  let endIdx = lines.findIndex((l, i) => i > startIdx && l.includes(STANDING_MARK_END));
  if (endIdx === -1) endIdx = lines.length - 1;
  lines.splice(startIdx, endIdx - startIdx + 1);
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(p, text);
  return { removed: true, path: p };
}

function detectRemovable() { return [detectClaudeCode(), detectCodex(), detectCursor()]; }
function removeAll() { return [removeClaudeCode(), removeCodex(), removeCursor(), removeStandingInstructions()]; }

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
  // Real lever for auto-recognition without an explicit ask, per HIVEMIND's own best-practices
  // doc ("give the agent one standing instruction"). Claude-Code-specific for now (Codex/Cursor
  // have no equally-confirmed global instruction-file convention) — printed as an honest note
  // below rather than silently guessed at for those agents.
  const std = installStandingInstructions();
  if (std.installed) {
    any = true;
    console.log(`  ✓ standing instructions: added to ${std.path} (Claude Code loads this every session)`);
  } else if (std.reason === 'already installed') {
    console.log(`  · standing instructions: already in ${std.path}`);
  }
  if (any) {
    console.log('\nRestart the agent(s) above to pick up the new MCP server.');
  } else {
    console.log('\nNothing to do — either no supported agent was found, or icarus is already registered everywhere it was.');
  }
  console.log('\nTools exposed: icarus_status, icarus_ingest, icarus_recall, icarus_save, icarus_train_pq, icarus_compact,');
  console.log('  memory: icarus_save_memory, icarus_get_memory, icarus_list_memories, icarus_update_memory,');
  console.log('          icarus_delete_memory, icarus_save_conversation, icarus_traverse_graph');
  console.log('  coding: icarus_ingest_code, icarus_recall_bugs, icarus_log_decision, icarus_track_refactor,');
  console.log('          icarus_test_coverage, icarus_why_code');
  console.log('  graph:  icarus_graph_build, icarus_graph_status, icarus_graph_query (native symbol/call graph)');
  console.log('\nCodex/Cursor: no equally-confirmed global standing-instruction file for those agents yet —');
  console.log('consider adding a similar "recall before you answer, save what\'s durable" line to their own config by hand.');
}

module.exports = {
  run, resolveIcarusCommand, detectAgents, installClaudeCode, installCodex, installCursor,
  detectRemovable, removeAll, detectHook, installHook, removeHook,
  detectStandingInstructions, installStandingInstructions, removeStandingInstructions,
};
