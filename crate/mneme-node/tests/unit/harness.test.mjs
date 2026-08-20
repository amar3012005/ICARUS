import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  initHarness, doctor, proposeSkill, promoteSkill, retireSkill, attestTaskCriterion,
  validateAgentArguments,
  __setNativeHarnessBridgeForTest,
} = require('../../harness.js');

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

test('skill governance remains a thin Rust transport, including attributable retirement', () => {
  const calls = [];
  __setNativeHarnessBridgeForTest({
    harnessProposeSkill(...args) { calls.push(['propose', args]); return JSON.stringify({ id: 'review', state: 'proposed' }); },
    harnessPromoteSkill(...args) { calls.push(['promote', args]); return JSON.stringify({ id: 'review', state: 'active' }); },
    harnessRetireSkill(...args) { calls.push(['retire', args]); return JSON.stringify({ id: 'review', state: 'retired' }); },
    harnessAttestTaskCriterion(...args) { calls.push(['attest', args]); return JSON.stringify({ criterion_id: 'owner', status: 'pass' }); },
  });
  const skill = { id: 'review', instructions: 'Use receipts.' };
  assert.equal(proposeSkill('/repo', skill).state, 'proposed');
  assert.equal(promoteSkill('/repo', 'review', 'APR-1').state, 'active');
  assert.equal(retireSkill('/repo', 'review', 'superseded', 'APR-2').state, 'retired');
  assert.equal(attestTaskCriterion('/repo', 'TASK-1', 'owner', 'APR-3', 'owner', '2099-01-01T00:00:00Z').status, 'pass');
  assert.deepEqual(calls, [
    ['propose', ['/repo', JSON.stringify(skill)]],
    ['promote', ['/repo', 'review', 'APR-1']],
    ['retire', ['/repo', 'review', 'superseded', 'APR-2']],
    ['attest', ['/repo', 'TASK-1', 'owner', 'APR-3', 'owner', '2099-01-01T00:00:00Z']],
  ]);
});

test('agent launch arguments are validated by Rust before Node can spawn a CLI', () => {
  const calls = [];
  __setNativeHarnessBridgeForTest({
    harnessValidateAgentArguments(...args) { calls.push(args); },
  });
  validateAgentArguments('codex', ['--model', 'gpt-5']);
  assert.deepEqual(calls, [['codex', '["--model","gpt-5"]']]);
});
