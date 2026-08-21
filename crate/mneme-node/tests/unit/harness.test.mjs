import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  initHarness, migrateHarness, doctor, policyCheck, proposeSkill, promoteSkill, retireSkill, attestTaskCriterion,
  validateAgentArguments, reconcileRun, evaluateSkill, recordActiveSkillOutcome, reviewActiveSkills,
  bindCodexAppServerThread, recordCodexAppServerEvent, decideCodexAppServerApproval,
  runCodexAppServer,
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

test('harness migration is a thin native call and dry-run state is explicit', () => {
  const calls = [];
  __setNativeHarnessBridgeForTest({
    harnessMigrate(...args) {
      calls.push(args);
      return JSON.stringify({ dry_run: true, needed: true, applied: false, actions: ['copy legacy graph'] });
    },
  });
  assert.deepEqual(migrateHarness('/repo', { dryRun: true, agents: ['codex'] }), {
    dry_run: true, needed: true, applied: false, actions: ['copy legacy graph'],
  });
  assert.deepEqual(calls, [['/repo', true, ['codex']]]);
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

test('policy validation remains a native report, never a JavaScript YAML parser', () => {
  __setNativeHarnessBridgeForTest({
    harnessPolicyCheck(repo) {
      assert.equal(repo, '/repo');
      return JSON.stringify({ policy_version: 1, external_writes: 'approval_required', network: 'agent_managed', learning: 'proposal_only' });
    },
  });
  assert.equal(policyCheck('/repo').external_writes, 'approval_required');
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

test('isolated-worktree reconciliation remains a thin native transport', () => {
  const calls = [];
  __setNativeHarnessBridgeForTest({
    harnessReconcileRun(...args) {
      calls.push(args);
      return JSON.stringify({ task_id: 'TASK-1', reconciled: true, changed_files: ['src/lib.rs'] });
    },
  });
  assert.equal(reconcileRun('/repo', 'TASK-1').reconciled, true);
  assert.deepEqual(calls, [['/repo', 'TASK-1']]);
});

test('skill replay evaluation remains a native receipt operation', () => {
  const calls = [];
  __setNativeHarnessBridgeForTest({
    harnessEvaluateSkill(...args) {
      calls.push(args);
      return JSON.stringify({ skill_id: 'review', replay_task_id: 'TASK-9', status: 'pass' });
    },
  });
  assert.equal(evaluateSkill('/repo', 'review', 'TASK-9').status, 'pass');
  assert.deepEqual(calls, [['/repo', 'review', 'TASK-9']]);
});

test('active skill outcomes and demotion reviews remain native receipt operations', () => {
  const calls = [];
  __setNativeHarnessBridgeForTest({
    harnessRecordActiveSkillOutcome(...args) {
      calls.push(['outcome', args]);
      return JSON.stringify({ skill_id: 'review', replay_task_id: 'TASK-9', status: 'fail' });
    },
    harnessReviewActiveSkills(...args) {
      calls.push(['review', args]);
      return JSON.stringify({ scanned_skill_ids: ['review'], demoted_skill_ids: ['review'], issues: [] });
    },
  });
  assert.equal(recordActiveSkillOutcome('/repo', 'review', 'TASK-9').status, 'fail');
  assert.deepEqual(reviewActiveSkills('/repo').demoted_skill_ids, ['review']);
  assert.deepEqual(calls, [
    ['outcome', ['/repo', 'review', 'TASK-9']],
    ['review', ['/repo']],
  ]);
});

test('Codex app-server boundaries are transparent native transports, never JavaScript policy', () => {
  const calls = [];
  __setNativeHarnessBridgeForTest({
    harnessBindCodexAppServerThread(...args) {
      calls.push(['bind', args]);
      return JSON.stringify({ thread_id: 'thread-1', execution_id: 'exec-1' });
    },
    harnessRecordCodexAppServerEvent(...args) {
      calls.push(['event', args]);
      return JSON.stringify({ method: 'turn/started', event_sequence: 4 });
    },
    harnessDecideCodexAppServerApproval(...args) {
      calls.push(['approval', args]);
      return JSON.stringify({ decision: 'decline', reason: 'native policy', event_sequence: 5 });
    },
    harnessRunCodexAppServer(...args) {
      calls.push(['run', args]);
      return JSON.stringify({ completed: true });
    },
  });
  const params = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' };
  assert.equal(bindCodexAppServerThread('/repo', 'TASK-1', 'thread-1').thread_id, 'thread-1');
  assert.equal(recordCodexAppServerEvent('/repo', 'TASK-1', 'turn/started', params).event_sequence, 4);
  assert.equal(decideCodexAppServerApproval('/repo', 'TASK-1', 'item/fileChange/requestApproval', params).decision, 'decline');
  assert.equal(runCodexAppServer('/repo', 'TASK-1').completed, true);
  assert.deepEqual(calls, [
    ['bind', ['/repo', 'TASK-1', 'thread-1']],
    ['event', ['/repo', 'TASK-1', 'turn/started', JSON.stringify(params)]],
    ['approval', ['/repo', 'TASK-1', 'item/fileChange/requestApproval', JSON.stringify(params)]],
    ['run', ['/repo', 'TASK-1', undefined]],
  ]);
});
