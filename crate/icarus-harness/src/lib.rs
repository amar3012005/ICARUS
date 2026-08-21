//! ICARUS Harness durable runtime.
//!
//! This crate deliberately owns no model client, agent adapter, or network transport. It is the
//! local authority for repository identity, policy, event history, locks, and runtime snapshots.
//! Language bindings may call it, but must not reimplement these invariants.

mod codex_app_server;

use globset::{Glob, GlobSetBuilder};
use mneme_bm25::{bm25_search, Bm25Doc, Bm25Params};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error as StdError;
use std::fmt::{Display, Formatter};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Run one governed Codex app-server turn through Rust's process, policy, event and lifecycle
/// authority. This uses the user-installed `codex` client and never supplies a model or key.
pub fn run_codex_app_server_bridge(
    repo_root: &Path,
    task_id: &str,
    prompt: Option<&str>,
) -> Result<()> {
    codex_app_server::run(repo_root, task_id, prompt, "codex")
}

/// Developer/test variant of the same bridge. Production N-API callers cannot choose an
/// arbitrary command; this remains public only so the standalone bridge binary can use a
/// deliberate local fixture without duplicating authority code.
pub fn run_codex_app_server_bridge_with_command(
    repo_root: &Path,
    task_id: &str,
    prompt: Option<&str>,
    command: &str,
) -> Result<()> {
    codex_app_server::run(repo_root, task_id, prompt, command)
}

const MANIFEST_VERSION: u32 = 1;
const RUNTIME_DIR: &str = ".icarus/runtime";
const LOCK_STALE_AFTER: Duration = Duration::from_secs(15 * 60);
// Event appends are normally milliseconds long, but an adapter hook can legitimately arrive
// while the launcher records its adjacent lifecycle event. Wait briefly for that live owner;
// continuing past this bounded window would hide a wedged writer, so it remains fail-closed.
const LOCK_CONTENTION_RETRIES: usize = 25;
const LOCK_CONTENTION_DELAY: Duration = Duration::from_millis(20);
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone)]
pub struct HarnessError(String);

impl HarnessError {
    fn invalid(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl Display for HarnessError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl StdError for HarnessError {}

impl From<std::io::Error> for HarnessError {
    fn from(error: std::io::Error) -> Self {
        Self(error.to_string())
    }
}

impl From<serde_json::Error> for HarnessError {
    fn from(error: serde_json::Error) -> Self {
        Self(error.to_string())
    }
}

impl From<serde_yaml::Error> for HarnessError {
    fn from(error: serde_yaml::Error) -> Self {
        Self(error.to_string())
    }
}

pub type Result<T> = std::result::Result<T, HarnessError>;

#[derive(Debug, Clone, Default)]
pub struct InitOptions {
    pub agents: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u32,
    pub harness_version: u32,
    pub repo_id: String,
    pub repo_root: String,
    pub git_remote_fingerprint: String,
    pub policy_version: u32,
    pub agents: Vec<String>,
}

/// Repository-local governance settings. This deliberately stays small in v1: the Rust core
/// validates the settings which affect managed execution, while future policy modules can add
/// their own versioned documents instead of turning this file into an untyped bag of flags.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RepositoryPolicy {
    pub policy_version: u32,
    pub external_writes: String,
    pub network: String,
    pub learning: String,
}

#[derive(Debug, Clone)]
pub struct InitResult {
    pub created: bool,
    pub manifest: Manifest,
    pub graph_migrated: bool,
}

/// Non-destructive upgrade plan for a repository created by a pre-harness ICARUS release.
/// Migration concerns only harness metadata and graph placement; `.amr` files are intentionally
/// outside this subsystem and are never opened, rewritten, or moved here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MigrationReport {
    pub schema_version: u32,
    pub dry_run: bool,
    pub needed: bool,
    pub applied: bool,
    pub actions: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct EventInput {
    pub execution_id: String,
    pub task_id: String,
    pub event_type: String,
    pub worktree_id: String,
    pub timestamp: Option<String>,
    pub payload: Value,
}

impl EventInput {
    pub fn new(
        execution_id: impl Into<String>,
        task_id: impl Into<String>,
        event_type: impl Into<String>,
    ) -> Self {
        Self {
            execution_id: execution_id.into(),
            task_id: task_id.into(),
            event_type: event_type.into(),
            worktree_id: "main".into(),
            timestamp: None,
            payload: json!({}),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeEvent {
    pub schema_version: u32,
    pub execution_id: String,
    pub task_id: String,
    pub sequence: u64,
    pub event_type: String,
    pub timestamp: String,
    pub repo_id: String,
    pub worktree_id: String,
    pub payload: Value,
    pub previous_hash: Option<String>,
    pub event_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainReport {
    pub valid: bool,
    pub events: usize,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DoctorCheck {
    pub id: String,
    pub status: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DoctorReport {
    pub healthy: bool,
    pub repo_id: Option<String>,
    pub checks: Vec<DoctorCheck>,
    pub issues: Vec<String>,
}

/// Immutable v1 execution contract. A future amendment must create a new version rather than
/// mutating the contract stored with an existing task.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TaskContract {
    pub allowed_paths: Vec<String>,
    pub forbidden_paths: Vec<String>,
    pub acceptance_criteria: Value,
    pub risk: String,
    pub budgets: Value,
    pub authority: String,
    pub external_write_policy: String,
    /// Immutable links to decisions the agent must consider. They resolve only from an explicit
    /// repository snapshot or local authority cache; the compiler never broad-searches a tenant.
    #[serde(default)]
    pub decision_references: Vec<String>,
    /// Optional classifier supplied by the calling agent for selecting verified operating skills.
    #[serde(default)]
    pub task_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TaskRecord {
    pub schema_version: u32,
    pub task_id: String,
    pub objective: String,
    pub status: String,
    pub contract_version: u32,
    pub contract_digest: String,
    pub contract: TaskContract,
    pub execution_id: String,
    pub previous_execution_id: Option<String>,
}

/// A Rust-authorized launch workspace. Adapters receive this value but do not choose the task
/// scope, workspace, or compatibility claim themselves.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RunPreparation {
    pub task_id: String,
    pub execution_id: String,
    pub agent: String,
    pub workspace_mode: String,
    pub worktree_id: String,
    pub workspace_path: String,
    pub base_git_sha: Option<String>,
    pub base_dirty_state_fingerprint: String,
    /// A launch-time copy of the Rust-generated pack placed inside the launch workspace. Its
    /// digest is recorded in the authority runtime so later verification can detect divergence.
    pub context_pack_path: String,
    pub context_pack_hash: String,
    /// Ephemeral, Rust-generated adapter configuration passed by the presentation layer without
    /// interpretation. These files are ignored runtime state, never repository instructions.
    pub adapter_config_paths: Vec<String>,
    /// Optional task-scoped settings passed using the adapter's documented settings flag. It is
    /// separate from MCP configuration because hooks and permissions are not valid MCP fields.
    pub adapter_settings_path: Option<String>,
    /// `certified` is reserved for adapters that have passed the complete enforcement contract.
    /// No current adapter may self-assert it from JavaScript launch code.
    pub certification: String,
    pub capabilities: AdapterCapabilities,
    /// Exact, deterministic CLI arguments selected from the task's governed workspace. Node may
    /// launch them, but may not weaken the safety posture or invent an adapter profile.
    pub launch_arguments: Vec<String>,
    pub compatibility_mode: bool,
    /// Rust-derived latest time at which a managed adapter may run. `None` means the immutable
    /// task contract did not configure a wall-time budget. Presentation code may enforce this
    /// deadline but cannot select or extend it.
    #[serde(default)]
    pub wall_time_deadline: Option<String>,
    /// Hashes of paths that were already dirty or untracked when a current-workspace run was
    /// authorized. Rust uses this immutable launch baseline to distinguish the user's existing
    /// work from an adapter's post-launch delta; contents never enter runtime state.
    #[serde(default)]
    pub current_workspace_baseline: BTreeMap<String, String>,
}

/// Result of importing an isolated, governed worktree into the authoritative repository. A
/// reconciliation is deliberately explicit evidence: a launcher may not treat changes made in a
/// detached worktree as verified until this operation has checked and applied them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReconciliationResult {
    pub task_id: String,
    pub execution_id: String,
    pub workspace_mode: String,
    pub reconciled: bool,
    pub changed_files: Vec<String>,
    pub patch_digest: Option<String>,
}

/// Capability declaration emitted by the Rust authority, never inferred from an agent name.
/// A missing pre-action or completion interception is enough to keep an adapter in compatibility
/// mode even when ICARUS can still prepare an isolated workspace and record lifecycle state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AdapterCapabilities {
    pub workspace_isolation: bool,
    pub task_scoped_context: bool,
    pub pre_action_authorization: bool,
    pub post_action_event_capture: bool,
    pub completion_interception: bool,
    pub external_write_interception: bool,
    pub stable_session_identity: bool,
}

fn adapter_capabilities(_agent: &str) -> AdapterCapabilities {
    // The launcher currently starts the user-installed CLI and can only prove these two
    // properties. Do not promote Claude/Codex by reputation: certification needs hook/event
    // conformance evidence, which has not been implemented yet.
    AdapterCapabilities {
        workspace_isolation: true,
        task_scoped_context: true,
        pre_action_authorization: false,
        post_action_event_capture: false,
        completion_interception: false,
        external_write_interception: false,
        stable_session_identity: false,
    }
}

fn adapter_launch_arguments(
    agent: &str,
    workspace: &Path,
    task_id: &str,
    context_pack_path: &Path,
    adapter_config_paths: &[PathBuf],
    adapter_settings_path: Option<&Path>,
) -> Vec<String> {
    let workspace = external_path(workspace);
    match agent {
        // Codex's built-in sandbox is an additional boundary around the isolated worktree.
        // `on-request` keeps potentially external/elevated commands visible to the human.
        "codex" => {
            let developer_instructions = format!(
                "This is governed ICARUS task {task_id}. Read the launch-time ICARUS context pack at {} before planning. Use the ICARUS MCP lifecycle and verification tools; do not claim verification without ICARUS receipts.",
                external_path(context_pack_path),
            );
            // `--config` values are documented Codex TOML overrides. They are constructed here,
            // in Rust, and user-provided config/profile flags are rejected below so this launch
            // cannot be redirected away from the task-local MCP server or its workspace.
            vec![
                "--cd".into(),
                workspace.clone(),
                "--sandbox".into(),
                "workspace-write".into(),
                "--ask-for-approval".into(),
                "on-request".into(),
                "--strict-config".into(),
                "--config".into(),
                "mcp_servers.icarus.command=\"icarus\"".into(),
                "--config".into(),
                "mcp_servers.icarus.args=[\"mcp\", \"serve\"]".into(),
                "--config".into(),
                format!(
                    "mcp_servers.icarus.cwd={}",
                    serde_json::to_string(&workspace).expect("workspace path serializes")
                ),
                "--config".into(),
                "mcp_servers.icarus.required=true".into(),
                "--config".into(),
                "mcp_servers.icarus.default_tools_approval_mode=\"prompt\"".into(),
                "--config".into(),
                format!(
                    "developer_instructions={}",
                    serde_json::to_string(&developer_instructions).expect("instruction serializes")
                ),
            ]
        }
        // Claude Code's manual permission mode is the non-bypass posture. It is deliberately
        // not advertised as an ICARUS interception hook; MCP/context instructions remain the
        // compatibility surface until hook conformance is implemented.
        "claude" => {
            let mut arguments = vec![
                "--permission-mode".into(),
                "manual".into(),
                "--append-system-prompt".into(),
                format!(
                    "This is governed ICARUS task {task_id}. Read the launch-time ICARUS context pack at {} before planning; do not claim verification without ICARUS receipts.",
                    external_path(context_pack_path),
                ),
            ];
            for config in adapter_config_paths {
                arguments.push("--mcp-config".into());
                arguments.push(external_path(config));
            }
            // The generated file provides the ICARUS task lifecycle/context tools. Requiring
            // this explicit config prevents unrelated user/global MCP configuration from
            // silently becoming part of a governed session.
            if !adapter_config_paths.is_empty() {
                arguments.push("--strict-mcp-config".into());
            }
            if let Some(settings) = adapter_settings_path {
                // `--settings` is Claude Code's documented per-session settings input. It
                // loads the Rust-generated hook policy without writing tracked repository
                // settings, and user-provided `--settings` is rejected by the native argument
                // validator below.
                arguments.push("--settings".into());
                arguments.push(external_path(settings));
            }
            arguments
        }
        // Cursor/Grok are only launched from the isolated CWD at present. Their capabilities
        // remain explicit compatibility mode rather than assumed parity with the CLIs above.
        _ => Vec::new(),
    }
}

/// Create only those adapter files whose format is documented by the installed client. The
/// content is generated by Rust and passed verbatim by Node; it is not a user-editable source of
/// authority. Claude's MCP process inherits the selected workspace as its working directory,
/// which makes the registered ICARUS server repository-local by default.
fn persist_adapter_config(
    workspace: &Path,
    task: &TaskRecord,
    agent: &str,
) -> Result<(Vec<PathBuf>, Option<PathBuf>)> {
    if agent != "claude" {
        return Ok((Vec::new(), None));
    }
    let directory = workspace
        .join(".icarus/runtime/adapters")
        .join(&task.task_id);
    let mcp_path = directory.join(format!("{}.claude-mcp.json", task.execution_id));
    let mcp_config = serde_json::to_vec_pretty(&json!({
        "mcpServers": {
            "icarus": {
                "command": "icarus",
                "args": ["mcp", "serve"]
            }
        }
    }))?;
    atomic_write(&mcp_path, &mcp_config)?;

    // Claude Code command hooks receive their event payload on stdin. The generated command
    // delegates every decision to `icarus harness hook`, which validates the task execution in
    // Rust. It is intentionally scoped to Edit/Write: arbitrary Bash cannot be soundly reduced
    // to a set of files before shell execution, so it remains manual-permission compatibility
    // mode rather than pretending full command interception exists.
    let hook_command = |event: &str| {
        format!(
            "icarus harness hook --task {} --event {event} --repo \"$CLAUDE_PROJECT_DIR\"",
            task.task_id
        )
    };
    let settings_path = directory.join(format!("{}.claude-settings.json", task.execution_id));
    let settings = serde_json::to_vec_pretty(&json!({
        "disableAllHooks": false,
        "hooks": {
            "PreToolUse": [{
                "matcher": "Edit|Write",
                "hooks": [{"type": "command", "command": hook_command("pre-tool"), "timeout": 30}]
            }],
            "PostToolUse": [{
                "matcher": "Edit|Write",
                "hooks": [{"type": "command", "command": hook_command("post-tool"), "timeout": 30}]
            }],
            "Stop": [{
                "hooks": [{"type": "command", "command": hook_command("stop"), "timeout": 30}]
            }]
        }
    }))?;
    atomic_write(&settings_path, &settings)?;
    Ok((vec![mcp_path], Some(settings_path)))
}

fn persist_launch_context(
    root: &Path,
    workspace: &Path,
    task: &TaskRecord,
) -> Result<(PathBuf, String)> {
    // Compile before launching an agent and persist the exact same JSON in the authoritative
    // runtime and in the selected workspace. The workspace copy is deliberately local/ignored:
    // it makes a managed run self-contained without putting task context into source control.
    let pack = build_context(root, &task.task_id, 12_000)?;
    let json = format!("{}\n", serde_json::to_string_pretty(&pack)?);
    let markdown = render_context_markdown(&pack);
    let digest = sha256(json.as_bytes());
    let relative = format!("context/{}/{}", task.task_id, task.execution_id);
    atomic_write(
        &runtime_root(root).join(format!("{relative}.json")),
        json.as_bytes(),
    )?;
    atomic_write(
        &runtime_root(root).join(format!("{relative}.md")),
        markdown.as_bytes(),
    )?;

    let workspace_pack = workspace
        .join(".icarus/runtime/context")
        .join(&task.task_id)
        .join(format!("{}.md", task.execution_id));
    if workspace != root {
        atomic_write(&workspace_pack, markdown.as_bytes())?;
    }
    Ok((workspace_pack, digest))
}

/// Permit ordinary model/UX arguments after `icarus run -- ...`, but reject options that could
/// weaken or replace the governed launch posture. This guard is native so a JavaScript adapter
/// cannot accidentally let a later argument override its Rust-selected sandbox or approval mode.
pub fn validate_agent_arguments(agent: &str, arguments: &[String]) -> Result<()> {
    let forbidden: &[&str] = match agent {
        "codex" => &[
            "--dangerously-bypass-approvals-and-sandbox",
            "--dangerously-bypass-hook-trust",
            "--sandbox",
            "-s",
            "--ask-for-approval",
            "-a",
            "--cd",
            "-C",
            "--add-dir",
            "--config",
            "-c",
            "--profile",
            "-p",
            "--remote",
            "--remote-auth-token-env",
            "--strict-config",
        ],
        "claude" => &[
            "--dangerously-skip-permissions",
            "--allow-dangerously-skip-permissions",
            "--permission-mode",
            "--append-system-prompt",
            "--system-prompt",
            "--add-dir",
            "--settings",
            "--setting-sources",
            "--strict-mcp-config",
            "--mcp-config",
        ],
        _ => &[],
    };
    if let Some(argument) = arguments.iter().find(|argument| {
        forbidden.iter().any(|blocked| {
            argument == blocked
                || argument
                    .strip_prefix(blocked)
                    .is_some_and(|suffix| suffix.starts_with('='))
        }) || matches!(agent, "codex")
            && ["-s", "-a", "-C", "-c", "-p"]
                .iter()
                .any(|short| argument.starts_with(short))
    }) {
        return Err(HarnessError::invalid(format!(
            "agent argument `{argument}` would override ICARUS-managed launch policy"
        )));
    }
    Ok(())
}

/// Evidence produced by ICARUS itself for one contract criterion. Agent prose is deliberately
/// absent: only an executed command, inspected artifact, or explicit pending human gate can
/// create one of these records.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct VerificationReceipt {
    pub schema_version: u32,
    pub task_id: String,
    pub execution_id: String,
    pub criterion_id: String,
    pub criterion_type: String,
    pub status: String,
    pub command: Option<String>,
    pub working_directory: String,
    pub started_at: String,
    pub finished_at: String,
    pub exit_code: Option<i32>,
    pub git_sha: Option<String>,
    pub dirty_state_fingerprint: String,
    pub contract_digest: String,
    pub toolchain: Value,
    pub output_digest: String,
    pub output_excerpt: String,
    pub output_path: String,
    pub artifacts: Vec<String>,
    /// Present only for a human/manual or external-approval attestation. An external approval
    /// must have a future expiry at attestation time and again at seal time.
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub attestation: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SealResult {
    pub task_id: String,
    pub execution_id: String,
    pub sealed: bool,
    pub unmet_criteria: Vec<String>,
    pub issues: Vec<String>,
    pub final_receipt_path: Option<String>,
}

/// A shareable view of a sealed task's deterministic receipt. It is constructed on demand from
/// the final receipt rather than copying private runtime logs into a new long-lived artifact.
/// With `redacted`, free text, paths, attestation identities, and tool output are omitted while
/// content digests and pass/fail evidence remain independently reviewable.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TaskExport {
    pub schema_version: u32,
    pub task_id: String,
    pub execution_id: String,
    pub status: String,
    pub redacted: bool,
    pub git_sha: Option<String>,
    pub dirty_state_fingerprint: String,
    pub diff_digest: String,
    pub criteria: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub objective: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_receipt_path: Option<String>,
}

/// A harness procedure, never a chat persona. Candidates have no execution authority until the
/// Rust promotion gate places them in `.icarus/skills/active`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HarnessSkill {
    pub schema_version: u32,
    pub id: String,
    pub state: String,
    pub triggers: Vec<String>,
    pub instructions: String,
    pub allowed_tools: Vec<String>,
    pub policy_requirements: Vec<String>,
    pub verification_steps: Vec<String>,
    pub source_tasks: Vec<String>,
    #[serde(default)]
    pub decision_references: Vec<String>,
    /// Explicit task classifiers this procedure may influence. Empty means it is not eligible
    /// for managed context; broad skills must still state their intended task classes.
    #[serde(default)]
    pub task_types: Vec<String>,
    /// Repository-relative path globs that bound where this procedure applies. Empty means it
    /// is not eligible for managed context.
    #[serde(default)]
    pub file_patterns: Vec<String>,
    /// RFC3339 proof expiry. Missing or expired proof leaves a record auditable but ineligible
    /// for a new managed context until it has been re-evaluated and promoted again.
    #[serde(default)]
    pub proof_expires_at: Option<String>,
    pub risk: String,
    pub owner: String,
    pub version: u32,
    pub confidence: f64,
    #[serde(default)]
    pub replay_results: Vec<Value>,
    /// Written only by the Rust promotion/retirement gates. Context compilation requires
    /// `status: verified`, so an agent-authored candidate cannot grant itself authority.
    #[serde(default)]
    pub verification: Value,
}

/// A native record of an independently sealed task used to evaluate a proposed procedure.
/// Candidate-provided `replay_results` remain retained for backwards-compatible display only;
/// they never grant promotion authority.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SkillEvaluation {
    pub schema_version: u32,
    pub skill_id: String,
    pub candidate_digest: String,
    pub replay_task_id: String,
    pub replay_execution_id: String,
    pub status: String,
    pub source_task_ids: Vec<String>,
    pub final_receipt_digest: String,
    pub observed_at: String,
    pub issues: Vec<String>,
}

/// Result of the deterministic active-skill health pass. A demotion changes the tracked active
/// record and writes a runtime audit archive; it never erases the procedure or its evidence.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SkillHealthReview {
    pub schema_version: u32,
    pub reviewed_at: String,
    pub scanned_skill_ids: Vec<String>,
    pub demoted_skill_ids: Vec<String>,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Action {
    pub kind: String,
    pub path: Option<String>,
}

impl Action {
    pub fn write(path: impl Into<String>) -> Self {
        Self {
            kind: "write".into(),
            path: Some(path.into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Authorization {
    pub allowed: bool,
    pub reason: String,
}

/// A bounded, launcher-observed lifecycle receipt. This deliberately records only facts the
/// ICARUS launcher can observe (a process was started or exited); it is not an agent assertion
/// and does not stand in for pre-tool interception. Keeping the payload typed prevents a client
/// from smuggling unreviewed model prose into the authoritative event chain.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AdapterLifecycleReceipt {
    pub schema_version: u32,
    pub task_id: String,
    pub execution_id: String,
    pub agent: String,
    pub event_type: String,
    pub worktree_id: String,
    pub exit_code: Option<i32>,
    pub event_sequence: u64,
}

/// A pre-action authorization decision recorded as a first-class audit event. The decision is
/// made by Rust from the immutable task contract; a hook client only supplies the adapter's
/// already-normalized tool name and candidate repository-relative path.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AdapterAuthorizationReceipt {
    pub schema_version: u32,
    pub task_id: String,
    pub execution_id: String,
    pub agent: String,
    pub tool_name: String,
    pub path: String,
    pub allowed: bool,
    pub reason: String,
    /// Present only for a Rust-recorded denial. The identifier resolves to a durable, bounded
    /// policy explanation; callers must not manufacture explanations from the reason string.
    pub denial_id: Option<String>,
    pub event_sequence: u64,
}

/// A durable explanation of an authorization denial. It contains only the policy decision and
/// normalized tool boundary—not model text, file contents, or arbitrary hook payloads.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PolicyDenial {
    pub schema_version: u32,
    pub denial_id: String,
    pub task_id: String,
    pub execution_id: String,
    pub agent: String,
    pub tool_name: String,
    pub path: String,
    pub reason: String,
    pub event_sequence: u64,
}

/// A typed post-action receipt captured by a documented adapter hook. It describes only the
/// tool boundary, not whether the requested contents were semantically correct; verification
/// and sealing remain separate Rust-owned operations.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AdapterPostActionReceipt {
    pub schema_version: u32,
    pub task_id: String,
    pub execution_id: String,
    pub agent: String,
    pub tool_name: String,
    pub path: String,
    pub event_sequence: u64,
}

/// A Rust-owned binding between a governed ICARUS execution and a Codex app-server thread.
///
/// The thread id is supplied by Codex, but it is never trusted merely because it is well-formed:
/// every later app-server event must match this persisted binding before ICARUS will record it or
/// make an approval decision. This keeps stable session identity out of the Node/TUI layer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CodexAppServerSession {
    pub schema_version: u32,
    pub task_id: String,
    pub execution_id: String,
    pub agent: String,
    pub thread_id: String,
    pub worktree_id: String,
    /// Proposed file paths observed in a structured `item/started` file-change item. They are
    /// held only until the matching item is approved/completed; an approval request that arrives
    /// without this prior evidence fails closed.
    #[serde(default)]
    pub pending_file_changes: BTreeMap<String, Vec<String>>,
    /// Paths that passed the task contract and received a one-shot approval. Completion must
    /// report this exact path set before the bridge treats the write as observed.
    #[serde(default)]
    pub approved_file_changes: BTreeMap<String, Vec<String>>,
}

/// A receipt for a structured Codex app-server boundary. It intentionally excludes model text,
/// command bodies and patches: those are untrusted presentation data. The durable event chain
/// stores only the protocol fact and stable identifiers needed for later audit and resume.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CodexAppServerEventReceipt {
    pub schema_version: u32,
    pub task_id: String,
    pub execution_id: String,
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub method: String,
    pub event_sequence: u64,
}

/// A fail-closed reply to a Codex app-server approval request. `decision` is deliberately the
/// exact app-server vocabulary (currently `decline`) so a transport can forward it verbatim
/// without interpreting policy.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CodexAppServerApproval {
    pub schema_version: u32,
    pub task_id: String,
    pub execution_id: String,
    pub thread_id: String,
    pub method: String,
    pub decision: String,
    pub reason: String,
    pub event_sequence: u64,
}

/// A Rust-owned boundary between an agent's implementation session and deterministic
/// verification. It records no claim that tests passed; it merely prevents a managed adapter
/// from treating an ordinary conversational stop as task completion.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ManagedTaskHandoffReceipt {
    pub schema_version: u32,
    pub task_id: String,
    pub execution_id: String,
    pub agent: String,
    pub worktree_id: String,
    pub status: String,
    pub event_sequence: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    pub schema_version: u32,
    pub task_id: String,
    pub execution_id: String,
    pub sequence: u64,
    pub phase: String,
    pub git_sha: Option<String>,
    pub dirty_state_fingerprint: String,
    pub files_touched: Vec<String>,
    pub graph_version: Option<String>,
    pub context_pack_hash: Option<String>,
    pub budget_consumption: Value,
    pub open_risks: Value,
    pub next_valid_action: Option<String>,
    pub input: Value,
}

/// One traceable context item. `digest` identifies exact source content; the compiler never
/// turns repository material into untraceable model prose.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ContextItem {
    pub kind: String,
    pub source: String,
    pub digest: String,
    pub freshness: String,
    pub authority: String,
    pub retrieval_reason: String,
    pub mandatory: bool,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ContextPack {
    pub schema_version: u32,
    pub task_id: String,
    pub execution_id: String,
    pub status: String,
    pub base_checkpoint_sequence: Option<u64>,
    pub budget_tokens: usize,
    /// Conservative upper bound: UTF-8 bytes are never fewer than tokens for byte-based BPE
    /// tokenizers. It is deliberately conservative until a selected adapter supplies its exact
    /// tokenizer; the compiler must never promise a pack fits when it does not.
    pub upper_bound_tokens: usize,
    pub items: Vec<ContextItem>,
}

/// The Rust authority records the exact graph database and source set that a graph build
/// observed. The graph parser may be supplied by an adapter, but it cannot make an unverified
/// freshness claim on its own.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GraphReceipt {
    pub schema_version: u32,
    pub source_fingerprint: String,
    pub graph_digest: String,
    pub recorded_at: String,
}

fn sha256(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

fn canonical_root(repo_root: &Path) -> Result<PathBuf> {
    repo_root.canonicalize().map_err(HarnessError::from)
}

/// Rust keeps canonical paths for authority checks. Windows represents those as `\\?\C:\…`,
/// but Git, cmd.exe, and several CLI adapters reject that extended-length presentation. Convert
/// only when crossing into an external process or serializing a launch configuration; never use
/// this presentation for filesystem authorization.
fn external_path(path: &Path) -> String {
    let rendered = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(unc) = rendered.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc}");
        }
        if let Some(normal) = rendered.strip_prefix(r"\\?\") {
            return normal.to_owned();
        }
    }
    rendered.into_owned()
}

fn manifest_path(root: &Path) -> PathBuf {
    root.join(".icarus/manifest.yaml")
}
fn runtime_root(root: &Path) -> PathBuf {
    root.join(RUNTIME_DIR)
}
fn events_path(root: &Path) -> PathBuf {
    runtime_root(root).join("logs/events.jsonl")
}
fn locks_dir(root: &Path) -> PathBuf {
    runtime_root(root).join("locks")
}

fn remote_url(root: &Path) -> String {
    Command::new("git")
        .args([
            "-C",
            &external_path(root),
            "config",
            "--get",
            "remote.origin.url",
        ])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_owned())
        .unwrap_or_default()
}

fn adapter_command(agent: &str) -> Option<&'static str> {
    match agent {
        "claude" => Some("claude"),
        "codex" => Some("codex"),
        "cursor" => Some("cursor"),
        "grok" => Some("grok"),
        _ => None,
    }
}

fn adapter_available(agent: &str) -> bool {
    adapter_command(agent).is_some_and(|command| {
        #[cfg(windows)]
        {
            // npm commonly exposes coding CLIs as `.cmd` shims. CreateProcess does not apply
            // PATHEXT as an interactive Windows shell does, so availability must use the same
            // platform resolver as managed adapter launch rather than rejecting a valid shim.
            Command::new("where")
                .arg(command)
                .output()
                .is_ok_and(|output| output.status.success())
        }
        #[cfg(not(windows))]
        {
            Command::new(command)
                .arg("--version")
                .output()
                .is_ok_and(|output| output.status.success())
        }
    })
}

fn validate_manifest(manifest: Manifest) -> Result<Manifest> {
    if manifest.schema_version != MANIFEST_VERSION
        || manifest.harness_version != 1
        || manifest.policy_version != 1
    {
        return Err(HarnessError::invalid(
            "unsupported ICARUS harness manifest version",
        ));
    }
    if !is_fingerprint(&manifest.repo_id, "repo-")
        || !is_fingerprint(&manifest.git_remote_fingerprint, "")
    {
        return Err(HarnessError::invalid(
            "invalid ICARUS repository identity fingerprint",
        ));
    }
    let allowed = ["claude", "codex", "cursor", "grok"];
    if manifest
        .agents
        .iter()
        .any(|agent| !allowed.contains(&agent.as_str()))
    {
        return Err(HarnessError::invalid(
            "manifest contains an unsupported coding-agent adapter",
        ));
    }
    Ok(manifest)
}

fn policy_path(root: &Path) -> PathBuf {
    root.join(".icarus/policies/default.yaml")
}

fn validate_repository_policy(
    policy: RepositoryPolicy,
    manifest: &Manifest,
) -> Result<RepositoryPolicy> {
    if policy.policy_version != manifest.policy_version {
        return Err(HarnessError::invalid(format!(
            "repository policy version {} does not match manifest policy version {}",
            policy.policy_version, manifest.policy_version
        )));
    }
    if !["approval_required", "forbidden"].contains(&policy.external_writes.as_str()) {
        return Err(HarnessError::invalid(
            "repository policy external_writes must be `approval_required` or `forbidden`",
        ));
    }
    if !["agent_managed", "disabled"].contains(&policy.network.as_str()) {
        return Err(HarnessError::invalid(
            "repository policy network must be `agent_managed` or `disabled`",
        ));
    }
    if !["proposal_only", "disabled"].contains(&policy.learning.as_str()) {
        return Err(HarnessError::invalid(
            "repository policy learning must be `proposal_only` or `disabled`",
        ));
    }
    Ok(policy)
}

/// Load the only v1 execution policy. Callers should use this rather than reading YAML directly:
/// config must fail closed before a managed agent is allowed to launch.
pub fn load_repository_policy(repo_root: &Path) -> Result<RepositoryPolicy> {
    let root = canonical_root(repo_root)?;
    let manifest = load_manifest(&root)?;
    let path = policy_path(&root);
    if !path.exists() {
        return Err(HarnessError::invalid(
            "ICARUS harness policy is missing; run `icarus harness init` or restore .icarus/policies/default.yaml",
        ));
    }
    validate_repository_policy(serde_yaml::from_reader(File::open(path)?)?, &manifest)
}

fn object_schema(title: &str, required: &[&str], properties: Value) -> Value {
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": title,
        "type": "object",
        "additionalProperties": false,
        "required": required,
        "properties": properties,
    })
}

/// Public JSON Schemas are written into every initialized repository so editors, CI, and other
/// agents can validate ICARUS records without having to link the Rust crate. Native validation
/// remains authoritative at runtime; these documents are the compatible public contract.
fn harness_schema_documents() -> Vec<(&'static str, Value)> {
    vec![
        (
            "manifest.schema.json",
            object_schema(
                "ICARUS Harness Manifest",
                &[
                    "schema_version",
                    "harness_version",
                    "repo_id",
                    "repo_root",
                    "git_remote_fingerprint",
                    "policy_version",
                    "agents",
                ],
                json!({
                    "schema_version": {"type":"integer","const":1},
                    "harness_version": {"type":"integer","const":1},
                    "repo_id": {"type":"string","pattern":"^repo-[a-f0-9]{16}$"},
                    "repo_root": {"type":"string","minLength":1},
                    "git_remote_fingerprint": {"type":"string","pattern":"^[a-f0-9]{16}$"},
                    "policy_version": {"type":"integer","minimum":1},
                    "agents": {"type":"array","items":{"enum":["claude","codex","cursor","grok"]},"uniqueItems":true}
                }),
            ),
        ),
        (
            "contract.schema.json",
            object_schema(
                "ICARUS Task Contract",
                &[
                    "allowed_paths",
                    "forbidden_paths",
                    "acceptance_criteria",
                    "risk",
                    "budgets",
                    "authority",
                    "external_write_policy",
                ],
                json!({
                    "allowed_paths": {"type":"array","items":{"type":"string","minLength":1},"minItems":1},
                    "forbidden_paths": {"type":"array","items":{"type":"string"}},
                    "acceptance_criteria": {"type":["array","object"]},
                    "risk": {"type":"string","minLength":1},
                    "budgets": {"type":"object"},
                    "authority": {"type":"string","minLength":1},
                    "external_write_policy": {"type":"string","minLength":1},
                    "decision_references": {"type":"array","items":{"type":"string"}},
                    "task_type": {"type":["string","null"]}
                }),
            ),
        ),
        (
            "policy.schema.json",
            object_schema(
                "ICARUS Harness Repository Policy",
                &["policy_version", "external_writes", "network", "learning"],
                json!({
                    "policy_version": {"type":"integer","minimum":1},
                    "external_writes": {"enum":["approval_required","forbidden"]},
                    "network": {"enum":["agent_managed","disabled"]},
                    "learning": {"enum":["proposal_only","disabled"]}
                }),
            ),
        ),
        (
            "checkpoint.schema.json",
            object_schema(
                "ICARUS Checkpoint",
                &[
                    "schema_version",
                    "task_id",
                    "execution_id",
                    "sequence",
                    "phase",
                    "input",
                    "worktree_fingerprint",
                    "created_at",
                ],
                json!({
                    "schema_version": {"type":"integer","const":1},
                    "task_id": {"type":"string","minLength":1},
                    "execution_id": {"type":"string","minLength":1},
                    "sequence": {"type":"integer","minimum":1},
                    "phase": {"type":"string","minLength":1},
                    "input": {"type":"object"},
                    "worktree_fingerprint": {"type":"string","pattern":"^[a-f0-9]{64}$"},
                    "created_at": {"type":"string","format":"date-time"}
                }),
            ),
        ),
        (
            "receipt.schema.json",
            object_schema(
                "ICARUS Verification Receipt",
                &[
                    "schema_version",
                    "task_id",
                    "execution_id",
                    "criterion_id",
                    "status",
                    "output_digest",
                    "output_path",
                    "created_at",
                ],
                json!({
                    "schema_version": {"type":"integer","const":1},
                    "task_id": {"type":"string","minLength":1},
                    "execution_id": {"type":"string","minLength":1},
                    "criterion_id": {"type":"string","minLength":1},
                    "status": {"enum":["pass","fail","pending"]},
                    "output_digest": {"type":"string","pattern":"^[a-f0-9]{64}$"},
                    "output_path": {"type":"string","minLength":1},
                    "created_at": {"type":"string","format":"date-time"}
                }),
            ),
        ),
        (
            "skill.schema.json",
            object_schema(
                "ICARUS Proposed Skill",
                &[
                    "schema_version",
                    "id",
                    "state",
                    "triggers",
                    "instructions",
                    "allowed_tools",
                    "policy_requirements",
                    "verification_steps",
                    "source_tasks",
                    "task_types",
                    "file_patterns",
                    "proof_expires_at",
                    "risk",
                    "owner",
                    "version",
                    "confidence",
                ],
                json!({
                    "schema_version": {"type":"integer","const":1},
                    "id": {"type":"string","pattern":"^[a-z0-9_-]+$"},
                    "state": {"enum":["proposed","active","demoted","retired"]},
                    "triggers": {"type":"array","items":{"type":"string","minLength":1},"minItems":1},
                    "instructions": {"type":"string","minLength":1},
                    "allowed_tools": {"type":"array","items":{"type":"string"}},
                    "policy_requirements": {"type":"array","items":{"type":"string"}},
                    "verification_steps": {"type":"array","items":{"type":"string"}},
                    "source_tasks": {"type":"array","items":{"type":"string"},"minItems":1},
                    "decision_references": {"type":"array","items":{"type":"string"}},
                    "task_types": {"type":"array","items":{"type":"string","minLength":1},"minItems":1},
                    "file_patterns": {"type":"array","items":{"type":"string","minLength":1},"minItems":1},
                    "proof_expires_at": {"type":"string","format":"date-time"},
                    "risk": {"type":"string","minLength":1},
                    "owner": {"type":"string","minLength":1},
                    "version": {"type":"integer","minimum":1},
                    "confidence": {"type":"number","exclusiveMinimum":0},
                    "replay_results": {"type":"array"},
                    "verification": {}
                }),
            ),
        ),
    ]
}

/// Add schemas introduced by a newer harness without rewriting an existing tracked contract.
/// A user-owned schema edit is visible in review and remains untouched; a missing schema can be
/// restored safely by re-running init.
fn ensure_schema_documents(root: &Path) -> Result<()> {
    for (name, schema) in harness_schema_documents() {
        let path = root.join(".icarus/schemas").join(name);
        if !path.exists() {
            atomic_write(
                &path,
                format!("{}\n", serde_json::to_string_pretty(&schema)?).as_bytes(),
            )?;
        }
    }
    Ok(())
}

fn is_fingerprint(value: &str, prefix: &str) -> bool {
    let suffix = value.strip_prefix(prefix).unwrap_or("");
    suffix.len() == 16
        && suffix
            .chars()
            .all(|character| character.is_ascii_hexdigit())
}

fn atomic_write(path: &Path, content: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| HarnessError::invalid("write target has no parent directory"))?;
    fs::create_dir_all(parent)?;
    let nonce = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".{}.{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id(),
        nonce
    ));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(content)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        crash_after_atomic_rename_if_requested(path);
        // `rename` is atomic, but it is not necessarily durable across an abrupt power loss
        // until the containing directory has been synced too. Runtime state is deliberately
        // recoverable after a killed process, so make the rename durable before returning.
        sync_directory(parent)?;
        Ok(())
    })();
    if temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(feature = "test-failpoints")]
fn crash_after_atomic_rename_if_requested(path: &Path) {
    let requested = std::env::var("ICARUS_TEST_CRASH_POINT").ok();
    let selector_matches = requested
        .as_deref()
        .and_then(|value| value.strip_prefix("atomic-after-rename:"))
        .is_some_and(|name| {
            path.file_name().and_then(|candidate| candidate.to_str()) == Some(name)
        });
    if requested.as_deref() == Some("atomic-after-rename") || selector_matches {
        // Exercise the process-death boundary after the replacement is visible but before the
        // parent directory fsync returns. This is test-only; production always reaches the
        // directory sync below. `exit` skips Rust destructors (and therefore the remaining
        // fsync) while avoiding macOS crash-reporter hangs caused by `abort` in nested tests.
        // It must still leave a complete JSON value, never a partially written snapshot.
        std::process::exit(86);
    }
}

#[cfg(not(feature = "test-failpoints"))]
fn crash_after_atomic_rename_if_requested(_path: &Path) {}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}

// Windows does not support opening a directory as a normal `File` for `sync_all`. The rename
// still gives atomic replacement there; keeping this a no-op preserves cross-platform CLI
// support while Unix release targets get the stronger crash-durability guarantee above.
#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<()> {
    Ok(())
}

fn manifest_yaml(manifest: &Manifest) -> Result<String> {
    let mut rendered = String::from(
        "# ICARUS Harness repository contract. Commit this file; never commit .icarus/runtime/.\n",
    );
    rendered.push_str(&serde_yaml::to_string(manifest)?);
    Ok(rendered)
}

pub fn load_manifest(repo_root: &Path) -> Result<Manifest> {
    let root = canonical_root(repo_root)?;
    let path = manifest_path(&root);
    if !path.exists() {
        return Err(HarnessError::invalid(format!(
            "ICARUS harness is not initialized in {}; run `icarus harness init`",
            root.display()
        )));
    }
    validate_manifest(serde_yaml::from_reader(File::open(path)?)?)
}

/// Copy, never move, the v0.3 graph into the harness runtime. This is deliberately safe to run
/// on every init/migration attempt: a complete runtime graph wins, while the legacy source is
/// retained so an interrupted upgrade cannot erase the user's only index.
fn migrate_legacy_graph(root: &Path) -> Result<bool> {
    let legacy_graph = root.join(".icarus-graph/graph.db");
    let runtime_graph = runtime_root(root).join("graph/graph.db");
    if !legacy_graph.exists() || runtime_graph.exists() {
        return Ok(false);
    }
    let target_parent = runtime_graph
        .parent()
        .ok_or_else(|| HarnessError::invalid("runtime graph has no parent directory"))?;
    fs::create_dir_all(target_parent)?;
    fs::copy(&legacy_graph, &runtime_graph)?;
    Ok(true)
}

fn missing_schema_names(root: &Path) -> Vec<String> {
    harness_schema_documents()
        .into_iter()
        .filter_map(|(name, _)| {
            (!root.join(".icarus/schemas").join(name).exists()).then(|| name.to_owned())
        })
        .collect()
}

/// Inspect or apply the explicit v0.3-to-harness migration. Calling with `dry_run = true` does
/// not create any directory or file. Apply delegates to idempotent `init`, which uses only
/// atomic writes and a copy-only graph migration.
pub fn migrate(repo_root: &Path, dry_run: bool, options: InitOptions) -> Result<MigrationReport> {
    let root = canonical_root(repo_root)?;
    let mut actions = Vec::new();
    if !manifest_path(&root).exists() {
        actions.push("create tracked .icarus/manifest.yaml and default policy".into());
    }
    let legacy_graph = root.join(".icarus-graph/graph.db");
    let runtime_graph = runtime_root(&root).join("graph/graph.db");
    if legacy_graph.exists() && !runtime_graph.exists() {
        actions.push("copy legacy .icarus-graph/graph.db into .icarus/runtime/graph/graph.db; retain the source".into());
    }
    let missing_schemas = missing_schema_names(&root);
    if !missing_schemas.is_empty() {
        actions.push(format!(
            "write {} missing public schema document(s)",
            missing_schemas.len()
        ));
    }
    let needed = !actions.is_empty();
    if needed && !dry_run {
        init(&root, options)?;
    }
    Ok(MigrationReport {
        schema_version: 1,
        dry_run,
        needed,
        applied: needed && !dry_run,
        actions,
    })
}

pub fn init(repo_root: &Path, options: InitOptions) -> Result<InitResult> {
    let root = canonical_root(repo_root)?;
    let manifest_file = manifest_path(&root);
    if manifest_file.exists() {
        ensure_schema_documents(&root)?;
        let graph_migrated = migrate_legacy_graph(&root)?;
        return Ok(InitResult {
            created: false,
            manifest: load_manifest(&root)?,
            graph_migrated,
        });
    }
    let remote = remote_url(&root);
    let identity = if remote.is_empty() {
        root.display().to_string()
    } else {
        remote.clone()
    };
    let agents: BTreeSet<_> = options.agents.into_iter().collect();
    let manifest = validate_manifest(Manifest {
        schema_version: MANIFEST_VERSION,
        harness_version: 1,
        repo_id: format!("repo-{}", &sha256(identity.as_bytes())[..16]),
        repo_root: root.display().to_string(),
        git_remote_fingerprint: sha256(
            if remote.is_empty() {
                format!("local:{}", root.display())
            } else {
                remote
            }
            .as_bytes(),
        )[..16]
            .to_owned(),
        policy_version: 1,
        agents: agents.into_iter().collect(),
    })?;
    atomic_write(&manifest_file, manifest_yaml(&manifest)?.as_bytes())?;
    atomic_write(&policy_path(&root), b"# ICARUS Harness policy v1\npolicy_version: 1\nexternal_writes: approval_required\nnetwork: agent_managed\nlearning: proposal_only\n")?;
    ensure_schema_documents(&root)?;
    atomic_write(&runtime_root(&root).join(".gitignore"), b"*\n!.gitignore\n")?;
    ensure_root_gitignore(&root)?;

    let graph_migrated = migrate_legacy_graph(&root)?;
    Ok(InitResult {
        created: true,
        manifest,
        graph_migrated,
    })
}

fn ensure_root_gitignore(root: &Path) -> Result<()> {
    let path = root.join(".gitignore");
    let current = if path.exists() {
        fs::read_to_string(&path)?
    } else {
        String::new()
    };
    if current.lines().any(|line| line == ".icarus/runtime/") {
        return Ok(());
    }
    let separator = if current.is_empty() || current.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    atomic_write(
        &path,
        format!(
            "{}{}# ICARUS Harness runtime state (local, never commit)\n.icarus/runtime/\n",
            current, separator
        )
        .as_bytes(),
    )
}

pub fn write_snapshot(repo_root: &Path, relative_path: &str, value: Value) -> Result<()> {
    let root = canonical_root(repo_root)?;
    let target = checked_runtime_path(&root, relative_path)?;
    atomic_write(
        &target,
        format!("{}\n", serde_json::to_string_pretty(&value)?).as_bytes(),
    )
}

pub fn read_snapshot(repo_root: &Path, relative_path: &str) -> Result<Option<Value>> {
    let root = canonical_root(repo_root)?;
    let target = checked_runtime_path(&root, relative_path)?;
    if !target.exists() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_reader(File::open(target)?)?))
}

fn checked_runtime_path(root: &Path, relative_path: &str) -> Result<PathBuf> {
    let path = Path::new(relative_path);
    if relative_path.is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(HarnessError::invalid(
            "runtime snapshot path must stay inside .icarus/runtime",
        ));
    }
    Ok(runtime_root(root).join(path))
}

fn task_path(root: &Path, task_id: &str) -> Result<PathBuf> {
    if !task_id.starts_with("TASK-")
        || task_id.len() != 17
        || !task_id[5..]
            .chars()
            .all(|character| character.is_ascii_uppercase() || character.is_ascii_digit())
    {
        return Err(HarnessError::invalid("invalid ICARUS task id"));
    }
    checked_runtime_path(root, &format!("tasks/{task_id}/task.json"))
}

fn denial_path(root: &Path, denial_id: &str) -> Result<PathBuf> {
    if !denial_id.starts_with("DENIAL-")
        || denial_id.len() != 40
        || !denial_id[7..].chars().all(|character| {
            character.is_ascii_uppercase() || character.is_ascii_digit() || character == '-'
        })
    {
        return Err(HarnessError::invalid("invalid policy denial id"));
    }
    checked_runtime_path(root, &format!("denials/{denial_id}.json"))
}

/// Read a typed denial explanation emitted by the Rust adapter authority. This cannot explain a
/// made-up id or reconstruct a decision from current mutable state.
pub fn explain_policy_denial(repo_root: &Path, denial_id: &str) -> Result<PolicyDenial> {
    let root = canonical_root(repo_root)?;
    let value = read_snapshot(&root, &format!("denials/{denial_id}.json"))?.ok_or_else(|| {
        HarnessError::invalid(format!("policy denial `{denial_id}` does not exist"))
    })?;
    let denial: PolicyDenial = serde_json::from_value(value)?;
    if denial.denial_id != denial_id {
        return Err(HarnessError::invalid("policy denial snapshot id mismatch"));
    }
    Ok(denial)
}

fn contract_path(root: &Path, task_id: &str, version: u32) -> Result<PathBuf> {
    if version == 0 {
        return Err(HarnessError::invalid("contract version must be positive"));
    }
    checked_runtime_path(root, &format!("tasks/{task_id}/contract.v{version}.json"))
}

fn checkpoints_path(root: &Path, task_id: &str) -> Result<PathBuf> {
    checked_runtime_path(root, &format!("tasks/{task_id}/checkpoints.jsonl"))
}

fn contract_digest(contract: &TaskContract) -> Result<String> {
    Ok(sha256(
        stable_json(&serde_json::to_value(contract)?)?.as_bytes(),
    ))
}

fn task_execution_id(task_id: &str) -> String {
    let material = format!(
        "{task_id}:{}:{}",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    format!(
        "EXEC-{}",
        sha256(material.as_bytes())[..12].to_ascii_uppercase()
    )
}

fn task_id(objective: &str) -> String {
    let material = format!(
        "{objective}:{}:{}",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    format!(
        "TASK-{}",
        sha256(material.as_bytes())[..12].to_ascii_uppercase()
    )
}

fn validate_contract(contract: &TaskContract) -> Result<()> {
    if contract.allowed_paths.is_empty() {
        return Err(HarnessError::invalid(
            "task contract must declare at least one allowed path",
        ));
    }
    for pattern in contract
        .allowed_paths
        .iter()
        .chain(contract.forbidden_paths.iter())
    {
        Glob::new(pattern).map_err(|error| {
            HarnessError::invalid(format!(
                "invalid contract path pattern `{pattern}`: {error}"
            ))
        })?;
    }
    if contract.risk.is_empty()
        || contract.authority.is_empty()
        || contract.external_write_policy.is_empty()
    {
        return Err(HarnessError::invalid(
            "task contract is missing a required governance field",
        ));
    }
    if !contract.budgets.is_object() {
        return Err(HarnessError::invalid(
            "task contract budgets must be a JSON object",
        ));
    }
    if let Some(value) = contract.budgets.get("wall_time_minutes") {
        let minutes = value.as_u64().ok_or_else(|| {
            HarnessError::invalid("wall_time_minutes must be a positive whole number")
        })?;
        if !(1..=1_440).contains(&minutes) {
            return Err(HarnessError::invalid(
                "wall_time_minutes must be between 1 and 1440",
            ));
        }
    }
    if contract.decision_references.iter().any(|reference| {
        reference.is_empty()
            || reference.len() > 128
            || !reference.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
            })
    }) {
        return Err(HarnessError::invalid(
            "task contract contains an invalid decision reference",
        ));
    }
    Ok(())
}

fn wall_time_deadline(contract: &TaskContract) -> Result<Option<String>> {
    let Some(minutes) = contract.budgets.get("wall_time_minutes") else {
        return Ok(None);
    };
    let minutes = minutes.as_u64().ok_or_else(|| {
        HarnessError::invalid("wall_time_minutes must be a positive whole number")
    })?;
    let duration = time::Duration::minutes(
        i64::try_from(minutes)
            .map_err(|_| HarnessError::invalid("wall_time_minutes is too large"))?,
    );
    Ok(Some(
        (time::OffsetDateTime::now_utc() + duration)
            .format(&time::format_description::well_known::Rfc3339)
            .expect("the RFC3339 formatter supports UTC timestamps"),
    ))
}

/// Creates one durable task and its first execution attempt. The contract is written once and
/// all later transitions reference that versioned snapshot.
pub fn start_task(
    repo_root: &Path,
    objective: impl Into<String>,
    contract: TaskContract,
) -> Result<TaskRecord> {
    let root = canonical_root(repo_root)?;
    load_manifest(&root)?;
    validate_contract(&contract)?;
    let objective = objective.into();
    if objective.trim().is_empty() {
        return Err(HarnessError::invalid("task objective cannot be empty"));
    }
    let id = task_id(&objective);
    let task = TaskRecord {
        schema_version: 1,
        task_id: id,
        objective,
        status: "created".into(),
        contract_version: 1,
        contract_digest: String::new(),
        contract,
        execution_id: String::new(),
        previous_execution_id: None,
    };
    let mut task = task;
    task.execution_id = task_execution_id(&task.task_id);
    task.contract_digest = contract_digest(&task.contract)?;
    atomic_write(
        &contract_path(&root, &task.task_id, task.contract_version)?,
        format!("{}\n", serde_json::to_string_pretty(&task.contract)?).as_bytes(),
    )?;
    save_task(&root, &task)?;
    append_event(
        &root,
        EventInput {
            execution_id: task.execution_id.clone(),
            task_id: task.task_id.clone(),
            event_type: "task_created".into(),
            worktree_id: "main".into(),
            timestamp: None,
            payload: json!({"objective": task.objective, "contract_version": 1}),
        },
    )?;
    Ok(task)
}

pub fn task_status(repo_root: &Path, task_id: &str) -> Result<TaskRecord> {
    let root = canonical_root(repo_root)?;
    let path = task_path(&root, task_id)?;
    if !path.exists() {
        return Err(HarnessError::invalid(format!(
            "task `{task_id}` does not exist"
        )));
    }
    let task: TaskRecord = serde_json::from_reader(File::open(path)?)?;
    let path = contract_path(&root, task_id, task.contract_version)?;
    if !path.exists() {
        return Err(HarnessError::invalid(format!(
            "task `{task_id}` is missing immutable contract v{}",
            task.contract_version
        )));
    }
    let contract: TaskContract = serde_json::from_reader(File::open(path)?)?;
    validate_contract(&contract)?;
    let actual_digest = contract_digest(&contract)?;
    if actual_digest != task.contract_digest {
        return Err(HarnessError::invalid(format!(
            "task `{task_id}` contract digest mismatch; runtime history was modified"
        )));
    }
    if contract != task.contract {
        return Err(HarnessError::invalid(format!(
            "task `{task_id}` current snapshot disagrees with its immutable contract"
        )));
    }
    Ok(task)
}

fn save_task(root: &Path, task: &TaskRecord) -> Result<()> {
    let path = task_path(root, &task.task_id)?;
    atomic_write(
        &path,
        format!("{}\n", serde_json::to_string_pretty(task)?).as_bytes(),
    )
}

/// Reconcile the single recoverable lifecycle split caused by a process death after an atomic
/// task-snapshot replacement but before its corresponding event append. The task snapshot is the
/// current authority for its status; the missing history is never silently ignored. Before any
/// subsequent lifecycle operation, append an explicit recovery event only when the persisted
/// state is exactly one legal transition after the event-log state.
fn reconcile_task_lifecycle_event(root: &Path, task: &TaskRecord) -> Result<()> {
    let mut recorded = None;
    for event in read_events(root)? {
        if event.task_id != task.task_id {
            continue;
        }
        match event.event_type.as_str() {
            "task_created" => recorded = Some("created".to_owned()),
            "task_transitioned" | "task_transition_recovered" => {
                if let Some(status) = event.payload.get("to").and_then(Value::as_str) {
                    recorded = Some(status.to_owned());
                }
            }
            _ => {}
        }
    }
    let Some(previous) = recorded else {
        return Err(HarnessError::invalid(
            "task has no durable lifecycle creation event",
        ));
    };
    if previous == task.status {
        return Ok(());
    }
    let legal = TASK_TRANSITIONS
        .iter()
        .find(|(from, _)| *from == previous)
        .map(|(_, next)| *next)
        .unwrap_or(&[]);
    if !legal.contains(&task.status.as_str()) {
        return Err(HarnessError::invalid(format!(
            "task snapshot status `{}` cannot be reconciled from durable lifecycle status `{previous}`",
            task.status
        )));
    }
    append_event(
        root,
        EventInput {
            execution_id: task.execution_id.clone(),
            task_id: task.task_id.clone(),
            event_type: "task_transition_recovered".into(),
            worktree_id: "main".into(),
            timestamp: None,
            payload: json!({
                "from": previous,
                "to": task.status,
                "contract_version": task.contract_version,
                "reason": "recovered a durable task snapshot after an interrupted lifecycle event append",
            }),
        },
    )?;
    Ok(())
}

const TASK_TRANSITIONS: &[(&str, &[&str])] = &[
    ("created", &["orienting", "blocked", "failed"]),
    ("orienting", &["contracted", "blocked", "failed"]),
    ("contracted", &["planned", "blocked", "failed"]),
    (
        "planned",
        &["executing", "waiting_for_approval", "blocked", "failed"],
    ),
    (
        "executing",
        &["verifying", "waiting_for_approval", "blocked", "failed"],
    ),
    ("verifying", &["sealed", "executing", "blocked", "failed"]),
    (
        "waiting_for_approval",
        &["planned", "executing", "blocked", "failed"],
    ),
    ("blocked", &["orienting", "planned", "failed"]),
    ("failed", &[]),
    ("sealed", &[]),
];

pub fn transition_task(repo_root: &Path, task_id: &str, target: &str) -> Result<TaskRecord> {
    let root = canonical_root(repo_root)?;
    let mut task = task_status(&root, task_id)?;
    reconcile_task_lifecycle_event(&root, &task)?;
    let allowed = TASK_TRANSITIONS
        .iter()
        .find(|(from, _)| *from == task.status)
        .map(|(_, next)| *next)
        .unwrap_or(&[]);
    if !allowed.contains(&target) {
        return Err(HarnessError::invalid(format!(
            "cannot transition task from {} to {}",
            task.status, target
        )));
    }
    let previous = task.status.clone();
    task.status = target.into();
    save_task(&root, &task)?;
    append_event(
        &root,
        EventInput {
            execution_id: task.execution_id.clone(),
            task_id: task.task_id.clone(),
            event_type: "task_transitioned".into(),
            worktree_id: "main".into(),
            timestamp: None,
            payload: json!({"from": previous, "to": target, "contract_version": task.contract_version}),
        },
    )?;
    Ok(task)
}

pub fn resume_task(repo_root: &Path, task_id: &str) -> Result<TaskRecord> {
    let root = canonical_root(repo_root)?;
    let mut task = task_status(&root, task_id)?;
    reconcile_task_lifecycle_event(&root, &task)?;
    if matches!(task.status.as_str(), "sealed" | "failed") {
        return Err(HarnessError::invalid(format!(
            "cannot resume terminal task in {} state",
            task.status
        )));
    }
    if let Some(checkpoint) = read_checkpoints(&root, task_id)?.last() {
        let current_status = git_output(&root, &["status", "--porcelain=v1"]).unwrap_or_default();
        let current_fingerprint = sha256(current_status.as_bytes());
        let current_sha = git_output(&root, &["rev-parse", "HEAD"]);
        if checkpoint.dirty_state_fingerprint != current_fingerprint
            || checkpoint.git_sha != current_sha
        {
            return Err(HarnessError::invalid(format!(
                "worktree divergence detected since checkpoint {}; inspect the repository and create a new checkpoint before resuming",
                checkpoint.sequence
            )));
        }
    }
    let previous_execution_id = task.execution_id.clone();
    task.previous_execution_id = Some(previous_execution_id.clone());
    task.execution_id = task_execution_id(&task.task_id);
    save_task(&root, &task)?;
    append_event(
        &root,
        EventInput {
            execution_id: task.execution_id.clone(),
            task_id: task.task_id.clone(),
            event_type: "task_resumed".into(),
            worktree_id: "main".into(),
            timestamp: None,
            payload: json!({"previous_execution_id": previous_execution_id, "status": task.status}),
        },
    )?;
    Ok(task)
}

fn git_repository(root: &Path) -> bool {
    Command::new("git")
        .args([
            "-C",
            &external_path(root),
            "rev-parse",
            "--is-inside-work-tree",
        ])
        .output()
        .ok()
        .is_some_and(|output| output.status.success())
}

fn managed_worktree_path(root: &Path, repo_id: &str, task_id: &str) -> PathBuf {
    let parent = root.parent().unwrap_or(root);
    parent.join(".icarus-worktrees").join(repo_id).join(task_id)
}

/// Prepare the workspace before an adapter is launched. Rust owns the choice of isolated versus
/// current workspace and records it before a child process is allowed to touch source files.
pub fn prepare_run(
    repo_root: &Path,
    task_id: &str,
    agent: String,
    workspace_mode: String,
    acknowledge_dirty_current: bool,
) -> Result<RunPreparation> {
    let root = canonical_root(repo_root)?;
    let manifest = load_manifest(&root)?;
    // Do this before any task or skill state can be mutated. A malformed policy must never
    // silently downgrade a managed launch into an agent-controlled configuration.
    load_repository_policy(&root)?;
    if !["claude", "codex", "cursor", "grok"].contains(&agent.as_str()) {
        return Err(HarnessError::invalid("unsupported coding-agent adapter"));
    }
    if !manifest.agents.is_empty() && !manifest.agents.contains(&agent) {
        return Err(HarnessError::invalid(format!(
            "agent `{agent}` is not enabled by this harness manifest"
        )));
    }
    if !matches!(workspace_mode.as_str(), "isolated" | "current") {
        return Err(HarnessError::invalid(
            "workspace mode must be `isolated` or `current`",
        ));
    }
    let task = task_status(&root, task_id)?;
    if task.status != "planned" {
        return Err(HarnessError::invalid(format!(
            "managed run requires a planned task; current state is {}",
            task.status
        )));
    }
    // A managed launch is also the natural enforcement point for automatic demotions. It runs
    // before the context is compiled, so a stale or failed procedure cannot influence this run.
    // The task state has already been validated, so an invalid launch request cannot mutate
    // unrelated skill state.
    review_active_skills(&root)?;
    let base_git_sha = git_output(&root, &["rev-parse", "HEAD"]);
    let base_status = git_output(&root, &["status", "--porcelain=v1"]).unwrap_or_default();
    let base_dirty_state_fingerprint = sha256(base_status.as_bytes());
    let dirty = !base_status.is_empty();
    let (workspace_path, worktree_id) = if workspace_mode == "current" {
        if dirty && !acknowledge_dirty_current {
            return Err(HarnessError::invalid(
                "current workspace has uncommitted changes; pass explicit acknowledgment before adopting it",
            ));
        }
        (root.clone(), "current".into())
    } else {
        if dirty {
            return Err(HarnessError::invalid(
                "isolated managed runs require a clean authoritative worktree; commit/stash the current changes or explicitly use --workspace current with acknowledgment",
            ));
        }
        if !git_repository(&root) {
            return Err(HarnessError::invalid(
                "isolated managed runs require a Git repository",
            ));
        }
        let path = managed_worktree_path(&root, &manifest.repo_id, task_id);
        if !path.exists() {
            let parent = path.parent().expect("managed worktree has a parent");
            fs::create_dir_all(parent)?;
            let output = Command::new("git")
                .args([
                    "-C",
                    &external_path(&root),
                    "worktree",
                    "add",
                    "--detach",
                    &external_path(&path),
                    "HEAD",
                ])
                .output()
                .map_err(HarnessError::from)?;
            if !output.status.success() {
                return Err(HarnessError::invalid(format!(
                    "failed to create isolated worktree: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                )));
            }
        }
        (path, format!("isolated-{task_id}"))
    };
    let current_workspace_baseline = if workspace_mode == "current" && git_repository(&root) {
        workspace_change_digests(&root)?
    } else {
        BTreeMap::new()
    };
    // This is a launch gate, not a convenience export: if the mandatory context cannot be
    // compiled within its budget, no coding agent is started.
    let (context_pack_path, context_pack_hash) =
        persist_launch_context(&root, &workspace_path, &task)?;
    let (adapter_config_paths, adapter_settings_path) =
        persist_adapter_config(&workspace_path, &task, &agent)?;
    let capabilities = adapter_capabilities(&agent);
    let certification = if capabilities.pre_action_authorization
        && capabilities.post_action_event_capture
        && capabilities.completion_interception
        && capabilities.external_write_interception
        && capabilities.stable_session_identity
        && capabilities.workspace_isolation
    {
        "certified"
    } else {
        "compatibility"
    };
    let preparation = RunPreparation {
        task_id: task.task_id.clone(),
        execution_id: task.execution_id.clone(),
        agent: agent.clone(),
        workspace_mode,
        worktree_id: worktree_id.clone(),
        workspace_path: external_path(&workspace_path),
        base_git_sha,
        base_dirty_state_fingerprint,
        context_pack_path: external_path(&context_pack_path),
        context_pack_hash,
        adapter_config_paths: adapter_config_paths
            .iter()
            .map(|path| external_path(path))
            .collect(),
        adapter_settings_path: adapter_settings_path
            .as_ref()
            .map(|path| external_path(path)),
        certification: certification.into(),
        compatibility_mode: certification != "certified",
        capabilities,
        wall_time_deadline: wall_time_deadline(&task.contract)?,
        current_workspace_baseline,
        launch_arguments: adapter_launch_arguments(
            &agent,
            &workspace_path,
            task_id,
            &context_pack_path,
            &adapter_config_paths,
            adapter_settings_path.as_deref(),
        ),
    };
    write_snapshot(
        &root,
        &format!("state/run-{}.json", task.task_id),
        serde_json::to_value(&preparation)?,
    )?;
    append_event(
        &root,
        EventInput {
            execution_id: task.execution_id,
            task_id: task.task_id,
            event_type: "run_prepared".into(),
            worktree_id,
            timestamp: None,
            payload: serde_json::to_value(&preparation)?,
        },
    )?;
    Ok(preparation)
}

fn git_checked_bytes(root: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(external_path(root))
        .args(args)
        .output()
        .map_err(HarnessError::from)?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(HarnessError::invalid(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }
}

fn git_apply_patch(root: &Path, patch: &[u8]) -> Result<()> {
    if patch.is_empty() {
        return Ok(());
    }
    for check in [true, false] {
        let mut command = Command::new("git");
        command.arg("-C").arg(external_path(root)).args([
            "apply",
            "--binary",
            "--whitespace=nowarn",
        ]);
        if check {
            command.arg("--check");
        }
        let mut child = command
            .arg("-")
            .stdin(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(HarnessError::from)?;
        child
            .stdin
            .as_mut()
            .ok_or_else(|| HarnessError::invalid("could not open git apply stdin"))?
            .write_all(patch)?;
        let output = child.wait_with_output().map_err(HarnessError::from)?;
        if !output.status.success() {
            return Err(HarnessError::invalid(format!(
                "isolated worktree patch cannot be applied safely: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
    }
    Ok(())
}

fn nul_paths(bytes: &[u8]) -> Result<Vec<String>> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            String::from_utf8(entry.to_vec())
                .map_err(|_| HarnessError::invalid("Git returned a non-UTF-8 path"))
        })
        .collect()
}

/// Return every tracked or untracked path Git reports as changed. Porcelain v1 with `-z` is
/// machine-readable even for spaces, quotes, renames, and newlines, and also works before the
/// first commit (where `git diff HEAD` has no revision to compare against).
fn workspace_changed_paths(root: &Path) -> Result<BTreeSet<String>> {
    let bytes = git_checked_bytes(
        root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    let mut entries = bytes
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty());
    let mut paths = BTreeSet::new();
    while let Some(entry) = entries.next() {
        if entry.len() < 4 || entry[2] != b' ' {
            return Err(HarnessError::invalid(
                "Git returned malformed porcelain status",
            ));
        }
        let status = &entry[..2];
        let path = String::from_utf8(entry[3..].to_vec())
            .map_err(|_| HarnessError::invalid("Git returned a non-UTF-8 path"))?;
        paths.insert(path);
        // With `-z`, Git emits the destination first and the source second for rename/copy
        // records. Both paths must be checked: an agent must not hide a scope escape behind a
        // rename whose destination alone happens to match the contract.
        if matches!(status[0], b'R' | b'C') || matches!(status[1], b'R' | b'C') {
            let source = entries
                .next()
                .ok_or_else(|| HarnessError::invalid("Git returned a truncated rename status"))?;
            paths.insert(
                String::from_utf8(source.to_vec())
                    .map_err(|_| HarnessError::invalid("Git returned a non-UTF-8 path"))?,
            );
        }
    }
    for path in &paths {
        checked_repo_relative_path(path)?;
    }
    Ok(paths)
}

/// A content-addressed observation for a working-tree entry. It intentionally does not follow
/// symlinks: a symlink's target is data controlled by the adapter and must never cause the
/// authority to read outside the prepared repository.
fn workspace_entry_digest(root: &Path, path: &str) -> Result<String> {
    let relative = checked_repo_relative_path(path)?;
    let candidate = root.join(relative);
    let metadata = match fs::symlink_metadata(&candidate) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok("missing".into()),
        Err(error) => return Err(HarnessError::from(error)),
    };
    if metadata.file_type().is_file() {
        return Ok(format!("file:{}", sha256(&fs::read(candidate)?)));
    }
    if metadata.file_type().is_symlink() {
        let target = fs::read_link(candidate)?;
        return Ok(format!(
            "symlink:{}",
            sha256(target.to_string_lossy().as_bytes())
        ));
    }
    Err(HarnessError::invalid(format!(
        "managed workspace path `{path}` is not a regular file or symlink"
    )))
}

fn workspace_change_digests(root: &Path) -> Result<BTreeMap<String, String>> {
    workspace_changed_paths(root)?
        .into_iter()
        .map(|path| {
            let digest = workspace_entry_digest(root, &path)?;
            Ok((path, digest))
        })
        .collect()
}

fn checked_repo_relative_path(path: &str) -> Result<PathBuf> {
    let candidate = Path::new(path);
    if candidate.as_os_str().is_empty()
        || candidate.is_absolute()
        || candidate
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(HarnessError::invalid(format!(
            "isolated worktree produced an unsafe path `{path}`"
        )));
    }
    Ok(candidate.to_path_buf())
}

/// Resolve the closest existing ancestor of a prospective adapter write and require that it
/// remains under the prepared workspace after symlinks are followed. Contract glob matching by
/// itself is not sufficient: `src/allowed.rs` could be a symlink to a file outside the worktree.
fn validate_managed_workspace_path(workspace: &Path, path: &str) -> Result<()> {
    let relative = checked_repo_relative_path(path)?;
    let workspace = workspace.canonicalize().map_err(HarnessError::from)?;
    let mut existing = workspace.join(relative);
    loop {
        if existing.exists() {
            let resolved = existing.canonicalize().map_err(HarnessError::from)?;
            if resolved != workspace && !resolved.starts_with(&workspace) {
                return Err(HarnessError::invalid(
                    "adapter write path resolves outside the managed workspace",
                ));
            }
            return Ok(());
        }
        let parent = existing
            .parent()
            .ok_or_else(|| HarnessError::invalid("adapter write path has no workspace ancestor"))?;
        if parent == existing {
            return Err(HarnessError::invalid(
                "adapter write path has no workspace ancestor",
            ));
        }
        existing = parent.to_path_buf();
    }
}

fn write_reconciled_untracked_file(source: &Path, target: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(HarnessError::invalid(format!(
            "isolated worktree untracked path `{}` is not a regular file",
            source.display()
        )));
    }
    if target.exists() {
        return Err(HarnessError::invalid(format!(
            "authoritative worktree changed while reconciling `{}`",
            target.display()
        )));
    }
    atomic_write(target, &fs::read(source)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            target,
            fs::Permissions::from_mode(metadata.permissions().mode()),
        )?;
    }
    Ok(())
}

/// Apply the contract-authorized delta from a detached managed worktree to the authoritative
/// worktree. It refuses dirty/drifted bases, commits made inside the detached worktree, unsafe
/// paths, symlinks, and any out-of-contract change before writing a single source file.
pub fn reconcile_run(repo_root: &Path, task_id: &str) -> Result<ReconciliationResult> {
    let root = canonical_root(repo_root)?;
    let manifest = load_manifest(&root)?;
    let task = task_status(&root, task_id)?;
    if task.status != "executing" {
        return Err(HarnessError::invalid(
            "reconciliation requires an executing task",
        ));
    }
    let run_value = read_snapshot(&root, &format!("state/run-{}.json", task.task_id))?
        .ok_or_else(|| HarnessError::invalid("managed run preparation is missing"))?;
    let run: RunPreparation = serde_json::from_value(run_value)?;
    if run.task_id != task.task_id || run.execution_id != task.execution_id {
        return Err(HarnessError::invalid(
            "managed run preparation does not match the active task execution",
        ));
    }
    if run.workspace_mode == "current" {
        let workspace = PathBuf::from(&run.workspace_path)
            .canonicalize()
            .map_err(|_| HarnessError::invalid("managed current workspace no longer exists"))?;
        if workspace != root {
            return Err(HarnessError::invalid(
                "managed current workspace does not match the authoritative repository",
            ));
        }
        if !git_repository(&root) {
            // The harness remains usable for non-Git compatibility adapters, but cannot make a
            // source-scope assertion without a repository baseline. Its compatibility status
            // prevents certification; record the limitation rather than pretending success.
            append_event(
                &root,
                EventInput {
                    execution_id: task.execution_id.clone(),
                    task_id: task.task_id.clone(),
                    event_type: "current_workspace_scope_unavailable".into(),
                    worktree_id: run.worktree_id.clone(),
                    timestamp: None,
                    payload: json!({"reason": "current workspace is not a Git repository"}),
                },
            )?;
            return Ok(ReconciliationResult {
                task_id: task.task_id,
                execution_id: task.execution_id,
                workspace_mode: run.workspace_mode,
                reconciled: false,
                changed_files: Vec::new(),
                patch_digest: None,
            });
        }
        let current = workspace_change_digests(&root)?;
        let candidates: BTreeSet<String> = run
            .current_workspace_baseline
            .keys()
            .chain(current.keys())
            .cloned()
            .collect();
        let mut changed_files = Vec::new();
        for path in &candidates {
            if run.current_workspace_baseline.get(path) != current.get(path) {
                changed_files.push(path.clone());
            }
        }
        let allowed = build_globset(&task.contract.allowed_paths)?;
        let forbidden = build_globset(&task.contract.forbidden_paths)?;
        let mut out_of_contract = Vec::new();
        for path in &changed_files {
            checked_repo_relative_path(path)?;
            if !allowed.is_match(path) || forbidden.is_match(path) {
                out_of_contract.push(path.clone());
            }
        }
        // The current workspace cannot be rolled back without risking user work. Instead Rust
        // records the exact post-run observation and blocks lifecycle advancement before a
        // compatibility adapter can claim verification or seal the task.
        append_event(
            &root,
            EventInput {
                execution_id: task.execution_id.clone(),
                task_id: task.task_id.clone(),
                event_type: "current_workspace_scope_checked".into(),
                worktree_id: run.worktree_id.clone(),
                timestamp: None,
                payload: json!({
                    "workspace_mode": "current",
                    "baseline_entries": run.current_workspace_baseline.len(),
                    "changed_files": changed_files,
                    "out_of_contract_paths": out_of_contract,
                }),
            },
        )?;
        if let Some(path) = out_of_contract.first() {
            return Err(HarnessError::invalid(format!(
                "current workspace change is outside the task contract: {path}; task remains blocked for review"
            )));
        }
        let mut digest = Sha256::new();
        for path in &changed_files {
            digest.update(path.as_bytes());
            digest.update([0]);
            digest.update(
                current
                    .get(path)
                    .map(String::as_bytes)
                    .unwrap_or(b"missing"),
            );
            digest.update([0]);
        }
        return Ok(ReconciliationResult {
            task_id: task.task_id,
            execution_id: task.execution_id,
            workspace_mode: run.workspace_mode,
            reconciled: false,
            patch_digest: (!changed_files.is_empty()).then(|| format!("{:x}", digest.finalize())),
            changed_files,
        });
    }
    let expected = managed_worktree_path(&root, &manifest.repo_id, task_id);
    let workspace = PathBuf::from(&run.workspace_path)
        .canonicalize()
        .map_err(|_| HarnessError::invalid("managed isolated worktree no longer exists"))?;
    if workspace != expected.canonicalize().map_err(HarnessError::from)? {
        return Err(HarnessError::invalid(
            "managed run workspace does not match the deterministic task worktree",
        ));
    }
    let base_sha = run
        .base_git_sha
        .as_deref()
        .ok_or_else(|| HarnessError::invalid("isolated run has no base Git SHA"))?;
    if git_output(&root, &["rev-parse", "HEAD"]).as_deref() != Some(base_sha) {
        return Err(HarnessError::invalid(
            "authoritative HEAD changed since isolated run preparation; refusing reconciliation",
        ));
    }
    let root_status = git_output(&root, &["status", "--porcelain=v1"]).unwrap_or_default();
    if sha256(root_status.as_bytes()) != run.base_dirty_state_fingerprint {
        return Err(HarnessError::invalid(
            "authoritative worktree changed since isolated run preparation; refusing reconciliation",
        ));
    }
    if !root_status.is_empty() {
        return Err(HarnessError::invalid(
            "isolated run reconciliation requires a clean authoritative worktree",
        ));
    }
    if git_output(&workspace, &["rev-parse", "HEAD"]).as_deref() != Some(base_sha) {
        return Err(HarnessError::invalid(
            "agent changed the isolated worktree commit; export a reviewable patch instead",
        ));
    }
    let tracked_paths = nul_paths(&git_checked_bytes(
        &workspace,
        &["diff", "--name-only", "-z", "HEAD", "--"],
    )?)?;
    let untracked_paths = nul_paths(&git_checked_bytes(
        &workspace,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )?)?;
    let mut changed: BTreeSet<String> = tracked_paths.into_iter().collect();
    changed.extend(untracked_paths.iter().cloned());
    let allowed = build_globset(&task.contract.allowed_paths)?;
    let forbidden = build_globset(&task.contract.forbidden_paths)?;
    for path in &changed {
        checked_repo_relative_path(path)?;
        if !allowed.is_match(path) || forbidden.is_match(path) {
            return Err(HarnessError::invalid(format!(
                "isolated worktree change is outside the task contract: {path}"
            )));
        }
    }
    let patch = git_checked_bytes(
        &workspace,
        &["diff", "--binary", "--full-index", "HEAD", "--"],
    )?;
    let mut digest = Sha256::new();
    digest.update(&patch);
    for path in &untracked_paths {
        let relative = checked_repo_relative_path(path)?;
        let source = workspace.join(&relative);
        let contents = fs::read(&source)?;
        digest.update(path.as_bytes());
        digest.update([0]);
        digest.update(&contents);
        digest.update([0]);
    }
    // `git apply --check` runs before its write pass. This stays before untracked file writes,
    // therefore a tracked patch conflict leaves the authoritative worktree untouched.
    git_apply_patch(&root, &patch)?;
    for path in &untracked_paths {
        let relative = checked_repo_relative_path(path)?;
        write_reconciled_untracked_file(&workspace.join(&relative), &root.join(relative))?;
    }
    let result = ReconciliationResult {
        task_id: task.task_id.clone(),
        execution_id: task.execution_id.clone(),
        workspace_mode: run.workspace_mode,
        reconciled: !changed.is_empty(),
        changed_files: changed.into_iter().collect(),
        patch_digest: (!patch.is_empty() || !untracked_paths.is_empty())
            .then(|| format!("{:x}", digest.finalize())),
    };
    append_event(
        &root,
        EventInput {
            execution_id: task.execution_id,
            task_id: task.task_id,
            event_type: "workspace_reconciled".into(),
            worktree_id: run.worktree_id,
            timestamp: None,
            payload: serde_json::to_value(&result)?,
        },
    )?;
    Ok(result)
}

/// Creates a new immutable contract version. Once a task has begun executing, a configured
/// approval reference is mandatory; callers cannot silently replace its governing scope.
pub fn amend_task_contract(
    repo_root: &Path,
    task_id: &str,
    contract: TaskContract,
    reason: impl Into<String>,
    approval_id: Option<String>,
) -> Result<TaskRecord> {
    let root = canonical_root(repo_root)?;
    validate_contract(&contract)?;
    let reason = reason.into();
    if reason.trim().is_empty() {
        return Err(HarnessError::invalid(
            "contract amendment requires an attributable reason",
        ));
    }
    let mut task = task_status(&root, task_id)?;
    if matches!(task.status.as_str(), "sealed" | "failed") {
        return Err(HarnessError::invalid("cannot amend a terminal task"));
    }
    let approval_missing = match approval_id.as_deref() {
        Some(reference) => reference.is_empty(),
        None => true,
    };
    if matches!(
        task.status.as_str(),
        "executing" | "verifying" | "waiting_for_approval"
    ) && approval_missing
    {
        return Err(HarnessError::invalid(
            "amending an executing contract requires an approval reference",
        ));
    }
    let previous_version = task.contract_version;
    task.contract_version += 1;
    task.contract = contract;
    task.contract_digest = contract_digest(&task.contract)?;
    atomic_write(
        &contract_path(&root, task_id, task.contract_version)?,
        format!("{}\n", serde_json::to_string_pretty(&task.contract)?).as_bytes(),
    )?;
    save_task(&root, &task)?;
    write_snapshot(
        &root,
        &format!("state/evidence-invalidated-{task_id}.json"),
        json!({
            "task_id": task_id, "previous_contract_version": previous_version, "current_contract_version": task.contract_version,
            "reason": reason, "approval_id": approval_id,
        }),
    )?;
    append_event(
        &root,
        EventInput {
            execution_id: task.execution_id.clone(),
            task_id: task.task_id.clone(),
            event_type: "contract_amended".into(),
            worktree_id: "main".into(),
            timestamp: None,
            payload: json!({"previous_contract_version": previous_version, "contract_version": task.contract_version, "contract_digest": task.contract_digest, "reason": reason, "approval_id": approval_id}),
        },
    )?;
    Ok(task)
}

/// Captures machine-derived workspace evidence plus agent-supplied structured progress. The
/// harness never writes a plan or summary; it only persists what the agent submitted and labels
/// the repository state in which that claim was made.
pub fn checkpoint_task(
    repo_root: &Path,
    task_id: &str,
    phase: impl Into<String>,
    input: Value,
) -> Result<Checkpoint> {
    let root = canonical_root(repo_root)?;
    let task = task_status(&root, task_id)?;
    if matches!(task.status.as_str(), "sealed" | "failed") {
        return Err(HarnessError::invalid("cannot checkpoint a terminal task"));
    }
    let phase = phase.into();
    if phase.trim().is_empty() {
        return Err(HarnessError::invalid("checkpoint phase cannot be empty"));
    }
    if !input.is_object() {
        return Err(HarnessError::invalid(
            "checkpoint input must be a JSON object",
        ));
    }
    let existing = read_checkpoints(&root, task_id)?;
    let status = git_output(&root, &["status", "--porcelain=v1"]);
    let files_touched = if git_repository(&root) {
        workspace_changed_paths(&root)?.into_iter().collect()
    } else {
        Vec::new()
    };
    let dirty_state_fingerprint = sha256(status.unwrap_or_default().as_bytes());
    let checkpoint = Checkpoint {
        schema_version: 1,
        task_id: task.task_id.clone(),
        execution_id: task.execution_id.clone(),
        sequence: existing.len() as u64 + 1,
        phase,
        git_sha: git_output(&root, &["rev-parse", "HEAD"]),
        dirty_state_fingerprint,
        files_touched,
        graph_version: graph_digest(&root),
        context_pack_hash: input
            .get("context_pack_hash")
            .and_then(Value::as_str)
            .map(str::to_owned),
        budget_consumption: input
            .get("budget_consumption")
            .cloned()
            .unwrap_or_else(|| json!({})),
        open_risks: input
            .get("open_risks")
            .cloned()
            .unwrap_or_else(|| json!([])),
        next_valid_action: input
            .get("next_valid_action")
            .and_then(Value::as_str)
            .map(str::to_owned),
        input,
    };
    let path = checkpoints_path(&root, task_id)?;
    fs::create_dir_all(path.parent().unwrap())?;
    let mut log = OpenOptions::new().append(true).create(true).open(path)?;
    writeln!(log, "{}", serde_json::to_string(&checkpoint)?)?;
    log.sync_all()?;
    append_event(
        &root,
        EventInput {
            execution_id: task.execution_id,
            task_id: task.task_id,
            event_type: "checkpoint".into(),
            worktree_id: "main".into(),
            timestamp: None,
            payload: json!({"checkpoint_sequence": checkpoint.sequence, "phase": checkpoint.phase, "dirty_state_fingerprint": checkpoint.dirty_state_fingerprint, "git_sha": checkpoint.git_sha}),
        },
    )?;
    Ok(checkpoint)
}

fn criterion_for(task: &TaskRecord, criterion_id: &str) -> Result<Value> {
    task.contract
        .acceptance_criteria
        .as_array()
        .and_then(|criteria| {
            criteria
                .iter()
                .find(|criterion| criterion.get("id").and_then(Value::as_str) == Some(criterion_id))
        })
        .cloned()
        .ok_or_else(|| {
            HarnessError::invalid(format!(
                "criterion `{criterion_id}` is not in the immutable task contract"
            ))
        })
}

fn evidence_dir(root: &Path, task_id: &str) -> PathBuf {
    runtime_root(root).join("evidence").join(task_id)
}

fn bounded_excerpt(bytes: &[u8]) -> String {
    const MAX: usize = 16 * 1024;
    let text = String::from_utf8_lossy(bytes);
    if text.len() <= MAX {
        text.into_owned()
    } else {
        format!(
            "{}\n… output truncated in receipt; see complete local output file …",
            &text[..MAX]
        )
    }
}

fn toolchain_versions(root: &Path) -> Value {
    let version = |program: &str, args: &[&str]| {
        Command::new(program)
            .args(args)
            .current_dir(root)
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
    };
    json!({
        "git": version("git", &["--version"]),
        "node": version("node", &["--version"]),
        "rustc": version("rustc", &["--version"]),
    })
}

/// Execute one immutable contract criterion in the managed repository and emit a machine-backed
/// receipt. The shell command is taken only from the immutable contract, never from a free-form
/// agent parameter.
pub fn verify_task_criterion(
    repo_root: &Path,
    task_id: &str,
    criterion_id: &str,
) -> Result<VerificationReceipt> {
    let root = canonical_root(repo_root)?;
    let task = task_status(&root, task_id)?;
    if !matches!(task.status.as_str(), "executing" | "verifying") {
        return Err(HarnessError::invalid(
            "verification requires an executing or verifying task",
        ));
    }
    let criterion = criterion_for(&task, criterion_id)?;
    let criterion_type = criterion
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| HarnessError::invalid("criterion requires a type"))?
        .to_owned();
    if !matches!(
        criterion_type.as_str(),
        "test"
            | "build"
            | "lint"
            | "runtime_probe"
            | "artifact"
            | "manual_review"
            | "external_approval"
    ) {
        return Err(HarnessError::invalid(format!(
            "unsupported criterion type `{criterion_type}`"
        )));
    }
    let started_at = now_rfc3339();
    let mut command = criterion
        .get("command")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let (status, exit_code, output, artifacts) = match criterion_type.as_str() {
        "artifact" => {
            let artifact = criterion
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    HarnessError::invalid("artifact criterion requires a repository-relative path")
                })?;
            checked_repo_relative_path(artifact)?;
            // An artifact receipt is evidence, so an in-repository symlink must not make an
            // arbitrary path outside the checkout appear to have been produced by this task.
            // The shared validator follows existing ancestors and rejects that escape before
            // the existence probe can follow the link.
            validate_managed_workspace_path(&root, artifact)?;
            let exists = root.join(artifact).exists();
            (
                if exists { "pass" } else { "fail" }.into(),
                None,
                format!(
                    "artifact {} {}",
                    artifact,
                    if exists { "exists" } else { "is missing" }
                )
                .into_bytes(),
                if exists {
                    vec![artifact.into()]
                } else {
                    Vec::new()
                },
            )
        }
        "manual_review" | "external_approval" => {
            command = None;
            (
                "pending".into(),
                None,
                format!(
                    "{} requires explicit external evidence; ICARUS did not infer approval.",
                    criterion_type
                )
                .into_bytes(),
                Vec::new(),
            )
        }
        _ => {
            let command_text = command.clone().ok_or_else(|| {
                HarnessError::invalid(format!("{criterion_type} criterion requires a command"))
            })?;
            #[cfg(unix)]
            let output = Command::new("/bin/sh")
                .args(["-lc", &command_text])
                .current_dir(&root)
                .output()
                .map_err(HarnessError::from)?;
            #[cfg(windows)]
            let output = Command::new("cmd")
                .args(["/C", &command_text])
                .current_dir(&root)
                .output()
                .map_err(HarnessError::from)?;
            let mut combined = output.stdout;
            combined.extend_from_slice(&output.stderr);
            (
                if output.status.success() {
                    "pass"
                } else {
                    "fail"
                }
                .into(),
                output.status.code(),
                combined,
                Vec::new(),
            )
        }
    };
    let output_digest = sha256(&output);
    let output_path = evidence_dir(&root, task_id)
        .join("test-results")
        .join(format!("{}-{}.log", criterion_id, &output_digest[..12]));
    atomic_write(&output_path, &output)?;
    let git_status = git_output(&root, &["status", "--porcelain=v1"]).unwrap_or_default();
    let receipt = VerificationReceipt {
        schema_version: 1,
        task_id: task.task_id.clone(),
        execution_id: task.execution_id.clone(),
        criterion_id: criterion_id.into(),
        criterion_type,
        status,
        command,
        working_directory: root.display().to_string(),
        started_at,
        finished_at: now_rfc3339(),
        exit_code,
        git_sha: git_output(&root, &["rev-parse", "HEAD"]),
        dirty_state_fingerprint: sha256(git_status.as_bytes()),
        contract_digest: task.contract_digest.clone(),
        toolchain: toolchain_versions(&root),
        output_digest,
        output_excerpt: bounded_excerpt(&output),
        output_path: output_path
            .strip_prefix(&root)
            .unwrap_or(&output_path)
            .to_string_lossy()
            .replace('\\', "/"),
        artifacts,
        expires_at: None,
        attestation: None,
    };
    let receipts_path = evidence_dir(&root, task_id).join("commands.jsonl");
    fs::create_dir_all(receipts_path.parent().unwrap())?;
    let mut log = OpenOptions::new()
        .append(true)
        .create(true)
        .open(&receipts_path)?;
    writeln!(log, "{}", serde_json::to_string(&receipt)?)?;
    log.sync_all()?;
    append_event(
        &root,
        EventInput {
            execution_id: task.execution_id,
            task_id: task.task_id,
            event_type: "criterion_verified".into(),
            worktree_id: "main".into(),
            timestamp: None,
            payload: json!({"criterion_id": criterion_id, "status": receipt.status, "output_digest": receipt.output_digest, "git_sha": receipt.git_sha, "dirty_state_fingerprint": receipt.dirty_state_fingerprint}),
        },
    )?;
    Ok(receipt)
}

fn parse_future_expiry(expires_at: &str) -> Result<()> {
    let expiry =
        time::OffsetDateTime::parse(expires_at, &time::format_description::well_known::Rfc3339)
            .map_err(|_| HarnessError::invalid("approval expiry must be an RFC3339 timestamp"))?;
    if expiry <= time::OffsetDateTime::now_utc() {
        return Err(HarnessError::invalid(
            "approval expiry must be in the future",
        ));
    }
    Ok(())
}

/// Record an attributable human/manual gate for an immutable contract criterion. This is not a
/// generic 'pass' switch: only `manual_review` and `external_approval` criteria can be
/// attested, the approval id is required, and external approvals must be expiry-bound.
pub fn attest_task_criterion(
    repo_root: &Path,
    task_id: &str,
    criterion_id: &str,
    approval_id: &str,
    approver: &str,
    expires_at: Option<String>,
) -> Result<VerificationReceipt> {
    let root = canonical_root(repo_root)?;
    let task = task_status(&root, task_id)?;
    if !matches!(task.status.as_str(), "executing" | "verifying") {
        return Err(HarnessError::invalid(
            "attestation requires an executing or verifying task",
        ));
    }
    if approval_id.trim().is_empty() || approver.trim().is_empty() {
        return Err(HarnessError::invalid(
            "attestation requires approval id and approver",
        ));
    }
    let criterion = criterion_for(&task, criterion_id)?;
    let criterion_type = criterion
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| HarnessError::invalid("criterion requires a type"))?
        .to_owned();
    if !matches!(
        criterion_type.as_str(),
        "manual_review" | "external_approval"
    ) {
        return Err(HarnessError::invalid(
            "only manual_review or external_approval criteria may be attested",
        ));
    }
    if criterion_type == "external_approval" {
        let expiry = expires_at
            .as_deref()
            .ok_or_else(|| HarnessError::invalid("external approval requires an expiry"))?;
        parse_future_expiry(expiry)?;
    }
    let started_at = now_rfc3339();
    let output = format!(
        "{} attested by {} with approval {}{}",
        criterion_type,
        approver.trim(),
        approval_id.trim(),
        expires_at
            .as_deref()
            .map(|value| format!("; expires {value}"))
            .unwrap_or_default(),
    )
    .into_bytes();
    let output_digest = sha256(&output);
    let output_path = evidence_dir(&root, task_id).join("approvals").join(format!(
        "{}-{}.log",
        criterion_id,
        &output_digest[..12]
    ));
    atomic_write(&output_path, &output)?;
    let git_status = git_output(&root, &["status", "--porcelain=v1"]).unwrap_or_default();
    let receipt = VerificationReceipt {
        schema_version: 1,
        task_id: task.task_id.clone(),
        execution_id: task.execution_id.clone(),
        criterion_id: criterion_id.into(),
        criterion_type,
        status: "pass".into(),
        command: None,
        working_directory: root.display().to_string(),
        started_at,
        finished_at: now_rfc3339(),
        exit_code: None,
        git_sha: git_output(&root, &["rev-parse", "HEAD"]),
        dirty_state_fingerprint: sha256(git_status.as_bytes()),
        contract_digest: task.contract_digest.clone(),
        toolchain: json!({"attestation": "explicit human/external reference"}),
        output_digest,
        output_excerpt: bounded_excerpt(&output),
        output_path: output_path
            .strip_prefix(&root)
            .unwrap_or(&output_path)
            .to_string_lossy()
            .replace('\\', "/"),
        artifacts: Vec::new(),
        expires_at,
        attestation: Some(json!({"approval_id": approval_id.trim(), "approver": approver.trim()})),
    };
    let receipts_path = evidence_dir(&root, task_id).join("commands.jsonl");
    fs::create_dir_all(receipts_path.parent().unwrap())?;
    let mut log = OpenOptions::new()
        .append(true)
        .create(true)
        .open(&receipts_path)?;
    writeln!(log, "{}", serde_json::to_string(&receipt)?)?;
    log.sync_all()?;
    append_event(
        &root,
        EventInput {
            execution_id: task.execution_id,
            task_id: task.task_id,
            event_type: "criterion_attested".into(),
            worktree_id: "main".into(),
            timestamp: None,
            payload: json!({"criterion_id": criterion_id, "approval_id": approval_id.trim(), "approver": approver.trim(), "expires_at": receipt.expires_at, "output_digest": receipt.output_digest}),
        },
    )?;
    Ok(receipt)
}

fn read_verification_receipts(root: &Path, task_id: &str) -> Result<Vec<VerificationReceipt>> {
    let path = evidence_dir(root, task_id).join("commands.jsonl");
    if !path.exists() {
        return Ok(Vec::new());
    }
    fs::read_to_string(path)?
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).map_err(HarnessError::from))
        .collect()
}

fn required_criteria(task: &TaskRecord) -> Vec<Value> {
    task.contract
        .acceptance_criteria
        .as_array()
        .into_iter()
        .flatten()
        .filter(|criterion| {
            criterion
                .get("required")
                .and_then(Value::as_bool)
                .unwrap_or(true)
        })
        .cloned()
        .collect()
}

fn task_is_high_risk(task: &TaskRecord) -> bool {
    let risk = task.contract.risk.to_ascii_lowercase();
    [
        "high",
        "critical",
        "security",
        "deploy",
        "credential",
        "migration",
        "destructive",
        "external",
    ]
    .iter()
    .any(|word| risk.contains(word))
}

fn checkpoint_contains_high_risk(value: &Value) -> bool {
    value.as_array().into_iter().flatten().any(|risk| {
        risk.get("high_risk")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || risk
                .get("severity")
                .and_then(Value::as_str)
                .is_some_and(|severity| {
                    matches!(severity.to_ascii_lowercase().as_str(), "high" | "critical")
                })
    })
}

/// A checkpoint is the task's latest declared operating state. A later checkpoint with an empty
/// `open_risks` list explicitly clears prior risks; old prose does not keep a task blocked
/// forever. High-risk contracts treat every open risk as seal-blocking, while lower-risk tasks
/// must mark a risk high/critical explicitly.
fn current_unresolved_high_risks(root: &Path, task: &TaskRecord) -> Result<Vec<String>> {
    let Some(checkpoint) = read_checkpoints(root, &task.task_id)?.last().cloned() else {
        return Ok(Vec::new());
    };
    let risks = checkpoint
        .open_risks
        .as_array()
        .cloned()
        .unwrap_or_default();
    if risks.is_empty()
        || (!task_is_high_risk(task) && !checkpoint_contains_high_risk(&checkpoint.open_risks))
    {
        return Ok(Vec::new());
    }
    Ok(risks
        .iter()
        .enumerate()
        .map(|(index, risk)| {
            let label = risk
                .get("id")
                .and_then(Value::as_str)
                .or_else(|| risk.as_str())
                .unwrap_or("unnamed risk");
            format!(
                "checkpoint {} unresolved high-risk issue {}: {label}",
                checkpoint.sequence,
                index + 1
            )
        })
        .collect())
}

/// Seal only with current, machine-produced passing evidence. Any source-state change after a
/// verification receipt invalidates it; ICARUS intentionally chooses safe over convenient.
pub fn seal_task(repo_root: &Path, task_id: &str) -> Result<SealResult> {
    let root = canonical_root(repo_root)?;
    let task = task_status(&root, task_id)?;
    if task.status != "verifying" {
        return Err(HarnessError::invalid("sealing requires a verifying task"));
    }
    let current_sha = git_output(&root, &["rev-parse", "HEAD"]);
    let current_dirty = sha256(
        git_output(&root, &["status", "--porcelain=v1"])
            .unwrap_or_default()
            .as_bytes(),
    );
    let receipts = read_verification_receipts(&root, task_id)?;
    let mut unmet = Vec::new();
    for criterion in required_criteria(&task) {
        let Some(id) = criterion.get("id").and_then(Value::as_str) else {
            unmet.push("contract criterion missing id".into());
            continue;
        };
        match receipts
            .iter()
            .rev()
            .find(|receipt| receipt.criterion_id == id)
        {
            None => unmet.push(format!("{id}: no receipt")),
            Some(receipt) if receipt.status != "pass" => {
                unmet.push(format!("{id}: receipt status {}", receipt.status))
            }
            Some(receipt) if receipt.contract_digest != task.contract_digest => {
                unmet.push(format!("{id}: contract changed since verification"))
            }
            Some(receipt)
                if receipt.git_sha != current_sha
                    || receipt.dirty_state_fingerprint != current_dirty =>
            {
                unmet.push(format!("{id}: workspace changed since verification"))
            }
            Some(receipt)
                if receipt.criterion_type == "external_approval"
                    && receipt
                        .expires_at
                        .as_deref()
                        .map(parse_future_expiry)
                        .transpose()
                        .is_err() =>
            {
                unmet.push(format!("{id}: external approval expired or invalid"))
            }
            Some(receipt)
                if receipt.criterion_type == "external_approval"
                    && receipt.expires_at.is_none() =>
            {
                unmet.push(format!("{id}: external approval has no expiry"))
            }
            Some(_) => {}
        }
    }
    // Never derive a seal-time scope decision from human-oriented porcelain lines: quoted,
    // renamed, and newline-containing paths can be represented ambiguously there. The shared
    // NUL-delimited collector covers staged plus unstaged tracked changes and untracked files.
    // On a non-Git compatibility workspace there is no trustworthy source-scope proof, so the
    // existing receipt/workspace checks still apply but no fabricated path list is produced.
    let changed = if git_repository(&root) {
        workspace_changed_paths(&root)?.into_iter().collect()
    } else {
        BTreeSet::new()
    };
    let allowed = build_globset(&task.contract.allowed_paths)?;
    let forbidden = build_globset(&task.contract.forbidden_paths)?;
    let mut issues: Vec<String> = changed
        .into_iter()
        .filter(|path| !allowed.is_match(path) || forbidden.is_match(path))
        .map(|path| format!("out-of-scope changed file: {path}"))
        .collect();
    let chain = verify_event_chain(&root, &load_manifest(&root)?.repo_id)?;
    if !chain.valid {
        issues.push(format!("event chain invalid: {}", chain.issues.join("; ")));
    }
    issues.extend(current_unresolved_high_risks(&root, &task)?);
    if !unmet.is_empty() || !issues.is_empty() {
        return Ok(SealResult {
            task_id: task.task_id,
            execution_id: task.execution_id,
            sealed: false,
            unmet_criteria: unmet,
            issues,
            final_receipt_path: None,
        });
    }
    let diff = git_output(&root, &["diff", "--binary", "HEAD"]).unwrap_or_default();
    let diff_path = evidence_dir(&root, task_id).join("diff.patch");
    atomic_write(&diff_path, diff.as_bytes())?;
    let final_path = runtime_root(&root)
        .join("tasks")
        .join(task_id)
        .join("final-result.json");
    let result = SealResult {
        task_id: task.task_id.clone(),
        execution_id: task.execution_id.clone(),
        sealed: true,
        unmet_criteria: Vec::new(),
        issues: Vec::new(),
        final_receipt_path: Some(
            final_path
                .strip_prefix(&root)
                .unwrap_or(&final_path)
                .to_string_lossy()
                .replace('\\', "/"),
        ),
    };
    atomic_write(&final_path, format!("{}\n", serde_json::to_string_pretty(&json!({"seal": result, "git_sha": current_sha, "dirty_state_fingerprint": current_dirty, "diff_digest": sha256(diff.as_bytes()), "receipts": receipts}))?).as_bytes())?;
    transition_task(&root, task_id, "sealed")?;
    Ok(result)
}

/// Export only a sealed task's final, machine-produced receipt. The raw runtime directory can
/// contain command output, paths, and agent-supplied checkpoint prose, so it is never exported
/// wholesale. `redacted` retains cryptographic evidence identifiers but removes content that can
/// disclose repository structure or people.
pub fn export_task(repo_root: &Path, task_id: &str, redacted: bool) -> Result<TaskExport> {
    let root = canonical_root(repo_root)?;
    let task = task_status(&root, task_id)?;
    if task.status != "sealed" {
        return Err(HarnessError::invalid(
            "only a sealed task has a final receipt eligible for export",
        ));
    }
    let final_path = runtime_root(&root)
        .join("tasks")
        .join(task_id)
        .join("final-result.json");
    let final_receipt: Value = serde_json::from_reader(
        File::open(&final_path)
            .map_err(|_| HarnessError::invalid("sealed task is missing its final receipt"))?,
    )?;
    if final_receipt
        .pointer("/seal/sealed")
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Err(HarnessError::invalid(
            "final receipt does not prove a sealed task",
        ));
    }
    let receipts = final_receipt
        .get("receipts")
        .and_then(Value::as_array)
        .ok_or_else(|| HarnessError::invalid("final receipt is missing verification receipts"))?;
    let criteria = receipts
        .iter()
        .map(|receipt| {
            let mut exported = json!({
                "criterion_type": receipt.get("criterion_type"),
                "status": receipt.get("status"),
                "output_digest": receipt.get("output_digest"),
                "expires_at": receipt.get("expires_at"),
            });
            if !redacted {
                exported["criterion_id"] =
                    receipt.get("criterion_id").cloned().unwrap_or(Value::Null);
                exported["artifacts"] = receipt
                    .get("artifacts")
                    .cloned()
                    .unwrap_or_else(|| json!([]));
                exported["output_excerpt"] = receipt
                    .get("output_excerpt")
                    .cloned()
                    .unwrap_or(Value::Null);
                exported["attestation"] =
                    receipt.get("attestation").cloned().unwrap_or(Value::Null);
            }
            exported
        })
        .collect();
    Ok(TaskExport {
        schema_version: 1,
        task_id: task.task_id,
        execution_id: task.execution_id,
        status: task.status,
        redacted,
        git_sha: final_receipt
            .get("git_sha")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        dirty_state_fingerprint: final_receipt
            .get("dirty_state_fingerprint")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                HarnessError::invalid("final receipt is missing its dirty-state fingerprint")
            })?
            .to_owned(),
        diff_digest: final_receipt
            .get("diff_digest")
            .and_then(Value::as_str)
            .ok_or_else(|| HarnessError::invalid("final receipt is missing its diff digest"))?
            .to_owned(),
        criteria,
        objective: (!redacted).then_some(task.objective),
        final_receipt_path: (!redacted).then(|| {
            final_path
                .strip_prefix(&root)
                .unwrap_or(&final_path)
                .to_string_lossy()
                .replace('\\', "/")
        }),
    })
}

fn skill_id_valid(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_'))
}
fn skill_contains_secret(skill: &HarnessSkill) -> bool {
    let material = format!(
        "{} {}",
        skill.instructions,
        skill.policy_requirements.join(" ")
    )
    .to_ascii_lowercase();
    [
        "api_key",
        "password=",
        "private key",
        "authorization: bearer",
    ]
    .iter()
    .any(|needle| material.contains(needle))
}

fn skill_proof_is_current(skill: &Value) -> bool {
    skill
        .get("proof_expires_at")
        .and_then(Value::as_str)
        .and_then(|value| {
            time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()
        })
        .map(|expiry| expiry > time::OffsetDateTime::now_utc())
        .unwrap_or(false)
}

fn proposed_skill_path(root: &Path, skill_id: &str) -> PathBuf {
    runtime_root(root)
        .join("skills/proposed")
        .join(format!("{skill_id}.json"))
}

fn skill_evaluation_path(root: &Path, skill_id: &str, replay_task_id: &str) -> PathBuf {
    runtime_root(root)
        .join("skills/evaluations")
        .join(skill_id)
        .join(format!("{replay_task_id}.json"))
}

fn active_skill_path(root: &Path, skill_id: &str) -> PathBuf {
    root.join(".icarus/skills/active")
        .join(format!("{skill_id}.json"))
}

fn skill_outcome_path(root: &Path, skill_id: &str, task_id: &str) -> PathBuf {
    runtime_root(root)
        .join("skills/outcomes")
        .join(skill_id)
        .join(format!("{task_id}.json"))
}

fn native_skill_outcomes(root: &Path, skill: &HarnessSkill) -> Result<Vec<SkillEvaluation>> {
    let directory = runtime_root(root).join("skills/outcomes").join(&skill.id);
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut outcomes = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let outcome: SkillEvaluation = serde_json::from_reader(File::open(entry.path())?)?;
        if outcome.schema_version == 1 && outcome.skill_id == skill.id {
            outcomes.push(outcome);
        }
    }
    outcomes.sort_by(|left, right| left.replay_task_id.cmp(&right.replay_task_id));
    Ok(outcomes)
}

fn skill_candidate_digest(skill: &HarnessSkill) -> Result<String> {
    Ok(sha256(serde_json::to_vec(skill)?.as_slice()))
}

fn native_skill_evaluations(root: &Path, skill: &HarnessSkill) -> Result<Vec<SkillEvaluation>> {
    let directory = runtime_root(root)
        .join("skills/evaluations")
        .join(&skill.id);
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let digest = skill_candidate_digest(skill)?;
    let mut evaluations = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let evaluation: SkillEvaluation = serde_json::from_reader(File::open(entry.path())?)?;
        if evaluation.schema_version == 1
            && evaluation.skill_id == skill.id
            && evaluation.candidate_digest == digest
        {
            evaluations.push(evaluation);
        }
    }
    evaluations.sort_by(|left, right| left.replay_task_id.cmp(&right.replay_task_id));
    Ok(evaluations)
}

/// Evaluate a proposed procedure against a separate, sealed replay task. ICARUS does not call a
/// model here: the coding agent performs the replay, then this native gate proves that its task
/// sealed with ICARUS receipts and explicitly checkpointed the candidate it applied.
pub fn evaluate_skill(
    repo_root: &Path,
    skill_id: &str,
    replay_task_id: &str,
) -> Result<SkillEvaluation> {
    let root = canonical_root(repo_root)?;
    let skill: HarnessSkill = serde_json::from_reader(
        File::open(proposed_skill_path(&root, skill_id))
            .map_err(|_| HarnessError::invalid("proposed skill does not exist"))?,
    )?;
    if skill_contains_secret(&skill) {
        return Err(HarnessError::invalid(
            "skill candidate appears to contain a secret",
        ));
    }
    let replay_task = task_status(&root, replay_task_id)?;
    let mut issues = Vec::new();
    if skill
        .source_tasks
        .iter()
        .any(|source| source == replay_task_id)
    {
        issues.push("replay task must be independent of the candidate source tasks".into());
    }
    if replay_task.status != "sealed" {
        issues.push("replay task is not sealed".into());
    }
    let checkpoints = read_checkpoints(&root, replay_task_id)?;
    let applied = checkpoints.iter().any(|checkpoint| {
        checkpoint
            .input
            .get("applied_skill_id")
            .and_then(Value::as_str)
            == Some(skill_id)
    });
    if !applied {
        issues.push("replay task has no checkpoint binding it to this proposed skill".into());
    }
    let final_path = runtime_root(&root)
        .join("tasks")
        .join(replay_task_id)
        .join("final-result.json");
    let final_receipt = fs::read(&final_path).unwrap_or_default();
    if final_receipt.is_empty() {
        issues.push("replay task final receipt is missing".into());
    }
    let evaluation = SkillEvaluation {
        schema_version: 1,
        skill_id: skill.id.clone(),
        candidate_digest: skill_candidate_digest(&skill)?,
        replay_task_id: replay_task.task_id.clone(),
        replay_execution_id: replay_task.execution_id,
        status: if issues.is_empty() { "pass" } else { "fail" }.into(),
        source_task_ids: skill.source_tasks.clone(),
        final_receipt_digest: sha256(&final_receipt),
        observed_at: now_rfc3339(),
        issues,
    };
    atomic_write(
        &skill_evaluation_path(&root, skill_id, replay_task_id),
        format!("{}\n", serde_json::to_string_pretty(&evaluation)?).as_bytes(),
    )?;
    Ok(evaluation)
}

/// Record the observed terminal outcome of an active procedure. The task itself establishes the
/// result: only a sealed task is a pass, while a blocked or failed task is a failure. A caller
/// cannot submit an arbitrary success/failure bit.
pub fn record_active_skill_outcome(
    repo_root: &Path,
    skill_id: &str,
    task_id: &str,
) -> Result<SkillEvaluation> {
    let root = canonical_root(repo_root)?;
    let path = active_skill_path(&root, skill_id);
    let skill: HarnessSkill = serde_json::from_reader(
        File::open(&path).map_err(|_| HarnessError::invalid("active skill does not exist"))?,
    )?;
    if skill.state != "active"
        || skill.verification.get("status").and_then(Value::as_str) != Some("verified")
    {
        return Err(HarnessError::invalid(
            "only an active verified skill can receive an outcome",
        ));
    }
    let task = task_status(&root, task_id)?;
    if !matches!(task.status.as_str(), "sealed" | "blocked" | "failed") {
        return Err(HarnessError::invalid(
            "skill outcome requires a sealed, blocked, or failed task",
        ));
    }
    let checkpoints = read_checkpoints(&root, task_id)?;
    if !checkpoints.iter().any(|checkpoint| {
        checkpoint
            .input
            .get("applied_skill_id")
            .and_then(Value::as_str)
            == Some(skill_id)
    }) {
        return Err(HarnessError::invalid(
            "task has no checkpoint binding it to this active skill",
        ));
    }
    let safety_violation = checkpoints.iter().any(|checkpoint| {
        checkpoint
            .input
            .get("safety_violation")
            .and_then(Value::as_bool)
            == Some(true)
            || checkpoint
                .input
                .get("safety_violations")
                .and_then(Value::as_array)
                .is_some_and(|violations| !violations.is_empty())
    });
    let final_path = runtime_root(&root)
        .join("tasks")
        .join(task_id)
        .join("final-result.json");
    let final_receipt = fs::read(&final_path).unwrap_or_default();
    let mut issues = Vec::new();
    if task.status != "sealed" {
        issues.push(format!("task ended {0}", task.status));
    }
    if safety_violation {
        issues.push("task checkpoint recorded a safety violation".into());
    }
    let outcome = SkillEvaluation {
        schema_version: 1,
        skill_id: skill.id.clone(),
        candidate_digest: skill_candidate_digest(&skill)?,
        replay_task_id: task.task_id.clone(),
        replay_execution_id: task.execution_id,
        status: if task.status == "sealed" && !safety_violation {
            "pass"
        } else {
            "fail"
        }
        .into(),
        source_task_ids: skill.source_tasks.clone(),
        final_receipt_digest: sha256(&final_receipt),
        observed_at: now_rfc3339(),
        issues,
    };
    atomic_write(
        &skill_outcome_path(&root, skill_id, task_id),
        format!("{}\n", serde_json::to_string_pretty(&outcome)?).as_bytes(),
    )?;
    append_event(
        &root,
        EventInput {
            execution_id: outcome.replay_execution_id.clone(),
            task_id: outcome.replay_task_id.clone(),
            event_type: "skill_outcome_recorded".into(),
            worktree_id: "main".into(),
            timestamp: None,
            payload: serde_json::to_value(&outcome)?,
        },
    )?;
    Ok(outcome)
}

fn skill_demotion_reasons(
    root: &Path,
    skill: &HarnessSkill,
    policy_version: u32,
    now: time::OffsetDateTime,
) -> Result<Vec<String>> {
    let mut reasons = Vec::new();
    if skill.schema_version != 1 {
        reasons.push("skill schema is incompatible with the current harness".into());
    }
    if skill
        .verification
        .get("promotion")
        .and_then(|promotion| promotion.get("policy_version"))
        .and_then(Value::as_u64)
        != Some(u64::from(policy_version))
    {
        reasons.push("skill was promoted under an incompatible policy version".into());
    }
    match skill.proof_expires_at.as_deref().and_then(|value| {
        time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()
    }) {
        Some(expiry) if expiry + time::Duration::days(30) < now => {
            reasons.push("skill proof window expired more than 30 days ago".into());
        }
        None => reasons.push("skill proof expiry is missing or invalid".into()),
        _ => {}
    }
    let outcomes = native_skill_outcomes(root, skill)?;
    let failures = outcomes
        .iter()
        .filter(|outcome| outcome.status == "fail")
        .count();
    if failures >= 3 {
        reasons.push(format!("skill has {failures} applicable native failures"));
    }
    if outcomes.iter().any(|outcome| {
        outcome.status == "fail"
            && outcome
                .issues
                .iter()
                .any(|issue| issue.contains("safety violation"))
    }) {
        reasons.push("a native outcome recorded a safety violation".into());
    }
    Ok(reasons)
}

/// Apply the deterministic skill-health policy. This is the only automatic authority change in
/// the skill lifecycle: it can demote an unsafe/stale procedure, never promote one.
pub fn review_active_skills(repo_root: &Path) -> Result<SkillHealthReview> {
    let root = canonical_root(repo_root)?;
    let manifest = load_manifest(&root)?;
    let reviewed_at = now_rfc3339();
    let now = time::OffsetDateTime::now_utc();
    let directory = root.join(".icarus/skills/active");
    let mut paths: Vec<_> = fs::read_dir(&directory)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(|entry| entry.ok().map(|entry| entry.path())))
        .filter(|path| {
            path.is_file()
                && path.extension().and_then(|extension| extension.to_str()) == Some("json")
        })
        .collect();
    paths.sort();
    let mut scanned_skill_ids = Vec::new();
    let mut demoted_skill_ids = Vec::new();
    let mut issues = Vec::new();
    for path in paths {
        let mut skill: HarnessSkill = match serde_json::from_reader(File::open(&path)?) {
            Ok(skill) => skill,
            Err(error) => {
                issues.push(format!("could not inspect {}: {error}", path.display()));
                continue;
            }
        };
        if skill.state != "active" {
            continue;
        }
        scanned_skill_ids.push(skill.id.clone());
        let reasons = skill_demotion_reasons(&root, &skill, manifest.policy_version, now)?;
        if reasons.is_empty() {
            continue;
        }
        let prior_verification = skill.verification.clone();
        skill.state = "demoted".into();
        skill.verification = json!({
            "status": "demoted",
            "reason": reasons,
            "demoted_at": reviewed_at,
            "previous_verification": prior_verification,
        });
        let archive = runtime_root(&root)
            .join("skills/demoted")
            .join(format!("{}-v{}.json", skill.id, skill.version));
        atomic_write(
            &archive,
            format!("{}\n", serde_json::to_string_pretty(&skill)?).as_bytes(),
        )?;
        atomic_write(
            &path,
            format!("{}\n", serde_json::to_string_pretty(&skill)?).as_bytes(),
        )?;
        append_event(
            &root,
            EventInput {
                execution_id: "skill-health".into(),
                task_id: format!("skill:{}", skill.id),
                event_type: "skill_demoted".into(),
                worktree_id: "main".into(),
                timestamp: Some(reviewed_at.clone()),
                payload: json!({"skill_id": skill.id, "reasons": skill.verification["reason"]}),
            },
        )?;
        demoted_skill_ids.push(skill.id);
    }
    Ok(SkillHealthReview {
        schema_version: 1,
        reviewed_at,
        scanned_skill_ids,
        demoted_skill_ids,
        issues,
    })
}

pub fn propose_skill(repo_root: &Path, mut skill: HarnessSkill) -> Result<HarnessSkill> {
    let root = canonical_root(repo_root)?;
    load_manifest(&root)?;
    if !skill_id_valid(&skill.id)
        || skill.instructions.trim().is_empty()
        || skill.source_tasks.is_empty()
        || skill.task_types.is_empty()
        || skill.file_patterns.is_empty()
    {
        return Err(HarnessError::invalid(
            "skill requires a safe id, instructions, sealed source tasks, task_types, and file_patterns",
        ));
    }
    let proof_expiry = skill
        .proof_expires_at
        .as_deref()
        .ok_or_else(|| HarnessError::invalid("skill requires an RFC3339 proof expiry"))?;
    parse_future_expiry(proof_expiry)?;
    if skill_contains_secret(&skill) {
        return Err(HarnessError::invalid(
            "skill candidate appears to contain a secret",
        ));
    }
    for task_id in &skill.source_tasks {
        if task_status(&root, task_id)?.status != "sealed" {
            return Err(HarnessError::invalid(format!(
                "source task `{task_id}` is not sealed"
            )));
        }
    }
    skill.schema_version = 1;
    skill.state = "proposed".into();
    skill.version = skill.version.max(1);
    let path = proposed_skill_path(&root, &skill.id);
    atomic_write(
        &path,
        format!("{}\n", serde_json::to_string_pretty(&skill)?).as_bytes(),
    )?;
    Ok(skill)
}
pub fn promote_skill(
    repo_root: &Path,
    skill_id: &str,
    owner_approval: Option<String>,
) -> Result<HarnessSkill> {
    let root = canonical_root(repo_root)?;
    let proposed = proposed_skill_path(&root, skill_id);
    let mut skill: HarnessSkill = serde_json::from_reader(
        File::open(&proposed)
            .map_err(|_| HarnessError::invalid("proposed skill does not exist"))?,
    )?;
    if skill_contains_secret(&skill) {
        return Err(HarnessError::invalid(
            "skill candidate appears to contain a secret",
        ));
    }
    let high_risk = [
        "security",
        "deploy",
        "credential",
        "migration",
        "destructive",
        "external",
    ]
    .iter()
    .any(|word| skill.risk.to_ascii_lowercase().contains(word));
    if high_risk && owner_approval.as_deref().unwrap_or("").is_empty() {
        return Err(HarnessError::invalid(
            "high-risk skill promotion requires owner approval",
        ));
    }
    let evaluations = native_skill_evaluations(&root, &skill)?;
    let successful_replays: BTreeSet<_> = evaluations
        .iter()
        .filter(|evaluation| evaluation.status == "pass")
        .map(|evaluation| evaluation.replay_task_id.clone())
        .collect();
    if high_risk && successful_replays.is_empty() {
        return Err(HarnessError::invalid(
            "high-risk promotion requires at least one successful native replay evaluation",
        ));
    }
    if !high_risk && (skill.source_tasks.len() < 3 || successful_replays.len() < 2) {
        return Err(HarnessError::invalid(
            "low-risk promotion requires 3 sealed sources and 2 successful native replay evaluations",
        ));
    }
    for task_id in &skill.source_tasks {
        if task_status(&root, task_id)?.status != "sealed" {
            return Err(HarnessError::invalid(format!(
                "source task `{task_id}` is no longer sealed"
            )));
        }
    }
    skill.state = "active".into();
    skill.verification = json!({
        "status": "verified",
        "promotion": {
            "approval_id": owner_approval,
            "policy_version": load_manifest(&root)?.policy_version,
            "source_task_count": skill.source_tasks.len(),
            "successful_native_replay_count": successful_replays.len(),
            "proof_expires_at": skill.proof_expires_at,
            "evaluation_receipts": evaluations.iter().filter(|evaluation| evaluation.status == "pass").map(|evaluation| format!(".icarus/runtime/skills/evaluations/{}/{}.json", skill.id, evaluation.replay_task_id)).collect::<Vec<_>>(),
        }
    });
    let active = root
        .join(".icarus/skills/active")
        .join(format!("{}.json", skill.id));
    atomic_write(
        &active,
        format!("{}\n", serde_json::to_string_pretty(&skill)?).as_bytes(),
    )?;
    Ok(skill)
}

/// Retire a procedure without erasing its provenance. Retirement is an authority-changing
/// operation: it needs an attributable owner approval and writes both an immutable runtime
/// archive and the tracked skill state that causes future context packs to exclude it.
pub fn retire_skill(
    repo_root: &Path,
    skill_id: &str,
    reason: &str,
    owner_approval: Option<String>,
) -> Result<HarnessSkill> {
    let root = canonical_root(repo_root)?;
    load_manifest(&root)?;
    if !skill_id_valid(skill_id) || reason.trim().is_empty() {
        return Err(HarnessError::invalid(
            "retirement requires a valid skill id and reason",
        ));
    }
    let approval = owner_approval
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| HarnessError::invalid("skill retirement requires owner approval"))?;
    // Direct children of `.icarus/skills/` were used by the preview implementation. Read
    // them for a non-destructive migration, but all new records use `active/`.
    let active_v1 = root
        .join(".icarus/skills/active")
        .join(format!("{skill_id}.json"));
    let legacy_active = root.join(".icarus/skills").join(format!("{skill_id}.json"));
    let active = if active_v1.exists() {
        active_v1
    } else {
        legacy_active
    };
    let mut skill: HarnessSkill = serde_json::from_reader(
        File::open(&active).map_err(|_| HarnessError::invalid("active skill does not exist"))?,
    )?;
    if skill.state != "active" {
        return Err(HarnessError::invalid("only an active skill can be retired"));
    }
    skill.state = "retired".into();
    skill.verification = json!({
        "status": "retired",
        "reason": reason,
        "approval_id": approval,
    });
    let archive = runtime_root(&root)
        .join("skills/retired")
        .join(format!("{}-v{}.json", skill.id, skill.version));
    atomic_write(
        &archive,
        format!("{}\n", serde_json::to_string_pretty(&skill)?).as_bytes(),
    )?;
    let tracked_archive = root
        .join(".icarus/skills/retired")
        .join(format!("{}-v{}.json", skill.id, skill.version));
    atomic_write(
        &tracked_archive,
        format!("{}\n", serde_json::to_string_pretty(&skill)?).as_bytes(),
    )?;
    atomic_write(
        &active,
        format!("{}\n", serde_json::to_string_pretty(&skill)?).as_bytes(),
    )?;
    Ok(skill)
}

fn read_checkpoints(root: &Path, task_id: &str) -> Result<Vec<Checkpoint>> {
    let path = checkpoints_path(root, task_id)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    fs::read_to_string(path)?
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).map_err(HarnessError::from))
        .collect()
}

fn git_output(root: &Path, args: &[&str]) -> Option<String> {
    Command::new("git")
        .arg("-C")
        .arg(external_path(root))
        .args(args)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|text| text.trim().to_owned())
}

fn graph_digest(root: &Path) -> Option<String> {
    fs::read(runtime_root(root).join("graph/graph.db"))
        .ok()
        .map(|bytes| sha256(&bytes))
}

fn graph_receipt_path(root: &Path) -> PathBuf {
    runtime_root(root).join("graph/receipt.json")
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit())
}

fn is_graph_source(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|extension| extension.to_str()),
        Some("js" | "jsx" | "mjs" | "cjs" | "ts" | "tsx" | "rs")
    )
}

fn collect_graph_sources(root: &Path, directory: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        if entry.file_type()?.is_dir() {
            if matches!(
                name.as_ref(),
                "node_modules" | ".git" | "target" | ".icarus-graph" | "dist" | "build"
            ) {
                continue;
            }
            collect_graph_sources(root, &path, files)?;
        } else if is_graph_source(&path) {
            files.push(path.strip_prefix(root).unwrap_or(&path).to_path_buf());
        }
    }
    Ok(())
}

/// Mirror the supported-file universe used by the graph adapter. Sort by raw path components,
/// never locale, so this fingerprint is portable and deterministic.
pub fn graph_source_fingerprint(root: &Path) -> Result<String> {
    let mut files = Vec::new();
    collect_graph_sources(root, root, &mut files)?;
    files.sort();
    let mut hasher = Sha256::new();
    for relative in files {
        let normalized = relative.to_string_lossy().replace('\\', "/");
        hasher.update(normalized.as_bytes());
        hasher.update([0]);
        hasher.update(fs::read(root.join(&relative))?);
        hasher.update([0]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Store a graph build receipt under Rust's atomic-write authority. `source_fingerprint` is
/// independently recomputed, preventing an adapter from recording a graph as current for a
/// different source tree.
pub fn record_graph_receipt(repo_root: &Path, source_fingerprint: String) -> Result<GraphReceipt> {
    let root = canonical_root(repo_root)?;
    load_manifest(&root)?;
    if !is_sha256(&source_fingerprint) {
        return Err(HarnessError::invalid("invalid graph source fingerprint"));
    }
    let observed = graph_source_fingerprint(&root)?;
    if observed != source_fingerprint {
        return Err(HarnessError::invalid(
            "graph source fingerprint changed during build; rebuild the graph",
        ));
    }
    let graph_digest = graph_digest(&root)
        .ok_or_else(|| HarnessError::invalid("graph database is missing after graph build"))?;
    let receipt = GraphReceipt {
        schema_version: 1,
        source_fingerprint,
        graph_digest,
        recorded_at: now_rfc3339(),
    };
    atomic_write(
        &graph_receipt_path(&root),
        format!("{}\n", serde_json::to_string_pretty(&receipt)?).as_bytes(),
    )?;
    Ok(receipt)
}

fn graph_freshness(root: &Path) -> Value {
    let Some(current_digest) = graph_digest(root) else {
        return json!({"current": false, "reason": "graph database is missing"});
    };
    let receipt: GraphReceipt = match File::open(graph_receipt_path(root))
        .ok()
        .and_then(|file| serde_json::from_reader::<_, GraphReceipt>(file).ok())
    {
        Some(receipt) if receipt.schema_version == 1 => receipt,
        _ => {
            return json!({"current": false, "graph_digest": current_digest, "reason": "graph build receipt is missing or invalid"})
        }
    };
    let current_source = match graph_source_fingerprint(root) {
        Ok(fingerprint) => fingerprint,
        Err(error) => {
            return json!({"current": false, "graph_digest": current_digest, "reason": error.to_string()})
        }
    };
    let current =
        receipt.graph_digest == current_digest && receipt.source_fingerprint == current_source;
    json!({
        "current": current,
        "graph_digest": current_digest,
        "source_fingerprint": current_source,
        "receipt": receipt,
        "reason": if current { "verified graph receipt matches supported source" } else { "graph database or supported source differs from its build receipt" },
    })
}

fn graph_query_terms(objective: &str) -> Vec<String> {
    let mut terms = BTreeSet::new();
    for word in objective
        .split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
        .map(str::to_ascii_lowercase)
    {
        if word.len() >= 3 {
            terms.insert(word);
        }
    }
    terms.into_iter().collect()
}

/// Read a bounded slice from the portable SQLite graph only after its receipt is current. This
/// keeps relevance selection in Rust and never forwards a stale structural claim to an agent.
fn graph_slice(root: &Path, objective: &str) -> Value {
    let freshness = graph_freshness(root);
    if !freshness
        .get("current")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return json!({"available": false, "freshness": freshness, "reason": "rebuild graph before using structural context"});
    }
    let terms = graph_query_terms(objective);
    if terms.is_empty() {
        return json!({"available": true, "freshness": freshness, "nodes": [], "edges": [], "reason": "task objective contains no structural search terms"});
    }
    let database = runtime_root(root).join("graph/graph.db");
    let connection = match Connection::open_with_flags(
        database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(connection) => connection,
        Err(error) => {
            return json!({"available": false, "freshness": freshness, "reason": format!("cannot read graph database: {error}")})
        }
    };
    let mut nodes = Vec::new();
    for term in terms.iter().take(8) {
        let pattern = format!("%{term}%");
        let mut statement = match connection.prepare(
            "SELECT qualified_name, file_path, start_line, end_line, language FROM nodes \
             WHERE lower(name) LIKE ?1 OR lower(qualified_name) LIKE ?1 \
             ORDER BY file_path, start_line LIMIT 8",
        ) {
            Ok(statement) => statement,
            Err(error) => {
                return json!({"available": false, "freshness": freshness, "reason": format!("invalid graph node schema: {error}")})
            }
        };
        let rows = match statement.query_map([pattern], |row| {
            Ok(json!({
                "qualified_name": row.get::<_, String>(0)?,
                "file_path": row.get::<_, String>(1)?,
                "start_line": row.get::<_, i64>(2)?,
                "end_line": row.get::<_, i64>(3)?,
                "language": row.get::<_, String>(4)?,
            }))
        }) {
            Ok(rows) => rows,
            Err(error) => {
                return json!({"available": false, "freshness": freshness, "reason": format!("cannot query graph nodes: {error}")})
            }
        };
        for row in rows {
            match row {
                Ok(node) if !nodes.contains(&node) && nodes.len() < 16 => nodes.push(node),
                Ok(_) => {}
                Err(error) => {
                    return json!({"available": false, "freshness": freshness, "reason": format!("cannot decode graph node: {error}")})
                }
            }
        }
    }
    let mut edges = Vec::new();
    for node in nodes.iter().take(8) {
        let Some(qualified_name) = node.get("qualified_name").and_then(Value::as_str) else {
            continue;
        };
        let mut statement = match connection.prepare(
            "SELECT kind, source_qualified, target_qualified, file_path, line FROM edges \
             WHERE source_qualified = ?1 OR target_qualified = ?1 \
             ORDER BY file_path, line LIMIT 8",
        ) {
            Ok(statement) => statement,
            Err(error) => {
                return json!({"available": false, "freshness": freshness, "reason": format!("invalid graph edge schema: {error}")})
            }
        };
        let rows = match statement.query_map([qualified_name], |row| {
            Ok(json!({
                "kind": row.get::<_, String>(0)?,
                "source_qualified": row.get::<_, String>(1)?,
                "target_qualified": row.get::<_, String>(2)?,
                "file_path": row.get::<_, String>(3)?,
                "line": row.get::<_, i64>(4)?,
            }))
        }) {
            Ok(rows) => rows,
            Err(error) => {
                return json!({"available": false, "freshness": freshness, "reason": format!("cannot query graph edges: {error}")})
            }
        };
        for row in rows {
            match row {
                Ok(edge) if !edges.contains(&edge) && edges.len() < 24 => edges.push(edge),
                Ok(_) => {}
                Err(error) => {
                    return json!({"available": false, "freshness": freshness, "reason": format!("cannot decode graph edge: {error}")})
                }
            }
        }
    }
    json!({"available": true, "freshness": freshness, "terms": terms, "nodes": nodes, "edges": edges})
}

fn repo_local_org(root: &Path) -> String {
    // This deliberately mirrors cli-lib.js's repoOrgName() result: a harness may only read
    // the repo-local shard, never the user's global/default memory corpus.
    let raw = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let mut normalized = String::new();
    let mut last_was_separator = false;
    for character in raw.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
            normalized.push(character.to_ascii_lowercase());
            last_was_separator = false;
        } else if !last_was_separator {
            normalized.push('-');
            last_was_separator = true;
        }
    }
    normalized = normalized.trim_matches('-').to_owned();
    if normalized.is_empty() {
        "default".into()
    } else {
        normalized
    }
}

#[cfg(unix)]
struct SharedShardReadLock(File);

#[cfg(unix)]
impl SharedShardReadLock {
    fn acquire(path: &Path) -> std::result::Result<Self, String> {
        use std::os::unix::io::AsRawFd;
        let file = File::open(path).map_err(|error| error.to_string())?;
        // SAFETY: the descriptor belongs to `file` for the duration of the call. A shared,
        // non-blocking lock gives readers a stable committed snapshot without waiting behind a
        // long-running ingest or opening a competing writer handle.
        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_SH | libc::LOCK_NB) };
        if result == 0 {
            Ok(Self(file))
        } else {
            Err("repo-local shard is busy; retry after the writer releases shard.lock".into())
        }
    }
}

#[cfg(unix)]
impl Drop for SharedShardReadLock {
    fn drop(&mut self) {
        use std::os::unix::io::AsRawFd;
        // SAFETY: this descriptor is owned by the guard and the unlock is best-effort only.
        unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN) };
    }
}

#[cfg(windows)]
struct SharedShardReadLock(File);

#[cfg(windows)]
impl SharedShardReadLock {
    fn acquire(path: &Path) -> std::result::Result<Self, String> {
        use fs2::FileExt;
        let file = File::open(path).map_err(|error| error.to_string())?;
        // LockFileEx's shared lock can block behind the writer in this process model. A
        // non-blocking exclusive probe has the same safety property—never read mid-write—and
        // is released immediately after the bounded read. It is intentionally Windows-only.
        if FileExt::try_lock_exclusive(&file).is_ok() {
            Ok(Self(file))
        } else {
            Err("repo-local shard is busy; retry after the writer releases shard.lock".into())
        }
    }
}

#[cfg(windows)]
impl Drop for SharedShardReadLock {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.0);
    }
}

#[cfg(not(any(unix, windows)))]
struct SharedShardReadLock;

#[cfg(not(any(unix, windows)))]
impl SharedShardReadLock {
    fn acquire(_path: &Path) -> std::result::Result<Self, String> {
        Err("repo-local AMR read locking is unsupported on this platform".into())
    }
}

#[derive(Debug, Clone)]
struct LocalRecallHit {
    slot_id: u32,
    layer: u8,
    score: f64,
    text: String,
}

fn display_local_memory_record(raw: &str) -> Option<String> {
    let Ok(record) = serde_json::from_str::<Value>(raw) else {
        return Some(raw.to_owned());
    };
    let Some(object) = record.as_object() else {
        return Some(raw.to_owned());
    };
    // Only ICARUS's structured-memory envelopes have an id. Evidence documents may themselves
    // be JSON, so do not reinterpret arbitrary JSON as a memory record.
    if !object.get("id").is_some_and(Value::is_string) {
        return Some(raw.to_owned());
    }
    if object
        .get("is_latest")
        .and_then(Value::as_bool)
        .is_some_and(|latest| !latest)
    {
        return None;
    }
    let content = object
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let title = object
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let display = if title.is_empty() {
        content.to_owned()
    } else if content.is_empty() {
        title.to_owned()
    } else {
        format!("{title}\n{content}")
    };
    (!display.trim().is_empty()).then_some(display)
}

/// Full-corpus, deterministic lexical retrieval over the repository-local AMR shard. This is a
/// data-source adapter, not an LLM or JS-side heuristic: it reads only committed slots while a
/// shared lock is held and uses the engine's native BM25 implementation for ranking.
fn local_memory_recall(
    root: &Path,
    query: &str,
    top_k: usize,
) -> std::result::Result<Vec<LocalRecallHit>, String> {
    let org = repo_local_org(root);
    let shard_dir = root.join(".icarus/data").join(&org);
    let shard_file = shard_dir.join("shard.amr");
    let lock_file = shard_dir.join("shard.lock");
    if !shard_file.exists() || !lock_file.exists() {
        return Err(format!(
            "repo-local AMR shard is not initialized for org `{org}`"
        ));
    }
    let _lock = SharedShardReadLock::acquire(&lock_file)?;
    let records = mseg::read_live_texts_read_only(&shard_dir, "shard")
        .map_err(|error| format!("cannot read repo-local AMR shard: {error}"))?;
    let records: Vec<_> = records
        .into_iter()
        .filter_map(|record| {
            display_local_memory_record(&record.text)
                .map(|text| (record.slot_id, record.layer, text))
        })
        .collect();
    let documents: Vec<_> = records
        .iter()
        .enumerate()
        .map(|(id, (_, _, text))| Bm25Doc {
            id: id as u32,
            text,
        })
        .collect();
    let ranked = bm25_search(&documents, query, top_k, Bm25Params::default());
    Ok(ranked
        .into_iter()
        .filter_map(|hit| {
            let (slot_id, layer, text) = records.get(hit.id as usize)?;
            Some(LocalRecallHit {
                slot_id: *slot_id,
                layer: *layer,
                score: hit.score,
                text: text.clone(),
            })
        })
        .collect())
}

fn referenced_decisions(
    root: &Path,
    references: &[String],
) -> Vec<(String, String, String, String)> {
    let mut items = Vec::new();
    for reference in references {
        let candidates = [
            (
                root.join(".icarus/decisions")
                    .join(format!("{reference}.json")),
                "repository decision",
            ),
            (
                runtime_root(root)
                    .join("authority/decisions")
                    .join(format!("{reference}.json")),
                "cached organizational decision",
            ),
        ];
        let found = candidates.into_iter().find_map(|(path, authority)| {
            fs::read_to_string(&path)
                .ok()
                .map(|content| (path, authority, content))
        });
        match found {
            Some((path, authority, content)) => {
                let freshness = if path.starts_with(root.join(".icarus/decisions")) { "tracked_snapshot" } else { "local_cache" };
                items.push((
                    path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/"),
                    freshness.into(),
                    authority.into(),
                    content,
                ));
            }
            None => items.push((
                format!("decision:{reference}"),
                "unavailable".into(),
                "unresolved decision reference".into(),
                serde_json::to_string_pretty(&json!({"id": reference, "available": false, "reason": "no local decision snapshot or cache entry"})).unwrap_or_default(),
            )),
        }
    }
    items
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn normalized_pattern_prefix(pattern: &str) -> &str {
    pattern.split(['*', '?', '[']).next().unwrap_or(pattern)
}

fn skills_match_contract(skill: &Value, contract: &TaskContract) -> bool {
    let types = string_list(skill.get("task_types"));
    let Some(task_type) = contract.task_type.as_deref() else {
        return false;
    };
    if types.is_empty() || !types.iter().any(|kind| kind == task_type) {
        return false;
    }
    let patterns = string_list(skill.get("file_patterns"));
    !patterns.is_empty()
        && patterns.iter().any(|skill_pattern| {
            let skill_prefix = normalized_pattern_prefix(skill_pattern);
            contract.allowed_paths.iter().any(|allowed| {
                let allowed_prefix = normalized_pattern_prefix(allowed);
                skill_prefix.starts_with(allowed_prefix) || allowed_prefix.starts_with(skill_prefix)
            })
        })
}

/// Only explicitly active, verified harness procedures may enter a context pack. Persona files
/// and unverified candidates are intentionally invisible to managed execution.
fn active_verified_skills(root: &Path, contract: &TaskContract) -> Vec<(String, String)> {
    let directory = root.join(".icarus/skills");
    // `active/` is the stable v1 layout. Direct root files are preview compatibility only;
    // directories such as `retired/` are never traversed as candidates.
    let mut paths: Vec<_> = [directory.join("active"), directory]
        .into_iter()
        .filter_map(|candidate| fs::read_dir(candidate).ok())
        .flat_map(|entries| entries.filter_map(|entry| entry.ok().map(|entry| entry.path())))
        .filter(|path| path.is_file())
        .collect();
    paths.sort();
    paths
        .into_iter()
        .filter_map(|path| {
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                return None;
            }
            let content = fs::read_to_string(&path).ok()?;
            let skill: Value = serde_json::from_str(&content).ok()?;
            let active = skill.get("state").and_then(Value::as_str) == Some("active");
            let verified = skill
                .get("verification")
                .and_then(Value::as_object)
                .and_then(|verification| verification.get("status"))
                .and_then(Value::as_str)
                == Some("verified");
            if active
                && verified
                && skill_proof_is_current(&skill)
                && skills_match_contract(&skill, contract)
            {
                Some((
                    path.strip_prefix(root)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .replace('\\', "/"),
                    content,
                ))
            } else {
                None
            }
        })
        .collect()
}

/// Compile a deterministic context pack. This is intentionally extraction and ordering, not
/// summarization: ICARUS has no LLM in this path, and every included byte is source-addressable.
pub fn build_context(repo_root: &Path, task_id: &str, budget_tokens: usize) -> Result<ContextPack> {
    if budget_tokens == 0 {
        return Err(HarnessError::invalid(
            "budget_unsatisfied: context budget must be positive",
        ));
    }
    let root = canonical_root(repo_root)?;
    let task = task_status(&root, task_id)?;
    let mut pack = ContextPack {
        schema_version: 1,
        task_id: task.task_id.clone(),
        execution_id: task.execution_id.clone(),
        status: task.status.clone(),
        base_checkpoint_sequence: None,
        budget_tokens,
        upper_bound_tokens: 0,
        items: Vec::new(),
    };
    let contract = fs::read_to_string(contract_path(&root, task_id, task.contract_version)?)?;
    add_context_item(
        &mut pack,
        ContextItem::new(
            "contract",
            format!(
                ".icarus/runtime/tasks/{task_id}/contract.v{}.json",
                task.contract_version
            ),
            "snapshot",
            "task contract",
            "mandatory execution scope and acceptance criteria",
            true,
            contract,
        ),
    )?;
    let slice = graph_slice(&root, &task.objective);
    let graph_available = slice
        .get("available")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    add_context_item(
        &mut pack,
        ContextItem::new(
            "graph_slice",
            ".icarus/runtime/graph/graph.db + receipt.json",
            if graph_available {
                "current"
            } else {
                "unavailable_or_stale"
            },
            "observed code graph",
            "direct structural matches to the task objective",
            false,
            serde_json::to_string_pretty(&slice)?,
        ),
    )?;
    // Validate before including it. Context must never present malformed governance YAML as an
    // authoritative rule set to the coding agent.
    load_repository_policy(&root)?;
    let policy = fs::read_to_string(policy_path(&root))?;
    add_context_item(
        &mut pack,
        ContextItem::new(
            "policy",
            ".icarus/policies/default.yaml",
            "current",
            "repository policy",
            "mandatory governance rules",
            true,
            policy,
        ),
    )?;
    for (source, freshness, authority, content) in
        referenced_decisions(&root, &task.contract.decision_references)
    {
        add_context_item(
            &mut pack,
            ContextItem::new(
                "decision_reference",
                source,
                freshness,
                authority,
                "immutable task-linked decision reference",
                false,
                content,
            ),
        )?;
    }
    for (source, content) in active_verified_skills(&root, &task.contract) {
        add_context_item(
            &mut pack,
            ContextItem::new(
                "verified_skill",
                source,
                "verified",
                "verified harness procedure",
                "active skill matches task type and contract path scope",
                false,
                content,
            ),
        )?;
    }
    let task_state = serde_json::to_string_pretty(&json!({
        "task_id": task.task_id, "execution_id": task.execution_id, "status": task.status,
        "contract_version": task.contract_version, "contract_digest": task.contract_digest,
    }))?;
    add_context_item(
        &mut pack,
        ContextItem::new(
            "task_state",
            format!(".icarus/runtime/tasks/{task_id}/task.json"),
            "snapshot",
            "runtime state",
            "current lifecycle state",
            true,
            task_state,
        ),
    )?;
    let worktree = serde_json::to_string_pretty(&json!({
        "git_sha": git_output(&root, &["rev-parse", "HEAD"]),
        "dirty_state_fingerprint": sha256(git_output(&root, &["status", "--porcelain=v1"]).unwrap_or_default().as_bytes()),
        "graph": graph_freshness(&root),
    }))?;
    add_context_item(
        &mut pack,
        ContextItem::new(
            "worktree",
            "git + runtime graph receipt",
            "current",
            "observed workspace",
            "freshness and divergence check",
            true,
            worktree,
        ),
    )?;
    if let Some(checkpoint) = read_checkpoints(&root, task_id)?.last() {
        let content = serde_json::to_string_pretty(checkpoint)?;
        add_context_item(
            &mut pack,
            ContextItem::new(
                "checkpoint",
                format!(
                    ".icarus/runtime/tasks/{task_id}/checkpoints.jsonl#{}",
                    checkpoint.sequence
                ),
                "checkpoint",
                "agent checkpoint",
                "latest agent-supplied risks and next action",
                false,
                content,
            ),
        )?;
    }
    // A resume must see actual failed evidence and outstanding risk, rather than infer either
    // from a broad event log or an agent's recollection. Passing receipts are not repeated here;
    // only unresolved/failed material consumes optional context budget.
    let failed_receipts: Vec<_> = read_verification_receipts(&root, task_id)?
        .into_iter()
        .filter(|receipt| receipt.status != "pass")
        .collect();
    if !failed_receipts.is_empty() {
        add_context_item(
            &mut pack,
            ContextItem::new(
                "failed_criteria",
                format!(".icarus/runtime/evidence/{task_id}/commands.jsonl"),
                "current",
                "ICARUS verifier",
                "prior failed or pending contract evidence requiring resolution",
                false,
                serde_json::to_string_pretty(&failed_receipts)?,
            ),
        )?;
    }
    let unresolved_risks: Vec<_> = read_checkpoints(&root, task_id)?
        .into_iter()
        .filter(|checkpoint| {
            checkpoint
                .open_risks
                .as_array()
                .is_some_and(|risks| !risks.is_empty())
        })
        .map(|checkpoint| {
            json!({
                "sequence": checkpoint.sequence,
                "phase": checkpoint.phase,
                "open_risks": checkpoint.open_risks,
                "next_valid_action": checkpoint.next_valid_action,
            })
        })
        .collect();
    if !unresolved_risks.is_empty() {
        add_context_item(
            &mut pack,
            ContextItem::new(
                "unresolved_risks",
                format!(".icarus/runtime/tasks/{task_id}/checkpoints.jsonl"),
                "checkpoint",
                "agent checkpoint",
                "unresolved risks carried forward from prior checkpoints",
                false,
                serde_json::to_string_pretty(&unresolved_risks)?,
            ),
        )?;
    }
    // Retrieval remains strictly repository-local. The harness reads the AMR durable snapshot
    // itself; it does not call a model, a remote recall API, or a JavaScript ranking shim.
    let local_org = repo_local_org(&root);
    match local_memory_recall(&root, &task.objective, 8) {
        Ok(hits) if hits.is_empty() => add_context_item(
            &mut pack,
            ContextItem::new(
                "local_memory_recall",
                format!(".icarus/data/{local_org}/shard.amr"),
                "committed snapshot",
                "repository-local AMR shard",
                "full-corpus BM25 retrieval from the task objective returned no matching records",
                false,
                "no matching committed local memory or evidence records".into(),
            ),
        )?,
        Ok(hits) => {
            for (rank, hit) in hits.into_iter().enumerate() {
                let layer = match hit.layer {
                    0 => "memory",
                    1 => "evidence",
                    2 => "cognitive",
                    _ => "other",
                };
                add_context_item(
                    &mut pack,
                    ContextItem::new(
                        "local_memory_evidence",
                        format!(".icarus/data/{local_org}/shard.amr#slot-{}", hit.slot_id),
                        "committed snapshot",
                        format!("repository-local AMR {layer}"),
                        format!(
                            "full-corpus BM25 retrieval from the task objective; rank {} with score {:.6}",
                            rank + 1,
                            hit.score
                        ),
                        false,
                        hit.text,
                    ),
                )?;
            }
        }
        Err(reason) => add_context_item(
            &mut pack,
            ContextItem::new(
                "local_memory_recall",
                format!(".icarus/data/{local_org}/shard.amr"),
                "unavailable",
                "repository-local AMR shard",
                "local memory/evidence retrieval was not available; no global or remote fallback is used",
                false,
                reason,
            ),
        )?,
    }
    let event_chain = verify_event_chain(&root, &load_manifest(&root)?.repo_id)?;
    let content = serde_json::to_string_pretty(
        &json!({"valid": event_chain.valid, "events": event_chain.events, "issues": event_chain.issues}),
    )?;
    add_context_item(
        &mut pack,
        ContextItem::new(
            "event_integrity",
            ".icarus/runtime/logs/events.jsonl",
            "current",
            "runtime audit log",
            "integrity status for the task history",
            false,
            content,
        ),
    )?;
    Ok(pack)
}

/// Produce the compact continuation pack for an agent that already consumed the full pack at a
/// checkpoint. Immutable contract/policy content is referenced by digest rather than repeated;
/// changed lifecycle and workspace evidence is included verbatim.
pub fn build_context_delta(
    repo_root: &Path,
    task_id: &str,
    checkpoint_sequence: u64,
    budget_tokens: usize,
) -> Result<ContextPack> {
    if budget_tokens == 0 {
        return Err(HarnessError::invalid(
            "budget_unsatisfied: context budget must be positive",
        ));
    }
    let root = canonical_root(repo_root)?;
    let task = task_status(&root, task_id)?;
    let checkpoints = read_checkpoints(&root, task_id)?;
    let base = checkpoints
        .iter()
        .find(|checkpoint| checkpoint.sequence == checkpoint_sequence)
        .ok_or_else(|| {
            HarnessError::invalid(format!(
                "checkpoint {checkpoint_sequence} does not exist for task `{task_id}`"
            ))
        })?;
    let manifest = load_manifest(&root)?;
    let events = read_events(&root)?;
    let base_event_sequence = events
        .iter()
        .find(|event| {
            event.task_id == task_id
                && event.event_type == "checkpoint"
                && event
                    .payload
                    .get("checkpoint_sequence")
                    .and_then(Value::as_u64)
                    == Some(checkpoint_sequence)
        })
        .map(|event| event.sequence)
        .ok_or_else(|| HarnessError::invalid("checkpoint has no durable lifecycle event"))?;
    let lifecycle: Vec<_> = events
        .iter()
        .filter(|event| event.task_id == task_id && event.sequence > base_event_sequence)
        .collect();
    let mut pack = ContextPack {
        schema_version: 1,
        task_id: task.task_id.clone(),
        execution_id: task.execution_id.clone(),
        status: task.status.clone(),
        base_checkpoint_sequence: Some(checkpoint_sequence),
        budget_tokens,
        upper_bound_tokens: 0,
        items: Vec::new(),
    };
    let contract_bytes = fs::read(contract_path(&root, task_id, task.contract_version)?)?;
    add_context_item(
        &mut pack,
        ContextItem::new(
            "contract_reference",
            format!(
                ".icarus/runtime/tasks/{task_id}/contract.v{}.json",
                task.contract_version
            ),
            "snapshot",
            "task contract",
            "unchanged immutable scope; resolve by digest from the base pack",
            true,
            format!("digest: {}", sha256(&contract_bytes)),
        ),
    )?;
    load_repository_policy(&root)?;
    let policy_bytes = fs::read(policy_path(&root))?;
    add_context_item(
        &mut pack,
        ContextItem::new(
            "policy_reference",
            ".icarus/policies/default.yaml",
            "current",
            "repository policy",
            "unchanged policy reference from the base pack",
            true,
            format!("digest: {}", sha256(&policy_bytes)),
        ),
    )?;
    for (source, freshness, authority, content) in
        referenced_decisions(&root, &task.contract.decision_references)
    {
        add_context_item(
            &mut pack,
            ContextItem::new(
                "decision_reference_delta",
                source,
                freshness,
                authority,
                "re-resolved task-linked decision reference after checkpoint",
                false,
                content,
            ),
        )?;
    }
    for (source, content) in active_verified_skills(&root, &task.contract) {
        add_context_item(
            &mut pack,
            ContextItem::new(
                "verified_skill_delta",
                source,
                "verified",
                "verified harness procedure",
                "re-evaluated active verified skill after checkpoint",
                false,
                content,
            ),
        )?;
    }
    let worktree = serde_json::to_string_pretty(&json!({
        "base_checkpoint": {"sequence": base.sequence, "git_sha": base.git_sha, "dirty_state_fingerprint": base.dirty_state_fingerprint},
        "current": {"git_sha": git_output(&root, &["rev-parse", "HEAD"]), "dirty_state_fingerprint": sha256(git_output(&root, &["status", "--porcelain=v1"]).unwrap_or_default().as_bytes()), "graph": graph_freshness(&root)},
    }))?;
    add_context_item(
        &mut pack,
        ContextItem::new(
            "worktree_delta",
            "git + runtime graph receipt",
            "current",
            "observed workspace",
            "changes since the base checkpoint",
            true,
            worktree,
        ),
    )?;
    let lifecycle_content = serde_json::to_string_pretty(&lifecycle)?;
    add_context_item(
        &mut pack,
        ContextItem::new(
            "lifecycle_delta",
            ".icarus/runtime/logs/events.jsonl",
            "current",
            "runtime audit log",
            "task events after the base checkpoint",
            false,
            lifecycle_content,
        ),
    )?;
    let later_checkpoints: Vec<_> = checkpoints
        .into_iter()
        .filter(|checkpoint| checkpoint.sequence > checkpoint_sequence)
        .collect();
    if !later_checkpoints.is_empty() {
        add_context_item(
            &mut pack,
            ContextItem::new(
                "checkpoint_delta",
                format!(".icarus/runtime/tasks/{task_id}/checkpoints.jsonl"),
                "checkpoint",
                "agent checkpoint",
                "agent checkpoint(s) after the base",
                false,
                serde_json::to_string_pretty(&later_checkpoints)?,
            ),
        )?;
    }
    let chain = verify_event_chain(&root, &manifest.repo_id)?;
    add_context_item(
        &mut pack,
        ContextItem::new(
            "event_integrity",
            ".icarus/runtime/logs/events.jsonl",
            "current",
            "runtime audit log",
            "integrity status for the continuation",
            false,
            serde_json::to_string_pretty(
                &json!({"valid": chain.valid, "events": chain.events, "issues": chain.issues}),
            )?,
        ),
    )?;
    Ok(pack)
}

impl ContextItem {
    fn new(
        kind: impl Into<String>,
        source: impl Into<String>,
        freshness: impl Into<String>,
        authority: impl Into<String>,
        retrieval_reason: impl Into<String>,
        mandatory: bool,
        content: String,
    ) -> Self {
        let digest = sha256(content.as_bytes());
        Self {
            kind: kind.into(),
            source: source.into(),
            digest,
            freshness: freshness.into(),
            authority: authority.into(),
            retrieval_reason: retrieval_reason.into(),
            mandatory,
            content,
        }
    }
}

fn add_context_item(pack: &mut ContextPack, item: ContextItem) -> Result<()> {
    pack.items.push(item);
    // Header includes the bound itself, so converge once or twice before deciding whether the
    // rendered pack fits. (A digit boundary can change the rendered byte count.)
    let mut upper_bound = render_context_markdown(pack).len();
    for _ in 0..2 {
        pack.upper_bound_tokens = upper_bound;
        upper_bound = render_context_markdown(pack).len();
    }
    if upper_bound > pack.budget_tokens {
        let rejected = pack.items.pop().expect("the item was just added");
        if rejected.mandatory {
            return Err(HarnessError::invalid(format!("budget_unsatisfied: mandatory {} item requires at least {} conservative token units", rejected.kind, upper_bound)));
        }
        return Ok(());
    }
    pack.upper_bound_tokens = upper_bound;
    Ok(())
}

pub fn render_context_markdown(pack: &ContextPack) -> String {
    let mut rendered = format!("# ICARUS context pack\n\ntask: `{}` · execution: `{}` · status: `{}`\nbudget upper bound: {}/{}\n", pack.task_id, pack.execution_id, pack.status, pack.upper_bound_tokens, pack.budget_tokens);
    for (index, item) in pack.items.iter().enumerate() {
        rendered.push_str(&format!("\n## {}. {}{}\nsource: `{}`\ndigest: `{}`\nfreshness: {} · authority: {}\nreason: {}\n\n```text\n{}\n```\n", index + 1, item.kind, if item.mandatory { " (mandatory)" } else { "" }, item.source, item.digest, item.freshness, item.authority, item.retrieval_reason, item.content));
    }
    rendered
}

pub fn authorize_action(repo_root: &Path, task_id: &str, action: Action) -> Result<Authorization> {
    let root = canonical_root(repo_root)?;
    let task = task_status(&root, task_id)?;
    if action.kind != "write" {
        return Ok(Authorization {
            allowed: true,
            reason: "non-write action is delegated to the agent policy".into(),
        });
    }
    if task.status != "executing" {
        return Ok(Authorization {
            allowed: false,
            reason: "managed writes require an executing task contract".into(),
        });
    }
    let Some(path) = action.path else {
        return Ok(Authorization {
            allowed: false,
            reason: "write action requires a repository-relative path".into(),
        });
    };
    let candidate = Path::new(&path);
    if candidate.is_absolute()
        || candidate.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Ok(Authorization {
            allowed: false,
            reason: "write path must be repository-relative".into(),
        });
    }
    let denied = build_globset(&task.contract.forbidden_paths)?.is_match(&path);
    if denied {
        return Ok(Authorization {
            allowed: false,
            reason: "write path is forbidden by the task contract".into(),
        });
    }
    if !build_globset(&task.contract.allowed_paths)?.is_match(&path) {
        return Ok(Authorization {
            allowed: false,
            reason: "write path is outside the declared task contract".into(),
        });
    }
    Ok(Authorization {
        allowed: true,
        reason: "write is authorized by the executing task contract".into(),
    })
}

fn codex_session_path(task_id: &str) -> String {
    format!("state/codex-app-server-{task_id}.json")
}

fn codex_required_string<'a>(params: &'a Value, field: &str) -> Result<&'a str> {
    params
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            HarnessError::invalid(format!("Codex app-server event requires non-empty {field}"))
        })
}

fn codex_notification_thread_id(params: &Value) -> Result<&str> {
    params
        .get("threadId")
        .and_then(Value::as_str)
        .or_else(|| {
            params
                .get("thread")
                .and_then(|thread| thread.get("id"))
                .and_then(Value::as_str)
        })
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            HarnessError::invalid("Codex app-server notification requires non-empty thread id")
        })
}

fn codex_optional_identifier(params: &Value, direct: &str, nested: &str) -> Option<String> {
    params
        .get(direct)
        .and_then(Value::as_str)
        .or_else(|| {
            params
                .get(nested)
                .and_then(|value| value.get("id"))
                .and_then(Value::as_str)
        })
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
}

fn prepared_codex_run(root: &Path, task_id: &str) -> Result<(TaskRecord, RunPreparation)> {
    let task = task_status(root, task_id)?;
    if task.status != "executing" {
        return Err(HarnessError::invalid(
            "Codex app-server events require an executing task",
        ));
    }
    let run_value = read_snapshot(root, &format!("state/run-{}.json", task.task_id))?
        .ok_or_else(|| HarnessError::invalid("managed run preparation is missing"))?;
    let run: RunPreparation = serde_json::from_value(run_value)?;
    if run.task_id != task.task_id || run.execution_id != task.execution_id || run.agent != "codex"
    {
        return Err(HarnessError::invalid(
            "Codex app-server event does not match the prepared Codex execution",
        ));
    }
    Ok((task, run))
}

/// Return the already-prepared Codex execution selected by Rust. The app-server bridge uses this
/// instead of accepting a caller-supplied working directory, so an isolated task cannot be
/// redirected to the parent checkout by its transport process.
pub fn codex_app_server_run(repo_root: &Path, task_id: &str) -> Result<RunPreparation> {
    let root = canonical_root(repo_root)?;
    Ok(prepared_codex_run(&root, task_id)?.1)
}

fn load_bound_codex_session(
    root: &Path,
    task_id: &str,
    thread_id: &str,
) -> Result<CodexAppServerSession> {
    let session_value = read_snapshot(root, &codex_session_path(task_id))?
        .ok_or_else(|| HarnessError::invalid("Codex app-server thread has not been bound"))?;
    let session: CodexAppServerSession = serde_json::from_value(session_value)?;
    if session.task_id != task_id || session.agent != "codex" || session.thread_id != thread_id {
        return Err(HarnessError::invalid(
            "Codex app-server event thread does not match the governed execution",
        ));
    }
    Ok(session)
}

fn codex_file_change_paths(params: &Value) -> Result<Option<(String, Vec<String>)>> {
    let Some(item) = params.get("item").and_then(Value::as_object) else {
        return Ok(None);
    };
    if item.get("type").and_then(Value::as_str) != Some("fileChange") {
        return Ok(None);
    }
    let item_id = item
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| HarnessError::invalid("Codex file-change item requires an id"))?
        .to_owned();
    let changes = item
        .get("changes")
        .and_then(Value::as_array)
        .ok_or_else(|| HarnessError::invalid("Codex file-change item requires changes"))?;
    if changes.is_empty() {
        return Err(HarnessError::invalid(
            "Codex file-change item must name at least one path",
        ));
    }
    let mut paths = BTreeSet::new();
    for change in changes {
        let path = change
            .get("path")
            .and_then(Value::as_str)
            .filter(|path| !path.trim().is_empty())
            .ok_or_else(|| HarnessError::invalid("Codex file-change item has a pathless change"))?;
        let normalized = checked_repo_relative_path(path)?
            .to_string_lossy()
            .replace('\\', "/");
        paths.insert(normalized);
    }
    Ok(Some((item_id, paths.into_iter().collect())))
}

fn persist_codex_session(
    root: &Path,
    task_id: &str,
    session: &CodexAppServerSession,
) -> Result<()> {
    write_snapshot(
        root,
        &codex_session_path(task_id),
        serde_json::to_value(session)?,
    )
}

/// Bind the thread returned by Codex's documented `thread/start` response to the active Rust
/// execution. A second, different thread is never allowed to overwrite the original binding.
pub fn bind_codex_app_server_thread(
    repo_root: &Path,
    task_id: &str,
    thread_id: &str,
) -> Result<CodexAppServerSession> {
    if thread_id.trim().is_empty() || thread_id.contains(['\n', '\r', '\0']) {
        return Err(HarnessError::invalid("invalid Codex app-server thread id"));
    }
    let root = canonical_root(repo_root)?;
    let (task, run) = prepared_codex_run(&root, task_id)?;
    let path = codex_session_path(&task.task_id);
    if let Some(existing) = read_snapshot(&root, &path)? {
        let session: CodexAppServerSession = serde_json::from_value(existing)?;
        if session.task_id == task.task_id
            && session.execution_id == task.execution_id
            && session.agent == "codex"
            && session.thread_id == thread_id
        {
            return Ok(session);
        }
        return Err(HarnessError::invalid(
            "a different Codex app-server thread is already bound to this execution",
        ));
    }
    let session = CodexAppServerSession {
        schema_version: 1,
        task_id: task.task_id.clone(),
        execution_id: task.execution_id.clone(),
        agent: "codex".into(),
        thread_id: thread_id.into(),
        worktree_id: run.worktree_id.clone(),
        pending_file_changes: BTreeMap::new(),
        approved_file_changes: BTreeMap::new(),
    };
    write_snapshot(&root, &path, serde_json::to_value(&session)?)?;
    append_event(
        &root,
        EventInput {
            execution_id: task.execution_id,
            task_id: task.task_id,
            event_type: "codex_app_server_thread_bound".into(),
            worktree_id: run.worktree_id,
            timestamp: None,
            payload: json!({
                "schema_version": 1,
                "agent": "codex",
                "thread_id": thread_id,
            }),
        },
    )?;
    Ok(session)
}

/// Record a bounded set of documented Codex app-server notifications. The native core validates
/// the persisted thread binding and identifiers before appending an event; callers cannot use a
/// formatted model transcript as evidence or inject an arbitrary event type.
pub fn record_codex_app_server_event(
    repo_root: &Path,
    task_id: &str,
    method: &str,
    params: &Value,
) -> Result<CodexAppServerEventReceipt> {
    let allowed = [
        "thread/started",
        "turn/started",
        "item/started",
        "item/completed",
        "turn/completed",
    ];
    if !allowed.contains(&method) {
        return Err(HarnessError::invalid(
            "unsupported Codex app-server notification",
        ));
    }
    let root = canonical_root(repo_root)?;
    let (task, run) = prepared_codex_run(&root, task_id)?;
    let thread_id = codex_notification_thread_id(params)?;
    let mut session = load_bound_codex_session(&root, task_id, thread_id)?;
    if session.execution_id != task.execution_id || session.worktree_id != run.worktree_id {
        return Err(HarnessError::invalid(
            "Codex app-server session does not match the active execution",
        ));
    }
    let turn_id = codex_optional_identifier(params, "turnId", "turn");
    let item_id = codex_optional_identifier(params, "itemId", "item");
    if matches!(method, "turn/started" | "item/started" | "item/completed") && turn_id.is_none() {
        return Err(HarnessError::invalid(
            "Codex app-server notification requires turnId",
        ));
    }
    if matches!(method, "item/started" | "item/completed") && item_id.is_none() {
        return Err(HarnessError::invalid(
            "Codex app-server item notification requires item id",
        ));
    }
    let file_change_paths = codex_file_change_paths(params)?;
    if method == "item/started" {
        if let Some((file_change_id, paths)) = file_change_paths.clone() {
            if item_id.as_deref() != Some(file_change_id.as_str()) {
                return Err(HarnessError::invalid(
                    "Codex file-change item id does not match the notification item",
                ));
            }
            for path in &paths {
                validate_managed_workspace_path(Path::new(&run.workspace_path), path)?;
            }
            session.pending_file_changes.insert(file_change_id, paths);
            persist_codex_session(&root, task_id, &session)?;
        }
    }
    if method == "item/completed" {
        if let Some((file_change_id, paths)) = file_change_paths.clone() {
            if item_id.as_deref() != Some(file_change_id.as_str()) {
                return Err(HarnessError::invalid(
                    "Codex completed file-change item id does not match the notification item",
                ));
            }
            let approved = session
                .approved_file_changes
                .remove(&file_change_id)
                .ok_or_else(|| {
                    HarnessError::invalid(
                        "Codex completed a file change without a matching ICARUS approval",
                    )
                })?;
            if approved != paths {
                return Err(HarnessError::invalid(
                    "Codex completed file-change paths differ from the approved path set",
                ));
            }
            for path in &paths {
                validate_managed_workspace_path(Path::new(&run.workspace_path), path)?;
            }
            persist_codex_session(&root, task_id, &session)?;
        }
    }
    let event = append_event(
        &root,
        EventInput {
            execution_id: task.execution_id.clone(),
            task_id: task.task_id.clone(),
            event_type: format!("codex_app_server_{}", method.replace('/', "_")),
            worktree_id: run.worktree_id,
            timestamp: None,
            payload: json!({
                "schema_version": 1,
                "agent": "codex",
                "thread_id": thread_id,
                "turn_id": turn_id,
                "item_id": item_id,
                "method": method,
                "file_change_paths": file_change_paths.map(|(_, paths)| paths),
            }),
        },
    )?;
    Ok(CodexAppServerEventReceipt {
        schema_version: 1,
        task_id: task.task_id,
        execution_id: task.execution_id,
        thread_id: thread_id.into(),
        turn_id,
        item_id,
        method: method.into(),
        event_sequence: event.sequence,
    })
}

/// Decide a Codex app-server approval request in the Rust authority.
///
/// A direct Codex file-change request does not itself contain paths. ICARUS accepts one only
/// after the matching structured `item/started` file-change event supplied canonical paths, and
/// only if every path satisfies the Rust task contract. Command and permission requests remain
/// fail-closed because their display data is not an independently validated action description.
pub fn decide_codex_app_server_approval(
    repo_root: &Path,
    task_id: &str,
    method: &str,
    params: &Value,
) -> Result<CodexAppServerApproval> {
    let allowed = [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
    ];
    if !allowed.contains(&method) {
        return Err(HarnessError::invalid(
            "unsupported Codex app-server approval request",
        ));
    }
    let root = canonical_root(repo_root)?;
    let (task, run) = prepared_codex_run(&root, task_id)?;
    let thread_id = codex_required_string(params, "threadId")?;
    let turn_id = codex_required_string(params, "turnId")?;
    let item_id = codex_required_string(params, "itemId")?;
    let mut session = load_bound_codex_session(&root, task_id, thread_id)?;
    if session.execution_id != task.execution_id || session.worktree_id != run.worktree_id {
        return Err(HarnessError::invalid(
            "Codex app-server approval request does not match the active execution",
        ));
    }
    let (decision, reason) = match method {
        "item/fileChange/requestApproval" => {
            let decision = match session.pending_file_changes.remove(item_id) {
                None => (
                    "decline",
                    "ICARUS declined: Codex did not provide a prior structured file-change item with canonical paths.".into(),
                ),
                Some(paths) => {
                    let mut denied_reason = None;
                    for path in &paths {
                        validate_managed_workspace_path(Path::new(&run.workspace_path), path)?;
                        let authorization =
                            authorize_action(&root, &task.task_id, Action::write(path.clone()))?;
                        if !authorization.allowed {
                            denied_reason =
                                Some(format!("ICARUS declined `{path}`: {}", authorization.reason));
                            break;
                        }
                    }
                    match denied_reason {
                        Some(reason) => ("decline", reason),
                        None => {
                            session.approved_file_changes.insert(item_id.into(), paths);
                            (
                                "accept",
                                "ICARUS authorized every canonical file path in the structured change item."
                                    .into(),
                            )
                        }
                    }
                }
            };
            persist_codex_session(&root, task_id, &session)?;
            decision
        }
        "item/commandExecution/requestApproval" => ("decline", "ICARUS declined: command approval requires a native, independently validated command policy.".into()),
        "item/permissions/requestApproval" => ("decline", "ICARUS declined: additional sandbox or network permissions require explicit task-contract support.".into()),
        _ => unreachable!(),
    };
    let event = append_event(
        &root,
        EventInput {
            execution_id: task.execution_id.clone(),
            task_id: task.task_id.clone(),
            event_type: if decision == "accept" {
                "codex_app_server_approval_authorized".into()
            } else {
                "codex_app_server_approval_declined".into()
            },
            worktree_id: run.worktree_id,
            timestamp: None,
            payload: json!({
                "schema_version": 1,
                "agent": "codex",
                "thread_id": thread_id,
                "turn_id": turn_id,
                "item_id": item_id,
                "method": method,
                "decision": decision,
                "reason": reason,
            }),
        },
    )?;
    Ok(CodexAppServerApproval {
        schema_version: 1,
        task_id: task.task_id,
        execution_id: task.execution_id,
        thread_id: thread_id.into(),
        method: method.into(),
        decision: decision.into(),
        reason,
        event_sequence: event.sequence,
    })
}

/// Authorize a Claude Edit/Write hook and bind that decision to the task's append-only audit
/// chain. Unlike the generic MCP-facing `authorize_action` helper, this requires the exact
/// prepared Claude execution, accepts only the documented write tools, and records denials as
/// well as approvals. Failure to create the event is a failure to authorize.
pub fn authorize_adapter_write(
    repo_root: &Path,
    task_id: &str,
    agent: &str,
    tool_name: &str,
    path: &str,
) -> Result<AdapterAuthorizationReceipt> {
    if agent != "claude" || !matches!(tool_name, "Edit" | "Write") {
        return Err(HarnessError::invalid(
            "adapter write authorization only supports Claude Edit or Write hooks",
        ));
    }
    let root = canonical_root(repo_root)?;
    let task = task_status(&root, task_id)?;
    if task.status != "executing" {
        return Err(HarnessError::invalid(
            "adapter write authorization requires an executing task",
        ));
    }
    let run_value = read_snapshot(&root, &format!("state/run-{}.json", task.task_id))?
        .ok_or_else(|| HarnessError::invalid("managed run preparation is missing"))?;
    let run: RunPreparation = serde_json::from_value(run_value)?;
    if run.task_id != task.task_id || run.execution_id != task.execution_id || run.agent != agent {
        return Err(HarnessError::invalid(
            "adapter write authorization does not match the prepared execution",
        ));
    }
    validate_managed_workspace_path(Path::new(&run.workspace_path), path)?;
    let authorization = authorize_action(
        &root,
        &task.task_id,
        Action {
            kind: "write".into(),
            path: Some(path.into()),
        },
    )?;
    let event = append_event(
        &root,
        EventInput {
            execution_id: task.execution_id.clone(),
            task_id: task.task_id.clone(),
            event_type: if authorization.allowed {
                "adapter_pre_action_authorized".into()
            } else {
                "adapter_pre_action_denied".into()
            },
            worktree_id: run.worktree_id.clone(),
            timestamp: None,
            payload: json!({
                "schema_version": 1,
                "observation": "hook_pre_action",
                "agent": agent,
                "tool_name": tool_name,
                "path": path,
                "allowed": authorization.allowed,
                "reason": authorization.reason.clone(),
            }),
        },
    )?;
    let denial_id = if authorization.allowed {
        None
    } else {
        let denial_id = format!("DENIAL-{}-{:020}", &task.task_id[5..], event.sequence);
        let denial = PolicyDenial {
            schema_version: 1,
            denial_id: denial_id.clone(),
            task_id: task.task_id.clone(),
            execution_id: task.execution_id.clone(),
            agent: agent.into(),
            tool_name: tool_name.into(),
            path: path.into(),
            reason: authorization.reason.clone(),
            event_sequence: event.sequence,
        };
        let denial_path = denial_path(&root, &denial_id)?;
        atomic_write(&denial_path, serde_json::to_vec_pretty(&denial)?.as_slice())?;
        Some(denial_id)
    };
    Ok(AdapterAuthorizationReceipt {
        schema_version: 1,
        task_id: task.task_id,
        execution_id: task.execution_id,
        agent: agent.into(),
        tool_name: tool_name.into(),
        path: path.into(),
        allowed: authorization.allowed,
        reason: authorization.reason,
        denial_id,
        event_sequence: event.sequence,
    })
}

/// Capture the completion of a Claude Edit/Write tool invocation. The path is revalidated in
/// Rust because post-action hooks are still untrusted process input; this receipt never turns a
/// successful tool call into a verification or seal claim.
pub fn record_adapter_post_action(
    repo_root: &Path,
    task_id: &str,
    agent: &str,
    tool_name: &str,
    path: &str,
) -> Result<AdapterPostActionReceipt> {
    if agent != "claude" || !matches!(tool_name, "Edit" | "Write") {
        return Err(HarnessError::invalid(
            "adapter post-action capture only supports Claude Edit or Write hooks",
        ));
    }
    let root = canonical_root(repo_root)?;
    let task = task_status(&root, task_id)?;
    if task.status != "executing" {
        return Err(HarnessError::invalid(
            "adapter post-action capture requires an executing task",
        ));
    }
    let run_value = read_snapshot(&root, &format!("state/run-{}.json", task.task_id))?
        .ok_or_else(|| HarnessError::invalid("managed run preparation is missing"))?;
    let run: RunPreparation = serde_json::from_value(run_value)?;
    if run.task_id != task.task_id || run.execution_id != task.execution_id || run.agent != agent {
        return Err(HarnessError::invalid(
            "adapter post-action capture does not match the prepared execution",
        ));
    }
    validate_managed_workspace_path(Path::new(&run.workspace_path), path)?;
    let event = append_event(
        &root,
        EventInput {
            execution_id: task.execution_id.clone(),
            task_id: task.task_id.clone(),
            event_type: "adapter_post_action_observed".into(),
            worktree_id: run.worktree_id,
            timestamp: None,
            payload: json!({
                "schema_version": 1,
                "observation": "hook_post_action",
                "agent": agent,
                "tool_name": tool_name,
                "path": path,
            }),
        },
    )?;
    Ok(AdapterPostActionReceipt {
        schema_version: 1,
        task_id: task.task_id,
        execution_id: task.execution_id,
        agent: agent.into(),
        tool_name: tool_name.into(),
        path: path.into(),
        event_sequence: event.sequence,
    })
}

fn managed_run_deadline_expired(run: &RunPreparation) -> Result<bool> {
    let Some(deadline) = run.wall_time_deadline.as_deref() else {
        return Ok(false);
    };
    let deadline =
        time::OffsetDateTime::parse(deadline, &time::format_description::well_known::Rfc3339)
            .map_err(|_| {
                HarnessError::invalid("managed run has an invalid Rust-owned wall-time deadline")
            })?;
    Ok(time::OffsetDateTime::now_utc() >= deadline)
}

/// Move one prepared managed execution into verification. This is an explicit handoff, not a
/// completion claim: it is intentionally unavailable before execution and it never seals a
/// task. Adapters that can intercept a conversational stop may use it as the only route that
/// permits the session to end cleanly.
pub fn handoff_managed_task(repo_root: &Path, task_id: &str) -> Result<ManagedTaskHandoffReceipt> {
    let root = canonical_root(repo_root)?;
    let task = task_status(&root, task_id)?;
    if task.status != "executing" {
        return Err(HarnessError::invalid(
            "managed task handoff requires an executing task",
        ));
    }
    let run_value = read_snapshot(&root, &format!("state/run-{}.json", task.task_id))?
        .ok_or_else(|| HarnessError::invalid("managed run preparation is missing"))?;
    let run: RunPreparation = serde_json::from_value(run_value)?;
    if run.task_id != task.task_id || run.execution_id != task.execution_id {
        return Err(HarnessError::invalid(
            "managed task handoff does not match the prepared execution",
        ));
    }
    if managed_run_deadline_expired(&run)? {
        return Err(HarnessError::invalid(
            "managed task wall-time budget expired; block or resume under a newly prepared execution",
        ));
    }
    let transitioned = transition_task(&root, task_id, "verifying")?;
    let event = append_event(
        &root,
        EventInput {
            execution_id: transitioned.execution_id.clone(),
            task_id: transitioned.task_id.clone(),
            event_type: "managed_task_handed_off".into(),
            worktree_id: run.worktree_id.clone(),
            timestamp: None,
            payload: json!({
                "schema_version": 1,
                "observation": "agent_requested_verification",
                "agent": run.agent.clone(),
                "from": "executing",
                "to": "verifying",
            }),
        },
    )?;
    Ok(ManagedTaskHandoffReceipt {
        schema_version: 1,
        task_id: transitioned.task_id,
        execution_id: transitioned.execution_id,
        agent: run.agent,
        worktree_id: run.worktree_id,
        status: transitioned.status,
        event_sequence: event.sequence,
    })
}

/// Record an adapter process lifecycle fact observed by the managed launcher.
///
/// This is intentionally narrow. Session start/end prove launcher-observed local process
/// boundaries; a stop observation proves only that the configured hook fired. None grants an
/// adapter full completion interception or automatic sealing capability.
pub fn record_adapter_lifecycle(
    repo_root: &Path,
    task_id: &str,
    event_type: &str,
    exit_code: Option<i32>,
) -> Result<AdapterLifecycleReceipt> {
    if !matches!(
        event_type,
        "adapter_session_started" | "adapter_session_ended" | "adapter_stop_observed"
    ) {
        return Err(HarnessError::invalid(
            "adapter lifecycle event must be adapter_session_started, adapter_session_ended, or adapter_stop_observed",
        ));
    }
    if matches!(
        event_type,
        "adapter_session_started" | "adapter_stop_observed"
    ) && exit_code.is_some()
    {
        return Err(HarnessError::invalid(
            "adapter_session_started and adapter_stop_observed cannot contain an exit code",
        ));
    }
    let root = canonical_root(repo_root)?;
    let task = task_status(&root, task_id)?;
    let allowed_status = match event_type {
        "adapter_session_started" => task.status == "executing",
        "adapter_session_ended" | "adapter_stop_observed" => {
            matches!(task.status.as_str(), "executing" | "verifying")
        }
        _ => false,
    };
    if !allowed_status {
        return Err(HarnessError::invalid(
            "adapter lifecycle receipt is not valid for the active task state",
        ));
    }
    let run_value = read_snapshot(&root, &format!("state/run-{}.json", task.task_id))?
        .ok_or_else(|| HarnessError::invalid("managed run preparation is missing"))?;
    let run: RunPreparation = serde_json::from_value(run_value)?;
    if run.task_id != task.task_id || run.execution_id != task.execution_id {
        return Err(HarnessError::invalid(
            "managed run preparation does not match the active task execution",
        ));
    }
    if event_type == "adapter_session_started" && managed_run_deadline_expired(&run)? {
        return Err(HarnessError::invalid(
            "managed task wall-time budget expired before the adapter session started",
        ));
    }
    let event = append_event(
        &root,
        EventInput {
            execution_id: task.execution_id.clone(),
            task_id: task.task_id.clone(),
            event_type: event_type.into(),
            worktree_id: run.worktree_id.clone(),
            timestamp: None,
            payload: json!({
                "schema_version": 1,
                "observation": if event_type == "adapter_stop_observed" { "hook_stop_observed" } else { "launcher_observed" },
                "agent": run.agent.clone(),
                "exit_code": exit_code,
            }),
        },
    )?;
    Ok(AdapterLifecycleReceipt {
        schema_version: 1,
        task_id: task.task_id,
        execution_id: task.execution_id,
        agent: run.agent,
        event_type: event_type.into(),
        worktree_id: run.worktree_id,
        exit_code,
        event_sequence: event.sequence,
    })
}

fn build_globset(patterns: &[String]) -> Result<globset::GlobSet> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        builder.add(Glob::new(pattern).map_err(|error| HarnessError::invalid(error.to_string()))?);
    }
    builder
        .build()
        .map_err(|error| HarnessError::invalid(error.to_string()))
}

pub fn append_event(repo_root: &Path, input: EventInput) -> Result<RuntimeEvent> {
    let root = canonical_root(repo_root)?;
    let lock = RuntimeLock::acquire(&root, "events")?;
    let result = append_event_locked(&root, input);
    drop(lock);
    result
}

fn append_event_locked(root: &Path, input: EventInput) -> Result<RuntimeEvent> {
    let manifest = load_manifest(root)?;
    recover_interrupted_event_head(root, &manifest.repo_id)?;
    let existing = read_events(root)?;
    let previous_hash = existing.last().map(|event| event.event_hash.clone());
    let mut event = RuntimeEvent {
        schema_version: 1,
        execution_id: input.execution_id,
        task_id: input.task_id,
        sequence: existing.len() as u64 + 1,
        event_type: input.event_type,
        timestamp: input.timestamp.unwrap_or_else(now_rfc3339),
        repo_id: manifest.repo_id.clone(),
        worktree_id: input.worktree_id,
        payload: input.payload,
        previous_hash,
        event_hash: String::new(),
    };
    event.event_hash = hash_event(&event)?;
    let event_path = events_path(root);
    fs::create_dir_all(event_path.parent().unwrap())?;
    let mut log = OpenOptions::new()
        .append(true)
        .create(true)
        .open(&event_path)?;
    writeln!(log, "{}", serde_json::to_string(&event)?)?;
    log.sync_all()?;
    sync_directory(event_path.parent().expect("event log has a parent"))?;
    crash_after_event_log_sync_if_requested();
    write_snapshot(
        root,
        "state/event-head.json",
        json!({"schema_version": 1, "repo_id": manifest.repo_id, "sequence": event.sequence, "event_hash": event.event_hash}),
    )?;
    Ok(event)
}

#[cfg(feature = "test-failpoints")]
fn crash_after_event_log_sync_if_requested() {
    if std::env::var("ICARUS_TEST_CRASH_POINT").ok().as_deref() == Some("event-after-log-sync") {
        // Deliberately bypass destructors, just as SIGKILL/power loss would. `exit` is used
        // rather than `abort` because macOS crash reporting can indefinitely retain an aborting
        // child during a nested test run; neither path permits the head snapshot below to run.
        std::process::exit(85);
    }
}

#[cfg(not(feature = "test-failpoints"))]
fn crash_after_event_log_sync_if_requested() {}

/// Recover the only safe interrupted-append state: the event log contains fully valid events
/// beyond the durable head. This occurs if a process is killed after append+fsync but before the
/// head snapshot is atomically replaced. Bad hashes, sequences, repository ids, or a
/// non-contiguous head remain an error for `doctor`; recovery never truncates or masks them.
fn recover_interrupted_event_head(root: &Path, expected_repo_id: &str) -> Result<()> {
    let events = read_events(root)?;
    if events.is_empty() {
        return Ok(());
    }
    let mut previous_hash = None;
    for (index, event) in events.iter().enumerate() {
        if event.repo_id != expected_repo_id
            || event.sequence != (index + 1) as u64
            || event.previous_hash != previous_hash
            || hash_event(event)? != event.event_hash
        {
            return Err(HarnessError::invalid(
                "cannot recover event head: runtime event log is not a valid contiguous chain",
            ));
        }
        previous_hash = Some(event.event_hash.clone());
    }

    let tail = events.last().expect("non-empty events has a tail");
    let head = read_snapshot(root, "state/event-head.json")?;
    let head_is_current = head.as_ref().is_some_and(|head| {
        head["repo_id"] == expected_repo_id
            && head["sequence"] == tail.sequence
            && head["event_hash"] == tail.event_hash
    });
    if head_is_current {
        return Ok(());
    }

    // A missing head can only be repaired for the first event. A stale head must point exactly
    // to the previous event: anything else may be truncation or manual replacement.
    let recoverable = match head {
        None => tail.sequence == 1,
        Some(head) => {
            let previous = events.get(events.len().saturating_sub(2));
            previous.is_some_and(|previous| {
                head["repo_id"] == expected_repo_id
                    && head["sequence"] == previous.sequence
                    && head["event_hash"] == previous.event_hash
            })
        }
    };
    if !recoverable {
        return Err(HarnessError::invalid(
            "cannot recover event head: durable head does not precede the valid log tail",
        ));
    }
    write_snapshot(
        root,
        "state/event-head.json",
        json!({"schema_version": 1, "repo_id": expected_repo_id, "sequence": tail.sequence, "event_hash": tail.event_hash}),
    )
}

fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .expect("the RFC3339 formatter supports UTC timestamps")
}

fn read_events(root: &Path) -> Result<Vec<RuntimeEvent>> {
    let path = events_path(root);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let mut text = String::new();
    File::open(path)?.read_to_string(&mut text)?;
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).map_err(HarnessError::from))
        .collect()
}

fn hash_event(event: &RuntimeEvent) -> Result<String> {
    let value = json!({
        "schema_version": event.schema_version, "execution_id": event.execution_id, "task_id": event.task_id,
        "sequence": event.sequence, "event_type": event.event_type, "timestamp": event.timestamp,
        "repo_id": event.repo_id, "worktree_id": event.worktree_id, "payload": event.payload,
        "previous_hash": event.previous_hash,
    });
    Ok(sha256(stable_json(&value)?.as_bytes()))
}

fn stable_json(value: &Value) -> Result<String> {
    match value {
        Value::Object(object) => {
            let mut entries: Vec<_> = object.iter().collect();
            entries.sort_unstable_by_key(|(key, _)| *key);
            let rendered = entries
                .into_iter()
                .map(|(key, value)| {
                    Ok(format!(
                        "{}:{}",
                        serde_json::to_string(key)?,
                        stable_json(value)?
                    ))
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(format!("{{{}}}", rendered.join(",")))
        }
        Value::Array(values) => Ok(format!(
            "[{}]",
            values
                .iter()
                .map(stable_json)
                .collect::<Result<Vec<_>>>()?
                .join(",")
        )),
        _ => Ok(serde_json::to_string(value)?),
    }
}

pub fn verify_event_chain(repo_root: &Path, expected_repo_id: &str) -> Result<ChainReport> {
    let root = canonical_root(repo_root)?;
    let path = events_path(&root);
    if !path.exists() {
        return Ok(ChainReport {
            valid: true,
            events: 0,
            issues: Vec::new(),
        });
    }
    let text = fs::read_to_string(&path)?;
    let mut issues = Vec::new();
    let mut previous_hash = None;
    let lines: Vec<_> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    for (index, line) in lines.iter().enumerate() {
        let event: RuntimeEvent = match serde_json::from_str(line) {
            Ok(event) => event,
            Err(_) => {
                issues.push(format!("event {}: invalid JSON", index + 1));
                continue;
            }
        };
        if event.repo_id != expected_repo_id {
            issues.push(format!("event {}: repo identity mismatch", index + 1));
        }
        if event.sequence != (index + 1) as u64 {
            issues.push(format!("event {}: sequence mismatch", index + 1));
        }
        if event.previous_hash != previous_hash {
            issues.push(format!("event {}: previous hash mismatch", index + 1));
        }
        match hash_event(&event) {
            Ok(hash) if hash == event.event_hash => {}
            _ => issues.push(format!("event {}: event hash mismatch", index + 1)),
        }
        previous_hash = Some(event.event_hash);
    }
    let head = read_snapshot(&root, "state/event-head.json")?;
    match (lines.last(), head) {
        (Some(line), Some(head)) => {
            let tail: RuntimeEvent = serde_json::from_str(line)?;
            if head["repo_id"] != expected_repo_id || head["sequence"] != lines.len() || head["event_hash"] != tail.event_hash {
                issues.push("event-head mismatch: runtime log was truncated or its tail no longer matches the durable snapshot".into());
            }
        }
        (Some(_), None) => issues.push("event-head mismatch: event log has no durable head snapshot".into()),
        (None, Some(_)) => issues.push("event-head mismatch: runtime log was truncated or its tail no longer matches the durable snapshot".into()),
        (None, None) => {},
    }
    Ok(ChainReport {
        valid: issues.is_empty(),
        events: lines.len(),
        issues,
    })
}

pub fn doctor(repo_root: &Path) -> Result<DoctorReport> {
    let root = canonical_root(repo_root)?;
    let manifest = match load_manifest(&root) {
        Ok(manifest) => manifest,
        Err(error) => {
            return Ok(DoctorReport {
                healthy: false,
                repo_id: None,
                checks: vec![DoctorCheck {
                    id: "manifest".into(),
                    status: "fail".into(),
                    detail: error.to_string(),
                }],
                issues: vec![error.to_string()],
            })
        }
    };
    let mut checks = vec![DoctorCheck {
        id: "manifest".into(),
        status: "pass".into(),
        detail: format!("schema v{}; {}", manifest.schema_version, manifest.repo_id),
    }];
    let policy_check = load_repository_policy(&root);
    checks.push(DoctorCheck {
        id: "policy".into(),
        status: if policy_check.is_ok() { "pass" } else { "fail" }.into(),
        detail: policy_check
            .as_ref()
            .map(|policy| format!("policy v{}", policy.policy_version))
            .unwrap_or_else(|error| error.to_string()),
    });
    let remote = remote_url(&root);
    let fingerprint_source = if remote.is_empty() {
        format!("local:{}", root.display())
    } else {
        remote
    };
    let identity_matches = manifest.repo_root == root.display().to_string()
        && manifest.git_remote_fingerprint == sha256(fingerprint_source.as_bytes())[..16];
    checks.push(DoctorCheck {
        id: "repository_identity".into(),
        status: if identity_matches { "pass" } else { "fail" }.into(),
        detail: if identity_matches {
            manifest.repo_id.clone()
        } else {
            "manifest root or git remote fingerprint differs from this workspace".into()
        },
    });
    if manifest.agents.is_empty() {
        checks.push(DoctorCheck {
            id: "adapters".into(),
            status: "warn".into(),
            detail: "no managed adapters enabled in the manifest".into(),
        });
    } else {
        for agent in &manifest.agents {
            let command = adapter_command(agent).expect("validated manifest agent");
            let available = adapter_available(agent);
            checks.push(DoctorCheck {
                id: format!("adapter:{agent}"),
                status: if available { "pass" } else { "fail" }.into(),
                detail: if available {
                    format!("{command} is available on PATH")
                } else {
                    format!(
                        "{command} is not available on PATH; managed {agent} runs cannot launch"
                    )
                },
            });
        }
    }
    let runtime = runtime_root(&root);
    let probe = runtime.join(format!(
        ".write-probe-{}",
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let writable = fs::create_dir_all(&runtime)
        .and_then(|_| fs::write(&probe, b"ok"))
        .and_then(|_| fs::remove_file(&probe));
    checks.push(DoctorCheck {
        id: "runtime_writable".into(),
        status: if writable.is_ok() { "pass" } else { "fail" }.into(),
        detail: writable
            .as_ref()
            .err()
            .map(ToString::to_string)
            .unwrap_or_else(|| runtime.display().to_string()),
    });
    let chain = verify_event_chain(&root, &manifest.repo_id)?;
    checks.push(DoctorCheck {
        id: "event_chain".into(),
        status: if chain.valid { "pass" } else { "fail" }.into(),
        detail: if chain.valid {
            format!("{} event(s) verified", chain.events)
        } else {
            chain.issues.join("; ")
        },
    });
    let stale = inspect_stale_locks(&root)?;
    checks.push(DoctorCheck {
        id: "stale_locks".into(),
        status: if stale.is_empty() { "pass" } else { "fail" }.into(),
        detail: if stale.is_empty() {
            "none".into()
        } else {
            stale.join(", ")
        },
    });
    let runtime_graph = runtime.join("graph/graph.db");
    let legacy_graph = root.join(".icarus-graph/graph.db");
    let graph_state = graph_freshness(&root);
    let graph_current = graph_state
        .get("current")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    checks.push(DoctorCheck {
        id: "graph".into(),
        status: if graph_current { "pass" } else { "warn" }.into(),
        detail: if graph_current {
            "runtime graph present and receipt is current".into()
        } else if runtime_graph.exists() {
            graph_state
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("runtime graph is stale")
                .into()
        } else if legacy_graph.exists() {
            "legacy graph present; re-run harness init to migrate".into()
        } else {
            "no graph built yet".into()
        },
    });
    checks.push(DoctorCheck {
        id: "upgrade_compatibility".into(),
        status: "pass".into(),
        detail: "harness v1".into(),
    });
    let issues: Vec<String> = checks
        .iter()
        .filter(|check| check.status == "fail")
        .map(|check| format!("{}: {}", check.id, check.detail))
        .collect();
    Ok(DoctorReport {
        healthy: issues.is_empty(),
        repo_id: Some(manifest.repo_id),
        checks,
        issues,
    })
}

fn inspect_stale_locks(root: &Path) -> Result<Vec<String>> {
    let directory = locks_dir(root);
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut stale = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() || !entry.file_name().to_string_lossy().ends_with(".lock") {
            continue;
        }
        let owner: LockOwner = match File::open(entry.path().join("owner.json"))
            .ok()
            .and_then(|file| serde_json::from_reader(file).ok())
        {
            Some(owner) => owner,
            None => {
                stale.push(entry.file_name().to_string_lossy().into_owned());
                continue;
            }
        };
        let acquired_at = UNIX_EPOCH + Duration::from_secs(owner.acquired_at_unix_seconds);
        let age = SystemTime::now().duration_since(acquired_at).ok();
        if age.is_none()
            || (age.is_some_and(|age| age > LOCK_STALE_AFTER) && !process_is_alive(owner.pid))
        {
            stale.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    Ok(stale)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LockOwner {
    pid: u32,
    acquired_at_unix_seconds: u64,
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    // `kill(pid, 0)` sends no signal; it asks the kernel whether this process is alive and
    // accessible. EPERM means it exists but belongs to another user, so it is still active.
    let result = unsafe { libc::kill(pid as i32, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn process_is_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, STILL_ACTIVE,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    if pid == 0 {
        return false;
    }

    // Query the process without granting destructive rights. Access denied is treated as live:
    // an inaccessible owner must never make its runtime lock reclaimable. Windows documents
    // ERROR_INVALID_PARAMETER specifically for a PID that no longer exists, which is safe to
    // reclaim after the independent stale-age gate has elapsed.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return unsafe { GetLastError() } != ERROR_INVALID_PARAMETER;
    }
    let mut exit_code = 0u32;
    let query_succeeded = unsafe { GetExitCodeProcess(handle, &mut exit_code) } != 0;
    let _ = unsafe { CloseHandle(handle) };
    !query_succeeded || exit_code == STILL_ACTIVE as u32
}

#[cfg(not(any(unix, windows)))]
fn process_is_alive(_pid: u32) -> bool {
    // Unsupported platforms must fail closed: this prevents deleting a lock merely because
    // liveness cannot be established natively.
    true
}

struct RuntimeLock {
    path: PathBuf,
}

impl RuntimeLock {
    fn acquire(root: &Path, name: &str) -> Result<Self> {
        let path = locks_dir(root).join(format!("{}.lock", name));
        fs::create_dir_all(path.parent().unwrap())?;
        for attempt in 0..=LOCK_CONTENTION_RETRIES {
            match fs::create_dir(&path) {
                Ok(()) => {
                    atomic_write(
                        &path.join("owner.json"),
                        format!(
                            "{{\"pid\":{},\"acquired_at_unix_seconds\":{}}}\n",
                            std::process::id(),
                            SystemTime::now()
                                .duration_since(UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_secs()
                        )
                        .as_bytes(),
                    )?;
                    return Ok(Self { path });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    // A kill after writing owner.json must not permanently wedge the runtime.
                    // Only reclaim a lock when its recorded owner is definitely dead; a missing
                    // or malformed owner remains fail-closed because another writer may still
                    // be completing lock creation.
                    if stale_lock_owner_is_dead(&path) {
                        if let Err(error) = fs::remove_dir_all(&path) {
                            if error.kind() != std::io::ErrorKind::NotFound {
                                return Err(error.into());
                            }
                        }
                        continue;
                    }
                    if attempt < LOCK_CONTENTION_RETRIES {
                        thread::sleep(LOCK_CONTENTION_DELAY);
                        continue;
                    }
                    return Err(HarnessError::invalid(format!(
                        "active runtime lock {}; run `icarus doctor` before retrying",
                        name
                    )));
                }
                Err(error) => return Err(error.into()),
            }
        }
        Err(HarnessError::invalid(format!(
            "could not reclaim stale runtime lock {name}"
        )))
    }
}

fn stale_lock_owner_is_dead(path: &Path) -> bool {
    File::open(path.join("owner.json"))
        .ok()
        .and_then(|file| serde_json::from_reader::<_, LockOwner>(file).ok())
        .is_some_and(|owner| !process_is_alive(owner.pid))
}

impl Drop for RuntimeLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
