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

function migrateHarness(repoRoot, { dryRun = false, agents = [] } = {}) {
  return invoke('harnessMigrate', [repoRoot, !!dryRun, agents]);
}

function doctor(repoRoot) {
  return invoke('harnessDoctor', [repoRoot]);
}

function doctorTask(repoRoot, taskId, worktree, branch) {
  return invoke('harnessDoctorTask', [repoRoot, taskId, worktree, branch]);
}

function policyCheck(repoRoot) {
  return invoke('harnessPolicyCheck', [repoRoot]);
}

function repositoryIdentity(repoRoot) {
  return invoke('harnessRepositoryIdentity', [repoRoot]);
}

function policyExplain(repoRoot, denialId) {
  return invoke('harnessPolicyExplain', [repoRoot, denialId]);
}

function startTask(repoRoot, { objective, contract, worktree, branch }) {
  return invoke('harnessStartTask', [repoRoot, objective, JSON.stringify(contract), worktree, branch]);
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

function validateAgentArguments(agent, agentArgs) {
  const native = bridge();
  if (typeof native.harnessValidateAgentArguments !== 'function') {
    throw new Error('ICARUS native harness bridge is unavailable (harnessValidateAgentArguments); install a matching ICARUS binary');
  }
  native.harnessValidateAgentArguments(agent, JSON.stringify(agentArgs || []));
}

function reconcileRun(repoRoot, taskId) {
  return invoke('harnessReconcileRun', [repoRoot, taskId]);
}

function verifyTaskCriterion(repoRoot, taskId, criterionId) {
  return invoke('harnessVerifyTaskCriterion', [repoRoot, taskId, criterionId]);
}

function attestTaskCriterion(repoRoot, taskId, criterionId, approvalId, approver, expiresAt) {
  return invoke('harnessAttestTaskCriterion', [repoRoot, taskId, criterionId, approvalId, approver, expiresAt]);
}

function sealTask(repoRoot, taskId) {
  return invoke('harnessSealTask', [repoRoot, taskId]);
}

function exportTask(repoRoot, taskId, redacted) {
  return invoke('harnessExportTask', [repoRoot, taskId, !!redacted]);
}

// Phase 9 release-candidate dogfood evidence is Rust-owned. Node only renders the report and
// cannot back-date the observation window, count tasks, or manufacture the owner attestation.
function startReleaseCandidateDogfood(repoRoot, releaseId) {
  return invoke('harnessStartReleaseCandidateDogfood', [repoRoot, releaseId]);
}
function releaseCandidateDogfoodReport(repoRoot) {
  return invoke('harnessReleaseCandidateDogfoodReport', [repoRoot]);
}
function attestReleaseCandidateDogfood(repoRoot, approvalId, approver) {
  return invoke('harnessAttestReleaseCandidateDogfood', [repoRoot, approvalId, approver]);
}

// Authority synchronization is deliberately a file/bundle boundary for now. These functions
// never receive credentials and cannot make network calls; Rust validates scope, expiry, digest,
// repository identity, and sealed receipt provenance before any value becomes usable.
function installAuthoritySnapshot(repoRoot, snapshotJson) {
  return invoke('harnessInstallAuthoritySnapshot', [repoRoot, snapshotJson]);
}

function installAuthoritySnapshotWithReplacement(repoRoot, snapshotJson, acceptReplacement) {
  return invoke('harnessInstallAuthoritySnapshotWithReplacement', [repoRoot, snapshotJson, !!acceptReplacement]);
}

function inspectAuthoritySync(repoRoot) {
  return invoke('harnessInspectAuthoritySync', [repoRoot]);
}

function buildAuthoritySyncRequest(repoRoot, taskId, scope) {
  return invoke('harnessBuildAuthoritySyncRequest', [repoRoot, taskId, JSON.stringify(scope)]);
}

function proposeSkill(repoRoot, skill) { return invoke('harnessProposeSkill', [repoRoot, JSON.stringify(skill)]); }
function evaluateSkill(repoRoot, skillId, replayTaskId, baselineTaskId) {
  return invoke('harnessEvaluateSkill', [repoRoot, skillId, replayTaskId, baselineTaskId]);
}
function recordActiveSkillOutcome(repoRoot, skillId, taskId) { return invoke('harnessRecordActiveSkillOutcome', [repoRoot, skillId, taskId]); }
function reviewActiveSkills(repoRoot) { return invoke('harnessReviewActiveSkills', [repoRoot]); }
function promoteSkill(repoRoot, skillId, ownerApproval) { return invoke('harnessPromoteSkill', [repoRoot, skillId, ownerApproval]); }
function retireSkill(repoRoot, skillId, reason, ownerApproval) { return invoke('harnessRetireSkill', [repoRoot, skillId, reason, ownerApproval]); }

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

// The native harness owns the precise supported-source universe and its portable ordering.
// Graph parsing remains in Node, but freshness proof must use this same Rust authority.
function graphSourceFingerprint(repoRoot) {
  return invoke('harnessGraphSourceFingerprint', [repoRoot]);
}

function skillAuthoringBrief(repoRoot, taskId) {
  return invoke('harnessSkillAuthoringBrief', [repoRoot, taskId]);
}

// Learning capture is a three-step protocol: Rust derives immutable sealed-task evidence,
// the caller explicitly approves its own structured draft, then this transport records the
// actual local-AMR id after persistence. No model-generated lesson is silently saved.
function createLearningCapture(repoRoot, taskId) {
  return invoke('harnessCreateLearningCapture', [repoRoot, taskId]);
}

function approveLearningCapture(repoRoot, captureId, captureDigest, draft) {
  return invoke('harnessApproveLearningCapture', [repoRoot, captureId, captureDigest, JSON.stringify(draft)]);
}

function recordLearningCaptureSaved(repoRoot, captureId, memoryId, draftDigest) {
  return invoke('harnessRecordLearningCaptureSaved', [repoRoot, captureId, memoryId, draftDigest]);
}

function authorizeAction(repoRoot, taskId, action) {
  return invoke('harnessAuthorizeAction', [repoRoot, taskId, action.kind, action.path]);
}

function authorizeAdapterWrite(repoRoot, taskId, agent, toolName, path) {
  return invoke('harnessAuthorizeAdapterWrite', [repoRoot, taskId, agent, toolName, path]);
}

function recordAdapterPostAction(repoRoot, taskId, agent, toolName, path) {
  return invoke('harnessRecordAdapterPostAction', [repoRoot, taskId, agent, toolName, path]);
}

// These are deliberately transparent protocol transports. The native harness, not this module,
// binds Codex's thread id, validates its event vocabulary, and decides every approval request.
function bindCodexAppServerThread(repoRoot, taskId, threadId) {
  return invoke('harnessBindCodexAppServerThread', [repoRoot, taskId, threadId]);
}

function recordCodexAppServerEvent(repoRoot, taskId, method, params) {
  return invoke('harnessRecordCodexAppServerEvent', [repoRoot, taskId, method, JSON.stringify(params)]);
}

function decideCodexAppServerApproval(repoRoot, taskId, method, params) {
  return invoke('harnessDecideCodexAppServerApproval', [repoRoot, taskId, method, JSON.stringify(params)]);
}

function runCodexAppServer(repoRoot, taskId, prompt) {
  return invoke('harnessRunCodexAppServer', [repoRoot, taskId, prompt]);
}

function handoffManagedTask(repoRoot, taskId) {
  return invoke('harnessHandoffManagedTask', [repoRoot, taskId]);
}

// A bounded receipt created by the local launcher, not a model-reported event. Rust restricts
// the event vocabulary and binds it to the prepared execution before appending it to the chain.
function recordAdapterLifecycle(repoRoot, taskId, eventType, exitCode) {
  return invoke('harnessRecordAdapterLifecycle', [repoRoot, taskId, eventType, exitCode]);
}

function __setNativeHarnessBridgeForTest(fakeBridge) {
  testBridge = fakeBridge;
}

module.exports = {
  initHarness,
  migrateHarness,
  doctor,
  doctorTask,
  policyCheck,
  repositoryIdentity,
  policyExplain,
  startTask,
  taskStatus,
  transitionTask,
  resumeTask,
  prepareRun,
  reconcileRun,
  validateAgentArguments,
  verifyTaskCriterion,
  attestTaskCriterion,
  sealTask,
  exportTask,
  installAuthoritySnapshot,
  installAuthoritySnapshotWithReplacement,
  inspectAuthoritySync,
  buildAuthoritySyncRequest,
  startReleaseCandidateDogfood,
  releaseCandidateDogfoodReport,
  attestReleaseCandidateDogfood,
  proposeSkill,
  evaluateSkill,
  recordActiveSkillOutcome,
  reviewActiveSkills,
  promoteSkill,
  retireSkill,
  amendTaskContract,
  checkpointTask,
  buildContext,
  recordGraphReceipt,
  graphSourceFingerprint,
  skillAuthoringBrief,
  createLearningCapture,
  approveLearningCapture,
  recordLearningCaptureSaved,
  authorizeAction,
  authorizeAdapterWrite,
  recordAdapterPostAction,
  bindCodexAppServerThread,
  recordCodexAppServerEvent,
  decideCodexAppServerApproval,
  runCodexAppServer,
  handoffManagedTask,
  recordAdapterLifecycle,
  __setNativeHarnessBridgeForTest,
};
