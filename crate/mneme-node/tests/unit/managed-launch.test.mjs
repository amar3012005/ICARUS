import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { observeManagedAdapter } = require('../../mneme-cli.js');

test('managed launcher terminates a child at the Rust-owned wall-time deadline', async () => {
  const child = new EventEmitter();
  const kills = [];
  child.kill = (signal) => {
    kills.push(signal);
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  const spawnProcess = () => {
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const lifecycle = [];
  const harness = {
    recordAdapterLifecycle(_repo, _taskId, eventType, exitCode) {
      lifecycle.push([eventType, exitCode]);
      return { eventType };
    },
  };

  const result = await observeManagedAdapter(
    'fake-agent', [], '/workspace', harness, '/repo', 'TASK-ABCDEFGHIJKL',
    '1970-01-01T00:00:00Z', spawnProcess,
  );

  assert.equal(result.timedOut, true);
  assert.deepEqual(kills, ['SIGTERM']);
  assert.deepEqual(lifecycle, [
    ['adapter_session_started', undefined],
    ['adapter_session_ended', undefined],
  ]);
});
