'use strict';

// Deterministic repository-harness substrate.  It deliberately does not import the memory
// engine, model clients, or agent adapters: the harness must keep working offline and must never
// make an LLM call by itself.  Higher-level task/context commands build on these small durable
// primitives.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { z } = require('zod');

const MANIFEST_VERSION = 1;
const RUNTIME_DIR = path.join('.icarus', 'runtime');
const MANIFEST_SCHEMA = z.object({
  schema_version: z.literal(MANIFEST_VERSION),
  harness_version: z.literal(1),
  repo_id: z.string().regex(/^repo-[a-f0-9]{16}$/),
  repo_root: z.string().min(1),
  git_remote_fingerprint: z.string().regex(/^[a-f0-9]{16}$/),
  policy_version: z.literal(1),
  agents: z.array(z.enum(['claude', 'codex', 'cursor', 'grok'])),
}).strict();

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

function readGitRemote(repoRoot) {
  try {
    return execFileSync('git', ['-C', repoRoot, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function manifestPath(repoRoot) { return path.join(repoRoot, '.icarus', 'manifest.yaml'); }
function eventsPath(repoRoot) { return path.join(repoRoot, RUNTIME_DIR, 'logs', 'events.jsonl'); }

function renderManifest(manifest) {
  return [
    '# ICARUS Harness repository contract. Commit this file; never commit .icarus/runtime/.',
    `schema_version: ${manifest.schema_version}`,
    `harness_version: ${manifest.harness_version}`,
    `repo_id: ${manifest.repo_id}`,
    `repo_root: ${JSON.stringify(manifest.repo_root)}`,
    `git_remote_fingerprint: ${manifest.git_remote_fingerprint}`,
    `policy_version: ${manifest.policy_version}`,
    'agents:',
    ...manifest.agents.map((agent) => `  - ${agent}`),
    '',
  ].join('\n');
}

// A deliberately narrow parser for the manifest we emit.  It rejects rather than silently
// accepting YAML features that could alter governance semantics; JSON Schema remains the stable
// external contract and a broader YAML front-end can be added without changing the manifest shape.
function parseManifest(text) {
  const values = {};
  const agents = [];
  let inAgents = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line === 'agents:') { inAgents = true; continue; }
    if (inAgents && line.startsWith('- ')) { agents.push(line.slice(2).trim()); continue; }
    inAgents = false;
    const match = /^([a-z_]+):\s*(.+)$/.exec(line);
    if (!match) throw new Error(`invalid manifest line: ${raw}`);
    const [, key, rawValue] = match;
    values[key] = rawValue.startsWith('"') ? JSON.parse(rawValue) : rawValue;
  }
  return MANIFEST_SCHEMA.parse({
    schema_version: Number(values.schema_version),
    harness_version: Number(values.harness_version),
    repo_id: values.repo_id,
    repo_root: values.repo_root,
    git_remote_fingerprint: values.git_remote_fingerprint,
    policy_version: Number(values.policy_version),
    agents,
  });
}

function loadManifest(repoRoot) {
  const file = manifestPath(repoRoot);
  if (!fs.existsSync(file)) throw new Error(`ICARUS harness is not initialized in ${repoRoot}; run \`icarus harness init\``);
  return parseManifest(fs.readFileSync(file, 'utf8'));
}

function ensureRootGitignore(repoRoot) {
  const file = path.join(repoRoot, '.gitignore');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (current.split(/\r?\n/).includes('.icarus/runtime/')) return;
  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  atomicWrite(file, `${current}${prefix}# ICARUS Harness runtime state (local, never commit)\n.icarus/runtime/\n`);
}

const DEFAULT_POLICY = `# ICARUS Harness policy v1\npolicy_version: 1\nexternal_writes: approval_required\nnetwork: agent_managed\nlearning: proposal_only\n`;
const SCHEMAS = {
  'manifest.schema.json': { $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'ICARUS Harness Manifest', type: 'object', required: ['schema_version', 'harness_version', 'repo_id', 'repo_root', 'git_remote_fingerprint', 'policy_version', 'agents'] },
  'contract.schema.json': { $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'ICARUS Task Contract', type: 'object' },
  'checkpoint.schema.json': { $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'ICARUS Checkpoint', type: 'object' },
  'receipt.schema.json': { $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'ICARUS Verification Receipt', type: 'object' },
  'skill.schema.json': { $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'ICARUS Proposed Skill', type: 'object' },
};

function initHarness(repoRoot, options = {}) {
  const root = fs.realpathSync(repoRoot);
  const file = manifestPath(root);
  if (fs.existsSync(file)) return { created: false, manifest: loadManifest(root), graph_migrated: false };
  const remote = readGitRemote(root);
  const identity = remote || root;
  const manifest = MANIFEST_SCHEMA.parse({
    schema_version: MANIFEST_VERSION,
    harness_version: 1,
    repo_id: `repo-${sha256(identity).slice(0, 16)}`,
    repo_root: root,
    git_remote_fingerprint: sha256(remote || `local:${root}`).slice(0, 16),
    policy_version: 1,
    agents: [...new Set(options.agents || [])],
  });
  atomicWrite(file, renderManifest(manifest));
  atomicWrite(path.join(root, '.icarus', 'policies', 'default.yaml'), DEFAULT_POLICY);
  for (const [name, schema] of Object.entries(SCHEMAS)) atomicWrite(path.join(root, '.icarus', 'schemas', name), `${JSON.stringify(schema, null, 2)}\n`);
  atomicWrite(path.join(root, RUNTIME_DIR, '.gitignore'), '*\n!.gitignore\n');
  ensureRootGitignore(root);

  const legacyGraph = path.join(root, '.icarus-graph', 'graph.db');
  const runtimeGraph = path.join(root, RUNTIME_DIR, 'graph', 'graph.db');
  const graphMigrated = fs.existsSync(legacyGraph) && !fs.existsSync(runtimeGraph);
  if (graphMigrated) {
    fs.mkdirSync(path.dirname(runtimeGraph), { recursive: true });
    fs.copyFileSync(legacyGraph, runtimeGraph, fs.constants.COPYFILE_EXCL);
  }
  return { created: true, manifest, graph_migrated: graphMigrated };
}

function appendRuntimeEvent(repoRoot, input) {
  const manifest = loadManifest(repoRoot);
  const file = eventsPath(repoRoot);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const previous = existing.at(-1);
  const event = {
    schema_version: 1,
    execution_id: input.execution_id,
    task_id: input.task_id,
    sequence: existing.length + 1,
    event_type: input.event_type,
    timestamp: input.timestamp || new Date().toISOString(),
    repo_id: manifest.repo_id,
    worktree_id: input.worktree_id || 'main',
    payload: input.payload || {},
    previous_hash: previous ? previous.event_hash : null,
  };
  event.event_hash = sha256(stableJson(event));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  return event;
}

function verifyEventChain(repoRoot, expectedRepoId) {
  const file = eventsPath(repoRoot);
  if (!fs.existsSync(file)) return { valid: true, events: 0, issues: [] };
  const issues = [];
  let previousHash = null;
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  lines.forEach((line, index) => {
    let event;
    try { event = JSON.parse(line); } catch { issues.push(`event ${index + 1}: invalid JSON`); return; }
    const eventHash = event.event_hash;
    delete event.event_hash;
    if (event.repo_id !== expectedRepoId) issues.push(`event ${index + 1}: repo identity mismatch`);
    if (event.sequence !== index + 1) issues.push(`event ${index + 1}: sequence mismatch`);
    if (event.previous_hash !== previousHash) issues.push(`event ${index + 1}: previous hash mismatch`);
    if (sha256(stableJson(event)) !== eventHash) issues.push(`event ${index + 1}: event hash mismatch`);
    previousHash = eventHash;
  });
  return { valid: issues.length === 0, events: lines.length, issues };
}

function doctor(repoRoot) {
  const checks = [];
  let manifest;
  try {
    manifest = loadManifest(repoRoot);
    checks.push({ id: 'manifest', status: 'pass', detail: `schema v${manifest.schema_version}; ${manifest.repo_id}` });
  } catch (error) {
    checks.push({ id: 'manifest', status: 'fail', detail: error.message });
    return { healthy: false, repo_id: null, checks, issues: [error.message] };
  }

  const runtime = path.join(repoRoot, RUNTIME_DIR);
  try {
    fs.mkdirSync(runtime, { recursive: true });
    const probe = path.join(runtime, `.write-probe-${process.pid}-${crypto.randomUUID()}`);
    fs.writeFileSync(probe, 'ok', { mode: 0o600 });
    fs.unlinkSync(probe);
    checks.push({ id: 'runtime_writable', status: 'pass', detail: runtime });
  } catch (error) {
    checks.push({ id: 'runtime_writable', status: 'fail', detail: error.message });
  }

  const chain = verifyEventChain(repoRoot, manifest.repo_id);
  checks.push({ id: 'event_chain', status: chain.valid ? 'pass' : 'fail', detail: chain.valid ? `${chain.events} event(s) verified` : chain.issues.join('; ') });

  const runtimeGraph = path.join(repoRoot, RUNTIME_DIR, 'graph', 'graph.db');
  const legacyGraph = path.join(repoRoot, '.icarus-graph', 'graph.db');
  checks.push({
    id: 'graph',
    status: fs.existsSync(runtimeGraph) ? 'pass' : 'warn',
    detail: fs.existsSync(runtimeGraph) ? 'runtime graph present' : (fs.existsSync(legacyGraph) ? 'legacy graph present; re-run harness init to migrate' : 'no graph built yet'),
  });

  const adapters = ['claude', 'codex', 'cursor', 'grok'];
  const available = adapters.filter((adapter) => {
    try { execFileSync('which', [adapter], { stdio: 'ignore' }); return true; } catch { return false; }
  });
  checks.push({ id: 'adapters', status: available.length ? 'pass' : 'warn', detail: available.length ? available.join(', ') : 'no supported coding-agent executable found on PATH' });

  const issues = checks.filter((check) => check.status === 'fail').map((check) => `${check.id}: ${check.detail}`);
  return { healthy: issues.length === 0, repo_id: manifest.repo_id, checks, issues };
}

module.exports = { initHarness, loadManifest, appendRuntimeEvent, verifyEventChain, doctor, parseManifest, MANIFEST_VERSION };
