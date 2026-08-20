'use strict';

// Node is intentionally only a transport adapter. The Rust `icarus-harness` crate is the sole
// authority for durable repository state, policies, events, locks, task contracts, and action
// authorization. Keep this module small so CLI/TUI/MCP behaviour cannot drift from the core.
let testBridge = null;

function bridge() {
  return testBridge || require('./native.js');
}

function invoke(method, args) {
  const native = bridge();
  if (typeof native[method] !== 'function') {
    throw new Error(`ICARUS native harness bridge is unavailable (${method}); install a matching ICARUS binary`);
  }
  return JSON.parse(native[method](...args));
}

function initHarness(repoRoot, options = {}) {
  return invoke('harnessInit', [repoRoot, options.agents || []]);
}

function doctor(repoRoot) {
  return invoke('harnessDoctor', [repoRoot]);
}

function startTask(repoRoot, { objective, contract }) {
  return invoke('harnessStartTask', [repoRoot, objective, JSON.stringify(contract)]);
}

function taskStatus(repoRoot, taskId) {
  return invoke('harnessTaskStatus', [repoRoot, taskId]);
}

function transitionTask(repoRoot, taskId, target) {
  return invoke('harnessTransitionTask', [repoRoot, taskId, target]);
}

function resumeTask(repoRoot, taskId) {
  return invoke('harnessResumeTask', [repoRoot, taskId]);
}

function prepareRun(repoRoot, taskId, agent, workspaceMode, acknowledgeDirtyCurrent) {
  return invoke('harnessPrepareRun', [repoRoot, taskId, agent, workspaceMode, !!acknowledgeDirtyCurrent]);
}

function verifyTaskCriterion(repoRoot, taskId, criterionId) {
  return invoke('harnessVerifyTaskCriterion', [repoRoot, taskId, criterionId]);
}

function amendTaskContract(repoRoot, taskId, contract, reason, approvalId) {
  return invoke('harnessAmendTaskContract', [repoRoot, taskId, JSON.stringify(contract), reason, approvalId]);
}

function checkpointTask(repoRoot, taskId, phase, input) {
  return invoke('harnessCheckpointTask', [repoRoot, taskId, phase, JSON.stringify(input)]);
}

function buildContext(repoRoot, taskId, budgetTokens, checkpointSequence) {
  return checkpointSequence == null
    ? invoke('harnessBuildContext', [repoRoot, taskId, budgetTokens])
    : invoke('harnessBuildContextDelta', [repoRoot, taskId, checkpointSequence, budgetTokens]);
}

function recordGraphReceipt(repoRoot, sourceFingerprint) {
  return invoke('harnessRecordGraphReceipt', [repoRoot, sourceFingerprint]);
}

function authorizeAction(repoRoot, taskId, action) {
  return invoke('harnessAuthorizeAction', [repoRoot, taskId, action.kind, action.path]);
}

function __setNativeHarnessBridgeForTest(fakeBridge) {
  testBridge = fakeBridge;
}

module.exports = {
  initHarness,
  doctor,
  startTask,
  taskStatus,
  transitionTask,
  resumeTask,
  prepareRun,
  verifyTaskCriterion,
  amendTaskContract,
  checkpointTask,
  buildContext,
  recordGraphReceipt,
  authorizeAction,
  __setNativeHarnessBridgeForTest,
};
