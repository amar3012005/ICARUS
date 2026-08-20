import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { initHarness, doctor, __setNativeHarnessBridgeForTest } = require('../../harness.js');

afterEach(() => __setNativeHarnessBridgeForTest(null));

test('harness init is a thin native call: Node owns no repository state', () => {
  const calls = [];
  __setNativeHarnessBridgeForTest({
    harnessInit(...args) {
      calls.push(args);
      return JSON.stringify({ created: true, manifest: { repo_id: 'repo-0123456789abcdef' }, graph_migrated: false });
    },
  });
  assert.deepEqual(initHarness('/repo', { agents: ['codex'] }), {
    created: true, manifest: { repo_id: 'repo-0123456789abcdef' }, graph_migrated: false,
  });
  assert.deepEqual(calls, [['/repo', ['codex']]]);
});

test('doctor remains a native report, preserving the Rust authority boundary', () => {
  __setNativeHarnessBridgeForTest({
    harnessDoctor(repo) {
      assert.equal(repo, '/repo');
      return JSON.stringify({ healthy: true, checks: [{ id: 'event_chain', status: 'pass' }], issues: [] });
    },
  });
  assert.equal(doctor('/repo').healthy, true);
});
