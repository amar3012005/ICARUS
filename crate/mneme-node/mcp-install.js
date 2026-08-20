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
// Lazy: mcp-install.js is loaded by `icarus status`/other shard-less commands too — pulling
// cli-lib.js in eagerly would force the native addon to load just for those.
function repoOrgName(repo) { return require('./cli-lib.js').repoOrgName(repo); }
function initRepoShard(repo, orgName) { return require('./cli-lib.js').initRepoShard(repo, orgName); }

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

// Generic marker-wrapped block writer/remover — the same idempotent-append, surgical-remove
// pattern used for the global CLAUDE.md standing instructions, generalized so every per-project
// instruction file (Claude Code's project CLAUDE.md, Codex's AGENTS.md, Cursor's .mdc rule) can
// reuse ONE real, tested mechanism instead of three near-duplicate copies that could drift.
function writeMarkedBlock(filePath, markStart, markEnd, block) {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  if (existing.includes(markStart)) return { installed: false, reason: 'already installed', path: filePath };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const sep = existing && !existing.endsWith('\n\n') ? (existing.endsWith('\n') ? '\n' : '\n\n') : '';
  fs.writeFileSync(filePath, existing + sep + block + '\n');
  return { installed: true, path: filePath };
}
function detectMarkedBlock(filePath, markStart) {
  if (!fs.existsSync(filePath)) return { found: false, path: filePath };
  return { found: fs.readFileSync(filePath, 'utf8').includes(markStart), path: filePath };
}
// Surgical block removal — drop every line from the start marker to the end marker (inclusive),
// leave everything else in the file untouched. Same shape as removeCodex's TOML section removal.
function removeMarkedBlock(filePath, markStart, markEnd) {
  if (!fs.existsSync(filePath)) return { removed: false };
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const startIdx = lines.findIndex((l) => l.includes(markStart));
  if (startIdx === -1) return { removed: false, path: filePath };
  let endIdx = lines.findIndex((l, i) => i > startIdx && l.includes(markEnd));
  if (endIdx === -1) endIdx = lines.length - 1;
  lines.splice(startIdx, endIdx - startIdx + 1);
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(filePath, text);
  return { removed: true, path: filePath };
}

function detectStandingInstructions() { return detectMarkedBlock(globalClaudeMdPath(), STANDING_MARK_START); }
function installStandingInstructions() { return writeMarkedBlock(globalClaudeMdPath(), STANDING_MARK_START, STANDING_MARK_END, STANDING_BLOCK); }
function removeStandingInstructions() { return removeMarkedBlock(globalClaudeMdPath(), STANDING_MARK_START, STANDING_MARK_END); }

// ── Project-level instructions (per-repo, not machine-wide) ─────────────────────────────────
//
// Real gap this closes: every icarus call defaults to org "default" regardless of which repo
// you're in, so without this, all projects on a machine silently share ONE memory pool unless
// the user remembers --org every time. A stable, repo-derived org name written into the
// project's own instruction file gives the agent a concrete default to reach for instead of
// "default" — solved once per repo, not left to the user to type each session.
//
// Claude Code and Codex both genuinely load a project-level file the same way they load a
// global one (Claude Code: <cwd>/CLAUDE.md, real and confirmed — loaded alongside, not instead
// of, ~/.claude/CLAUDE.md; Codex: <cwd>/AGENTS.md, the real, now-common cross-tool convention).
// Cursor has no equivalent global file, but DOES have a real, current project convention:
// .cursor/rules/*.mdc — YAML-frontmattered rule files, `alwaysApply: true` making one load on
// every request the same way CLAUDE.md/AGENTS.md do.

function projectBlockBody(orgName) {
  return `## ICARUS memory (this project)

This repo's icarus org is **${orgName}** — pass \`org: "${orgName}"\` on icarus tool calls (icarus_recall, icarus_save_memory, icarus_ingest_code, etc.) instead of the default "default" org, so this project's memories stay separate from every other repo on this machine.

For "where is X" / "who calls X" / "what imports X" in this codebase: call \`icarus_graph_query\` FIRST — a cheap structural lookup (callers_of/callees_of/imports_of/find) — instead of Grep/Read over whole files. Run \`icarus_graph_build\` once for this repo if \`icarus_graph_status\` shows nothing built yet, and again after significant restructuring.

For a governed coding task in a repository with \`.icarus/manifest.yaml\`: call \`icarus_context_get\` before planning, after session compaction or resume, and after a material repository change. Use \`icarus_task_checkpoint\` before ending a session; do not claim verification without \`icarus_task_verify\` receipts.`;
}

const PROJECT_MARK_START = '<!-- icarus:project-instructions -->';
const PROJECT_MARK_END = '<!-- /icarus:project-instructions -->';

function projectClaudeMdPath(repo) { return path.join(repo || process.cwd(), 'CLAUDE.md'); }
function projectAgentsMdPath(repo) { return path.join(repo || process.cwd(), 'AGENTS.md'); }
function projectCursorRulePath(repo) { return path.join(repo || process.cwd(), '.cursor', 'rules', 'icarus.mdc'); }

function installProjectClaude(repo) {
  const orgName = repoOrgName(repo);
  const block = `${PROJECT_MARK_START}\n${projectBlockBody(orgName)}\n${PROJECT_MARK_END}`;
  return { agent: 'claude-code (project)', orgName, ...writeMarkedBlock(projectClaudeMdPath(repo), PROJECT_MARK_START, PROJECT_MARK_END, block) };
}
function installProjectAgents(repo) {
  const orgName = repoOrgName(repo);
  const block = `${PROJECT_MARK_START}\n${projectBlockBody(orgName)}\n${PROJECT_MARK_END}`;
  return { agent: 'codex (AGENTS.md)', orgName, ...writeMarkedBlock(projectAgentsMdPath(repo), PROJECT_MARK_START, PROJECT_MARK_END, block) };
}
function installProjectCursor(repo) {
  const orgName = repoOrgName(repo);
  // .mdc frontmatter: alwaysApply makes Cursor load this rule on every request, the same "always
  // present, no opt-in needed" behavior CLAUDE.md/AGENTS.md get for free.
  const block = `${PROJECT_MARK_START}\n---\ndescription: ICARUS memory — this project's org\nalwaysApply: true\n---\n\n${projectBlockBody(orgName)}\n${PROJECT_MARK_END}`;
  return { agent: 'cursor (.mdc rule)', orgName, ...writeMarkedBlock(projectCursorRulePath(repo), PROJECT_MARK_START, PROJECT_MARK_END, block) };
}
function detectProjectClaude(repo) { return detectMarkedBlock(projectClaudeMdPath(repo), PROJECT_MARK_START); }
function detectProjectAgents(repo) { return detectMarkedBlock(projectAgentsMdPath(repo), PROJECT_MARK_START); }
function detectProjectCursor(repo) { return detectMarkedBlock(projectCursorRulePath(repo), PROJECT_MARK_START); }
function removeProjectClaude(repo) { return removeMarkedBlock(projectClaudeMdPath(repo), PROJECT_MARK_START, PROJECT_MARK_END); }
function removeProjectAgents(repo) { return removeMarkedBlock(projectAgentsMdPath(repo), PROJECT_MARK_START, PROJECT_MARK_END); }
function removeProjectCursor(repo) { return removeMarkedBlock(projectCursorRulePath(repo), PROJECT_MARK_START, PROJECT_MARK_END); }

// Per-agent installer registry — the real primitive behind `icarus mcp install <agent>` (scope
// to just one agent) as well as the existing all-agents default. Each entry's `global`/`project`
// installer may be null when that layer has no real, confirmed convention for that agent (e.g.
// Cursor has no global file) — callers skip a null layer rather than guessing at one.
const AGENT_INSTALLERS = {
  claude: { mcp: installClaudeCode, global: installStandingInstructions, project: installProjectClaude },
  codex: { mcp: installCodex, global: null, project: installProjectAgents },
  cursor: { mcp: installCursor, global: null, project: installProjectCursor },
};

function detectRemovable() { return [detectClaudeCode(), detectCodex(), detectCursor()]; }
function removeAll() { return [removeClaudeCode(), removeCodex(), removeCursor(), removeStandingInstructions()]; }

function printToolSummary() {
  console.log('\nTools exposed: icarus_status, icarus_ingest, icarus_recall, icarus_save, icarus_train_pq, icarus_compact,');
  console.log('  memory: icarus_save_memory, icarus_get_memory, icarus_list_memories, icarus_update_memory,');
  console.log('          icarus_delete_memory, icarus_save_conversation, icarus_traverse_graph');
  console.log('  coding: icarus_ingest_code, icarus_recall_bugs, icarus_log_decision, icarus_track_refactor,');
  console.log('          icarus_test_coverage, icarus_why_code');
  console.log('  graph:  icarus_graph_build, icarus_graph_status, icarus_graph_query (native symbol/call graph)');
}

async function run(flags) {
  const command = resolveIcarusCommand();
  // A named agent (icarus mcp install claude|codex|cursor) is a deliberate, scoped ask — "set
  // icarus up for THIS project, for THIS agent" — matching how the feature was actually
  // requested (run from the project's own folder root). That's the one case that also writes a
  // PROJECT-level instruction file (CLAUDE.md/AGENTS.md/.mdc rule) with this repo's own derived
  // org name, not just the global MCP registration. The bare, no-argument form keeps its
  // existing, narrower behavior on purpose — registering every detected agent globally should
  // never silently start writing real, git-tracked files into whatever repo happens to be cwd.
  const agentArg = (flags?._?.[0] || '').toLowerCase();
  if (agentArg && !AGENT_INSTALLERS[agentArg]) {
    console.log(`unknown agent "${agentArg}" — one of: ${Object.keys(AGENT_INSTALLERS).join(', ')} (or omit to register every agent found, globally only)`);
    return;
  }
  if (agentArg) {
    const { mcp, global, project } = AGENT_INSTALLERS[agentArg];
    console.log(`icarus mcp install ${agentArg} — registering as command: ${command}\n`);
    const mcpResult = mcp(command);
    if (mcpResult.installed) console.log(`  ✓ ${mcpResult.agent}: registered in ${mcpResult.path}`);
    else console.log(`  · ${mcpResult.agent}: skipped (${mcpResult.reason})`);
    if (global) {
      const g = global();
      if (g.installed) console.log(`  ✓ standing instructions: added to ${g.path}`);
      else if (g.reason === 'already installed') console.log(`  · standing instructions: already in ${g.path}`);
    }
    const p = project(process.cwd());
    if (p.installed) console.log(`  ✓ project instructions: added to ${p.path} (org: "${p.orgName}")`);
    else if (p.reason === 'already installed') console.log(`  · project instructions: already in ${p.path} (org: "${p.orgName}")`);
    // Physically create the repo-local shard NOW, not lazily on first save — a real, existing
    // .icarus/data/<org> slot right after setup, matching the actual ask ("create a new .amr
    // slot... inside its .icarus folder"), not just an org name referenced in text with nothing
    // backing it. Same org name every agent's instruction file above references, so Claude Code/
    // Codex/Cursor working in this repo all share the identical shard — one real cross-agent
    // memory per project, not three isolated silos.
    try {
      const shard = initRepoShard(process.cwd(), p.orgName);
      console.log(`  ✓ shard created: ${shard.dataRoot}/${shard.org} (added .icarus/ to .gitignore)`);
    } catch (e) {
      console.log(`  · shard creation skipped: ${e.message}`);
    }
    console.log(`\nRestart ${agentArg} to pick up the MCP server. This project's icarus org is "${p.orgName}" — pass org: "${p.orgName}" on tool calls here.`);
    printToolSummary();
    return;
  }

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
  printToolSummary();
  console.log('\nCodex/Cursor: no equally-confirmed global standing-instruction file for those agents yet —');
  console.log('consider adding a similar "recall before you answer, save what\'s durable" line to their own config by hand.');
  console.log(`\nRun from a specific project: icarus mcp install <claude|codex|cursor> — also writes that project's own`);
  console.log('CLAUDE.md/AGENTS.md/.cursor rule with a stable, repo-derived org name so this project\'s memories stay separate.');
}

module.exports = {
  run, resolveIcarusCommand, detectAgents, installClaudeCode, installCodex, installCursor,
  detectRemovable, removeAll, detectHook, installHook, removeHook,
  detectStandingInstructions, installStandingInstructions, removeStandingInstructions,
  AGENT_INSTALLERS, repoOrgName,
  installProjectClaude, installProjectAgents, installProjectCursor,
  detectProjectClaude, detectProjectAgents, detectProjectCursor,
  removeProjectClaude, removeProjectAgents, removeProjectCursor,
};
