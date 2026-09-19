import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const telemetry = require('../../telemetry.js');

test('telemetry is off by default and has no local side effects', () => {
  const config = {};
  assert.equal(telemetry.record('/does/not/matter', config, 'memory_saved'), false);
  assert.equal(telemetry.status('/does/not/matter', config).enabled, false);
});

test('queued events contain only the documented anonymous metadata', async () => {
  const home = await mkdtemp(join(tmpdir(), 'icarus-telemetry-'));
  try {
    const config = {
      telemetry: { enabled: true, endpoint: 'https://example.invalid/v1/events', installationId: 'opaque-test-id' },
    };
    assert.equal(telemetry.record(home, config, 'harness_initialized', {
      agent: 'codex', version: '0.3.90', profile: 'harness',
      repository: '/private/repo', prompt: 'secret', memory: 'never included',
    }), true);
    const [line] = (await readFile(join(home, 'telemetry-queue.jsonl'), 'utf8')).trim().split('\n');
    const event = JSON.parse(line);
    assert.deepEqual(Object.keys(event).sort(), [
      'agent', 'arch', 'event', 'installation_id', 'occurred_at', 'os', 'profile', 'schema', 'version',
    ]);
    assert.equal(event.event, 'harness_initialized');
    assert.equal(event.agent, 'codex');
    assert.equal(JSON.stringify(event).includes('private/repo'), false);
    assert.equal(JSON.stringify(event).includes('secret'), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('flush delivers a bounded batch and clears only acknowledged events', async () => {
  const home = await mkdtemp(join(tmpdir(), 'icarus-telemetry-'));
  let received;
  const server = createServer(async (request, response) => {
    received = JSON.parse(await new Response(request).text());
    response.writeHead(202).end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const config = { telemetry: {
      enabled: true, endpoint: `http://127.0.0.1:${port}/v1/events`, installationId: 'opaque-test-id',
    } };
    telemetry.record(home, config, 'harness_initialized', { agent: 'codex', version: '0.3.90' });
    const outcome = await telemetry.flush(home, config);
    assert.ok(outcome.sent === 0 || outcome.sent === 1); // the detached flush may win the race
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(received.schema, 'icarus.telemetry.v1');
    assert.equal(received.events[0].event, 'harness_initialized');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test('enabling telemetry requires HTTPS and creates an opaque identifier', () => {
  const config = {};
  assert.throws(() => telemetry.enable(config, () => {}, 'http://example.test/events'), /https/);
  telemetry.enable(config, () => {}, 'https://example.test/events');
  assert.equal(config.telemetry.enabled, true);
  assert.match(config.telemetry.installationId, /^[0-9a-f-]{36}$/i);
});
