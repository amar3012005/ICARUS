// End-to-end MCP coverage that deliberately requires the compiled Rust addon.  The ordinary
// Node suite must stay toolchain-free; CI builds the addon before invoking this engine suite.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
