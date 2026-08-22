// MCP is a process protocol, not just an exported module. This smoke test exercises the actual
// CLI entrypoint over stdio and rejects any accidental banner/log output on stdout, which would
// corrupt JSON-RPC for Codex, Claude, Cursor, and other MCP clients.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'mneme-cli.js');
const children = new Set();

afterEach(() => {
  for (const child of children) child.kill('SIGTERM');
  children.clear();
});

function startMcp() {
  const child = spawn(process.execPath, [CLI, 'mcp-serve'], {
    cwd: join(HERE, '..', '..'),
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  let stderr = '';
  let buffer = '';
  const messages = [];
  const waiters = new Map();
  const fail = (error) => {
    for (const reject of waiters.values()) reject(error);
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
      messages.push(message);
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        waiter.resolve(message);
      }
    }
  });
  child.once('error', fail);
  child.once('exit', (code, signal) => {
    if (waiters.size) fail(new Error(`MCP server exited ${code ?? signal}; stderr: ${stderr}`));
  });
  const request = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`MCP request ${method} timed out; stderr: ${stderr}`));
    }, 10_000);
    waiters.set(id, {
      resolve: (message) => { clearTimeout(timer); resolve(message); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };
  return { request, notify, messages };
}

test('MCP stdio server completes initialize and exposes the public tool surface', async () => {
  const mcp = startMcp();
  const initialized = await mcp.request(1, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'icarus-protocol-smoke', version: '1.0.0' },
  });
  assert.equal(initialized.jsonrpc, '2.0');
  assert.equal(initialized.id, 1);
  assert.equal(initialized.result.serverInfo.name, 'icarus');
  mcp.notify('notifications/initialized', {});
  const listed = await mcp.request(2, 'tools/list', {});
  assert.equal(listed.jsonrpc, '2.0');
  assert.equal(listed.id, 2);
  const names = listed.result.tools.map((tool) => tool.name);
  for (const name of [
    'icarus_recall',
    'icarus_save_memory',
    'icarus_harness_init',
    'icarus_task_start',
    'icarus_context_get',
    'icarus_harness_skill_authoring_brief',
    'icarus_harness_learning_capture',
    'icarus_harness_learning_capture_approve',
    'icarus_policy_explain',
    'icarus_task_seal',
    'icarus_task_export',
  ]) assert.ok(names.includes(name), `missing MCP tool ${name}`);
  assert.equal(mcp.messages.some((message) => message.error), false);
});
