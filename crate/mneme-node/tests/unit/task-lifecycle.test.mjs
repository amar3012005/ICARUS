import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startTask, transitionTask, authorizeAction, __setNativeHarnessBridgeForTest } = require('../../harness.js');

afterEach(() => __setNativeHarnessBridgeForTest(null));

test('task lifecycle commands transport values to the Rust authority unchanged', () => {
  const calls = [];
  __setNativeHarnessBridgeForTest({
    harnessStartTask(...args) { calls.push(['start', ...args]); return JSON.stringify({ task_id: 'TASK-ABCDEFGHIJKL', status: 'created' }); },
    harnessTransitionTask(...args) { calls.push(['transition', ...args]); return JSON.stringify({ task_id: args[1], status: args[2] }); },
    harnessAuthorizeAction(...args) { calls.push(['authorize', ...args]); return JSON.stringify({ allowed: true, reason: 'contract permits write' }); },
  });
  const contract = { allowed_paths: ['src/**'], forbidden_paths: [], acceptance_criteria: [], risk: 'low', budgets: {}, authority: 'local', external_write_policy: 'approval_required' };
  assert.equal(startTask('/repo', { objective: 'safe change', contract }).status, 'created');
  assert.equal(transitionTask('/repo', 'TASK-ABCDEFGHIJKL', 'orienting').status, 'orienting');
  assert.equal(authorizeAction('/repo', 'TASK-ABCDEFGHIJKL', { kind: 'write', path: 'src/new.js' }).allowed, true);
  assert.deepEqual(calls[0], ['start', '/repo', 'safe change', JSON.stringify(contract)]);
});
