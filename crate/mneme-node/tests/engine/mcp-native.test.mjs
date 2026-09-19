// End-to-end MCP coverage that deliberately requires the compiled Rust addon.  The ordinary
// Node suite must stay toolchain-free; CI builds the addon before invoking this engine suite.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'mneme-cli.js');
const children = new Set();

async function stopChildren() {
  await Promise.all([...children].map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  })));
  children.clear();
}

async function stopDaemonAt(home) {
  const portFile = join(home, 'daemon.port');
  const tokenFile = join(home, 'daemon.token');
  if (!existsSync(portFile) || !existsSync(tokenFile)) return;
  const port = Number(readFileSync(portFile, 'utf8').trim());
  const token = readFileSync(tokenFile, 'utf8').trim();
  if (!port || !token) return;
  await new Promise((resolve) => {
    const request = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/shutdown', headers: { 'x-icarus-daemon-token': token } }, (response) => {
      response.resume();
      response.once('end', resolve);
    });
    request.once('error', resolve);
    request.end();
  });
}

async function legacyDaemon(home) {
  mkdirSync(home, { recursive: true });
  const token = 'legacy-daemon-test-token';
  writeFileSync(join(home, 'daemon.token'), token, { mode: 0o600 });
  const server = http.createServer((req, res) => {
    if (req.headers['x-icarus-daemon-token'] !== token) {
      res.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      // This is exactly the shape returned by an older ICARUS daemon: it claims to be
      // healthy, but has no protocol declaration and cannot safely receive a newer client's
      // repository-scoped configuration.
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ service: 'icarus-daemon', pid: 1 }));
      return;
    }
    if (req.method === 'POST' && req.url === '/shutdown') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ stopping: true }));
      setImmediate(() => server.close());
      return;
    }
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'legacy daemon cannot process this request' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  writeFileSync(join(home, 'daemon.port'), String(port));
  return { server, port };
}

afterEach(stopChildren);

function startMcp(env) {
  const child = spawn(process.execPath, [CLI, 'mcp-serve'], {
    cwd: join(HERE, '..', '..'),
    env: { ...process.env, NO_COLOR: '1', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  let stderr = '';
  let buffer = '';
  const waiters = new Map();
  const fail = (error) => {
    for (const waiter of waiters.values()) waiter.reject(error);
    waiters.clear();
  };
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch {
        fail(new Error(`MCP stdout is not JSON-RPC: ${JSON.stringify(line)}`));
        return;
      }
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  child.once('error', fail);
  child.once('exit', (code, signal) => {
    if (waiters.size) fail(new Error(`MCP server exited ${code ?? signal}; stderr: ${stderr}`));
  });
  return {
    request(id, method, params) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new Error(`MCP request ${method} timed out; stderr: ${stderr}`));
        }, 10_000);
        waiters.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
  };
}

function payload(response) {
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.result.isError, undefined, `MCP tool returned an error: ${JSON.stringify(response.result)}`);
  const text = response.result.content?.[0]?.text;
  assert.equal(typeof text, 'string', 'MCP tool result must contain text content');
  return JSON.parse(text);
}

async function tool(mcp, id, name, args) {
  return payload(await mcp.request(id, 'tools/call', { name, arguments: args }));
}

test('native MCP round-trip persists local evidence and structured memory without network', async () => {
  const root = mkdtempSync(join(tmpdir(), 'icarus-mcp-native-'));
  const home = join(root, 'home');
  const docs = join(root, 'docs');
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, 'evidence.md'), 'The Aster protocol keeps ICARUS MCP evidence local and deterministic for this integration test.\n');
  try {
    const mcp = startMcp({ ICARUS_HOME: home, OPENROUTER_API_KEY: '', HIVEMIND_API_KEY: '' });
    const initialized = await mcp.request(1, 'initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'icarus-native-roundtrip', version: '1.0.0' },
    });
    assert.equal(initialized.result.serverInfo.name, 'icarus');
    mcp.notify('notifications/initialized', {});

    const ingested = await tool(mcp, 2, 'icarus_ingest', { dir: docs, org: 'mcp-e2e', local: true });
    assert.equal(ingested.files, 1);
    assert.ok(ingested.chunks >= 1, `expected evidence chunks, got ${JSON.stringify(ingested)}`);
    assert.equal(ingested.mode, 'lexical', 'the test must remain local and network-free');

    const saved = await tool(mcp, 3, 'icarus_save_memory', {
      org: 'mcp-e2e', title: 'Native MCP durability decision',
      content: 'The native MCP integration test stores structured memories in the local shard.',
      tags: ['mcp', 'native', 'durability'], source_type: 'decision',
    });
    assert.match(saved.id, /^[0-9a-f-]{36}$/i, 'the native store must return a durable memory id');

    const recalled = await tool(mcp, 4, 'icarus_recall', {
      org: 'mcp-e2e', query: 'Aster protocol local evidence deterministic', topK: 5,
    });
    assert.ok(recalled.some((hit) => /Aster protocol keeps ICARUS MCP evidence/i.test(hit.text)),
      `ingested evidence was not recallable: ${JSON.stringify(recalled)}`);

    const memory = await tool(mcp, 5, 'icarus_get_memory', { org: 'mcp-e2e', memory_id: saved.id });
    assert.equal(memory.content, 'The native MCP integration test stores structured memories in the local shard.');
    assert.deepEqual(memory.tags, ['mcp', 'native', 'durability']);
  } finally {
    // Wait until the child closes the native shard before deleting only this test-owned tree.
    await stopChildren();
    await stopDaemonAt(home);
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP memory and coding tools preserve durable local knowledge without embeddings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'icarus-mcp-memory-toolbox-'));
  const home = join(root, 'home');
  try {
    const mcp = startMcp({ ICARUS_HOME: home, OPENROUTER_API_KEY: '', HIVEMIND_API_KEY: '' });
    const initialized = await mcp.request(1, 'initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'icarus-memory-toolbox', version: '1.0.0' },
    });
    assert.equal(initialized.result.serverInfo.name, 'icarus');
    mcp.notify('notifications/initialized', {});
    const org = 'toolbox';

    const raw = await tool(mcp, 2, 'icarus_save', { org, text: 'Raw local fallback memory remains available without vectors.' });
    assert.equal(raw.mode, 'local');
    const first = await tool(mcp, 3, 'icarus_save_memory', {
      org, title: 'Authentication incident', content: 'Bug: token refresh once used a stale audience.',
      tags: ['bug', 'memory:event', 'file:src/auth.js'], source_type: 'decision',
    });
    const second = await tool(mcp, 4, 'icarus_save_memory', {
      org, title: 'Authentication incident fixed', content: 'Fix: derive the audience from the active tenant before refresh.',
      tags: ['fix', 'memory:fact', 'file:src/auth.js'], source_type: 'decision', relationship: 'update', related_to: first.id,
    });
    const listed = await tool(mcp, 5, 'icarus_list_memories', { org, tags: ['fix'], limit: 10 });
    assert.ok(listed.some((record) => record.id === second.id));
    const graph = await tool(mcp, 6, 'icarus_traverse_graph', { org, memory_id: second.id, relationship: 'all', depth: 2 });
    assert.ok(Array.isArray(graph));
    const updated = await tool(mcp, 7, 'icarus_update_memory', {
      org, memory_id: second.id, content: 'Fix verified: derive the audience from the active tenant before refresh.',
    });
    assert.equal(updated.id, second.id);
    const bugs = await tool(mcp, 8, 'icarus_recall_bugs', { org, context: 'token refresh audience', file_path: 'src/auth.js' });
    assert.ok(bugs.length >= 1, JSON.stringify(bugs));

    const v1 = await tool(mcp, 9, 'icarus_ingest_code', {
      org, file_path: 'src/auth.js', content: 'export function audience() { return tenant(); }', summary: 'Derives the active tenant audience.', tags: ['memory:fact'],
    });
    const v2 = await tool(mcp, 10, 'icarus_ingest_code', {
      org, file_path: 'src/auth.js', content: 'export function audience() { return activeTenant(); }', summary: 'Uses the active tenant helper.', tags: ['memory:fact'],
    });
    assert.equal(v2.previousVersion, v1.id);
    const decision = await tool(mcp, 11, 'icarus_log_decision', {
      org, title: 'Audience derivation', decision: 'Use activeTenant()', rationale: 'It prevents a stale tenant audience.', alternatives: ['Cache the audience'], affected_files: ['src/auth.js'], tags: ['memory:decision'],
    });
    await tool(mcp, 12, 'icarus_track_refactor', {
      org, refactor_type: 'rename', old_name: 'tenant()', new_name: 'activeTenant()', reason: 'Make tenant selection explicit.', affected_files: ['src/auth.js'], related_to: decision.id,
    });
    await tool(mcp, 13, 'icarus_test_coverage', {
      org, action: 'save', function_name: 'audience', file_path: 'src/auth.js', test_file: 'test/auth.test.js', test_cases: ['uses active tenant'], coverage_pct: 100,
    });
    const coverage = await tool(mcp, 14, 'icarus_test_coverage', { org, action: 'recall', function_name: 'audience', file_path: 'src/auth.js' });
    assert.ok(coverage.length >= 1, JSON.stringify(coverage));
    const why = await tool(mcp, 15, 'icarus_why_code', { org, query: 'why active tenant audience', file_path: 'src/auth.js' });
    assert.ok(why.decisions.length + why.refactors.length + why.bugs.length + why.other.length >= 1, JSON.stringify(why));
    const conversation = await tool(mcp, 16, 'icarus_save_conversation', {
      org, title: 'Auth handoff', messages: [{ role: 'assistant', content: 'The active tenant fix is verified.' }], tags: ['memory:task'], platform: 'other',
    });
    assert.match(conversation.id, /^[0-9a-f-]{36}$/i);
    const deleted = await tool(mcp, 17, 'icarus_delete_memory', { org, memory_id: conversation.id, reason: 'test cleanup' });
    assert.equal(deleted.id, conversation.id);
    const status = await tool(mcp, 18, 'icarus_status', {});
    assert.ok(Array.isArray(status.shards), JSON.stringify(status));
  } finally {
    await stopChildren();
    await stopDaemonAt(home);
    rmSync(root, { recursive: true, force: true });
  }
});

test('two MCP sessions share one daemon-owned shard without a lock error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'icarus-mcp-shared-daemon-'));
  const home = join(root, 'home');
  try {
    const first = startMcp({ ICARUS_HOME: home, OPENROUTER_API_KEY: '', HIVEMIND_API_KEY: '' });
    const second = startMcp({ ICARUS_HOME: home, OPENROUTER_API_KEY: '', HIVEMIND_API_KEY: '' });
    for (const [id, mcp] of [[1, first], [2, second]]) {
      const initialized = await mcp.request(id, 'initialize', {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'icarus-shared-daemon', version: '1.0.0' },
      });
      assert.equal(initialized.result.serverInfo.name, 'icarus');
      mcp.notify('notifications/initialized', {});
    }

    const saved = await tool(first, 3, 'icarus_save_memory', {
      org: 'shared-daemon', title: 'Shared daemon memory',
      content: 'A second coding-agent session can recall this committed memory without opening the shard directly.',
      tags: ['daemon', 'concurrency'], source_type: 'decision',
    });
    assert.match(saved.id, /^[0-9a-f-]{36}$/i);

    const recalled = await tool(second, 4, 'icarus_recall', {
      org: 'shared-daemon', query: 'second coding agent session committed memory', topK: 5,
    });
    assert.ok(recalled.some((hit) => /second coding-agent session/i.test(hit.text)), JSON.stringify(recalled));
  } finally {
    await stopChildren();
    await stopDaemonAt(home);
    if (process.platform !== 'win32') rmSync(root, { recursive: true, force: true });
  }
});

test('MCP replaces an incompatible older daemon before sharing a repository-scoped shard', async () => {
  const root = mkdtempSync(join(tmpdir(), 'icarus-mcp-daemon-upgrade-'));
  const home = join(root, 'home');
  const legacy = await legacyDaemon(home);
  try {
    const first = startMcp({ ICARUS_HOME: home, OPENROUTER_API_KEY: '', HIVEMIND_API_KEY: '' });
    const second = startMcp({ ICARUS_HOME: home, OPENROUTER_API_KEY: '', HIVEMIND_API_KEY: '' });
    for (const [id, mcp] of [[1, first], [2, second]]) {
      const initialized = await mcp.request(id, 'initialize', {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'icarus-daemon-upgrade', version: '1.0.0' },
      });
      assert.equal(initialized.result.serverInfo.name, 'icarus');
      mcp.notify('notifications/initialized', {});
    }

    const saved = await tool(first, 3, 'icarus_save_memory', {
      org: 'daemon-upgrade', title: 'Daemon protocol handoff',
      content: 'A current ICARUS session replaces an incompatible daemon before saving this shared handoff.',
      tags: ['daemon', 'upgrade', 'handoff'], source_type: 'decision',
    });
    const recalled = await tool(second, 4, 'icarus_recall', {
      org: 'daemon-upgrade', query: 'incompatible daemon shared handoff', topK: 5,
    });
    assert.match(saved.id, /^[0-9a-f-]{36}$/i);
    assert.ok(recalled.some((hit) => /replaces an incompatible daemon/i.test(hit.text)), JSON.stringify(recalled));
  } finally {
    await stopChildren();
    await stopDaemonAt(home);
    await new Promise((resolve) => legacy.server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('icarus_harness_init creates a repository harness once and is idempotent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'icarus-mcp-harness-init-'));
  const repo = join(root, 'repo');
  try {
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    const mcp = startMcp({ ICARUS_HOME: join(root, 'home'), OPENROUTER_API_KEY: '', HIVEMIND_API_KEY: '' });
    const initialized = await mcp.request(1, 'initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'icarus-harness-init', version: '1.0.0' },
    });
    assert.equal(initialized.result.serverInfo.name, 'icarus');
    mcp.notify('notifications/initialized', {});

    const first = await tool(mcp, 2, 'icarus_harness_init', { repo });
    assert.equal(first.created, true);
    assert.ok(existsSync(join(repo, '.icarus', 'manifest.yaml')), 'native initialization must create the tracked manifest');

    const second = await tool(mcp, 3, 'icarus_harness_init', { repo });
    assert.equal(second.created, false, 'a later session must observe, not recreate, the harness');
  } finally {
    await stopChildren();
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP can advance a started task to executing before authorizing a managed write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'icarus-mcp-task-transition-'));
  const repo = join(root, 'repo');
  try {
    mkdirSync(join(repo, 'src'), { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    const mcp = startMcp({ ICARUS_HOME: join(root, 'home'), OPENROUTER_API_KEY: '', HIVEMIND_API_KEY: '' });
    const initialized = await mcp.request(1, 'initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'icarus-task-transition', version: '1.0.0' },
    });
    assert.equal(initialized.result.serverInfo.name, 'icarus');
    mcp.notify('notifications/initialized', {});
    await tool(mcp, 2, 'icarus_harness_init', { repo });
    const task = await tool(mcp, 3, 'icarus_task_start', {
      repo,
      objective: 'Exercise the MCP task lifecycle',
      contract: {
        allowed_paths: ['src/**'], forbidden_paths: [], acceptance_criteria: [], risk: 'low', budgets: {},
        authority: 'native MCP integration test', external_write_policy: 'approval_required',
      },
    });
    assert.equal(task.status, 'created');
    for (const [offset, target] of ['orienting', 'contracted', 'planned', 'executing'].entries()) {
      const transitioned = await tool(mcp, 4 + offset, 'icarus_task_transition', { repo, task_id: task.task_id, target });
      assert.equal(transitioned.status, target);
    }
    const authorization = await tool(mcp, 8, 'icarus_action_check', {
      repo, task_id: task.task_id, kind: 'write', path: 'src/new.js',
    });
    assert.equal(authorization.status, 'executing');
    assert.equal(authorization.allowed, true);
  } finally {
    await stopChildren();
    rmSync(root, { recursive: true, force: true });
  }
});
