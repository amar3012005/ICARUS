import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startTask, transitionTask, authorizeAction, authorizeAdapterWrite, recordAdapterPostAction, handoffManagedTask, recordAdapterLifecycle, __setNativeHarnessBridgeForTest } = require('../../harness.js');

afterEach(() => __setNativeHarnessBridgeForTest(null));

test('task lifecycle commands transport values to the Rust authority unchanged', () => {
  const calls = [];
  __setNativeHarnessBridgeForTest({
    harnessStartTask(...args) { calls.push(['start', ...args]); return JSON.stringify({ task_id: 'TASK-ABCDEFGHIJKL', status: 'created' }); },
    harnessTransitionTask(...args) { calls.push(['transition', ...args]); return JSON.stringify({ task_id: args[1], status: args[2] }); },
    harnessAuthorizeAction(...args) { calls.push(['authorize', ...args]); return JSON.stringify({ allowed: true, reason: 'contract permits write' }); },
    harnessAuthorizeAdapterWrite(...args) { calls.push(['adapter-authorize', ...args]); return JSON.stringify({ allowed: true, event_sequence: 6 }); },
    harnessRecordAdapterPostAction(...args) { calls.push(['adapter-post-action', ...args]); return JSON.stringify({ event_sequence: 7 }); },
    harnessHandoffManagedTask(...args) { calls.push(['handoff', ...args]); return JSON.stringify({ status: 'verifying', event_sequence: 8 }); },
    harnessRecordAdapterLifecycle(...args) { calls.push(['lifecycle', ...args]); return JSON.stringify({ event_type: args[2], exit_code: args[3] ?? null, event_sequence: 9 }); },
  });
  const contract = { allowed_paths: ['src/**'], forbidden_paths: [], acceptance_criteria: [], risk: 'low', budgets: {}, authority: 'local', external_write_policy: 'approval_required' };
  assert.equal(startTask('/repo', { objective: 'safe change', contract }).status, 'created');
  assert.equal(transitionTask('/repo', 'TASK-ABCDEFGHIJKL', 'orienting').status, 'orienting');
  assert.equal(authorizeAction('/repo', 'TASK-ABCDEFGHIJKL', { kind: 'write', path: 'src/new.js' }).allowed, true);
  assert.equal(authorizeAdapterWrite('/repo', 'TASK-ABCDEFGHIJKL', 'claude', 'Edit', 'src/new.js').event_sequence, 6);
  assert.equal(recordAdapterPostAction('/repo', 'TASK-ABCDEFGHIJKL', 'claude', 'Edit', 'src/new.js').event_sequence, 7);
  assert.equal(handoffManagedTask('/repo', 'TASK-ABCDEFGHIJKL').status, 'verifying');
  assert.equal(recordAdapterLifecycle('/repo', 'TASK-ABCDEFGHIJKL', 'adapter_session_ended', 0).event_sequence, 9);
  assert.deepEqual(calls[0], ['start', '/repo', 'safe change', JSON.stringify(contract)]);
  assert.deepEqual(calls[3], ['adapter-authorize', '/repo', 'TASK-ABCDEFGHIJKL', 'claude', 'Edit', 'src/new.js']);
  assert.deepEqual(calls[4], ['adapter-post-action', '/repo', 'TASK-ABCDEFGHIJKL', 'claude', 'Edit', 'src/new.js']);
  assert.deepEqual(calls[5], ['handoff', '/repo', 'TASK-ABCDEFGHIJKL']);
  assert.deepEqual(calls[6], ['lifecycle', '/repo', 'TASK-ABCDEFGHIJKL', 'adapter_session_ended', 0]);
});
