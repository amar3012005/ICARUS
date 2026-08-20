import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startTask, transitionTask, authorizeAction, recordAdapterLifecycle, __setNativeHarnessBridgeForTest } = require('../../harness.js');

afterEach(() => __setNativeHarnessBridgeForTest(null));

test('task lifecycle commands transport values to the Rust authority unchanged', () => {
  const calls = [];
  __setNativeHarnessBridgeForTest({
    harnessStartTask(...args) { calls.push(['start', ...args]); return JSON.stringify({ task_id: 'TASK-ABCDEFGHIJKL', status: 'created' }); },
    harnessTransitionTask(...args) { calls.push(['transition', ...args]); return JSON.stringify({ task_id: args[1], status: args[2] }); },
    harnessAuthorizeAction(...args) { calls.push(['authorize', ...args]); return JSON.stringify({ allowed: true, reason: 'contract permits write' }); },
    harnessRecordAdapterLifecycle(...args) { calls.push(['lifecycle', ...args]); return JSON.stringify({ event_type: args[2], exit_code: args[3] ?? null, event_sequence: 7 }); },
  });
  const contract = { allowed_paths: ['src/**'], forbidden_paths: [], acceptance_criteria: [], risk: 'low', budgets: {}, authority: 'local', external_write_policy: 'approval_required' };
  assert.equal(startTask('/repo', { objective: 'safe change', contract }).status, 'created');
  assert.equal(transitionTask('/repo', 'TASK-ABCDEFGHIJKL', 'orienting').status, 'orienting');
  assert.equal(authorizeAction('/repo', 'TASK-ABCDEFGHIJKL', { kind: 'write', path: 'src/new.js' }).allowed, true);
  assert.equal(recordAdapterLifecycle('/repo', 'TASK-ABCDEFGHIJKL', 'adapter_session_ended', 0).event_sequence, 7);
  assert.deepEqual(calls[0], ['start', '/repo', 'safe change', JSON.stringify(contract)]);
  assert.deepEqual(calls[3], ['lifecycle', '/repo', 'TASK-ABCDEFGHIJKL', 'adapter_session_ended', 0]);
});
