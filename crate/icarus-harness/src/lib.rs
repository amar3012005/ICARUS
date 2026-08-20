//! ICARUS Harness durable runtime.
//!
//! This crate deliberately owns no model client, agent adapter, or network transport. It is the
//! local authority for repository identity, policy, event history, locks, and runtime snapshots.
//! Language bindings may call it, but must not reimplement these invariants.

use globset::{Glob, GlobSetBuilder};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::error::Error as StdError;
use std::fmt::{Display, Formatter};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MANIFEST_VERSION: u32 = 1;
const RUNTIME_DIR: &str = ".icarus/runtime";
const LOCK_STALE_AFTER: Duration = Duration::from_secs(15 * 60);
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

#[derive(Debug, Clone)]
pub struct InitResult {
    pub created: bool,
    pub manifest: Manifest,
    pub graph_migrated: bool,
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
    /// `certified` is reserved for adapters that have passed the complete enforcement contract.
    /// No current adapter may self-assert it from JavaScript launch code.
    pub certification: String,
    pub capabilities: AdapterCapabilities,
    /// Exact, deterministic CLI arguments selected from the task's governed workspace. Node may
    /// launch them, but may not weaken the safety posture or invent an adapter profile.
    pub launch_arguments: Vec<String>,
    pub compatibility_mode: bool,
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

fn adapter_launch_arguments(agent: &str, workspace: &Path, task_id: &str) -> Vec<String> {
    let workspace = workspace.display().to_string();
    match agent {
        // Codex's built-in sandbox is an additional boundary around the isolated worktree.
        // `on-request` keeps potentially external/elevated commands visible to the human.
        "codex" => vec![
            "--cd".into(),
            workspace,
            "--sandbox".into(),
            "workspace-write".into(),
            "--ask-for-approval".into(),
            "on-request".into(),
        ],
        // Claude Code's manual permission mode is the non-bypass posture. It is deliberately
        // not advertised as an ICARUS interception hook; MCP/context instructions remain the
        // compatibility surface until hook conformance is implemented.
        "claude" => vec![
            "--permission-mode".into(),
            "manual".into(),
            "--append-system-prompt".into(),
            format!(
                "This is governed ICARUS task {task_id}. Read the ICARUS context pack before planning; do not claim verification without ICARUS receipts."
            ),
        ],
        // Cursor/Grok are only launched from the isolated CWD at present. Their capabilities
        // remain explicit compatibility mode rather than assumed parity with the CLIs above.
        _ => Vec::new(),
    }
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
        ],
        "claude" => &[
            "--dangerously-skip-permissions",
            "--allow-dangerously-skip-permissions",
            "--permission-mode",
            "--append-system-prompt",
            "--system-prompt",
            "--add-dir",
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
            && ["-s", "-a", "-C"]
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
            &root.display().to_string(),
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
        Ok(())
    })();
    if temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    result
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

pub fn init(repo_root: &Path, options: InitOptions) -> Result<InitResult> {
    let root = canonical_root(repo_root)?;
    let manifest_file = manifest_path(&root);
    if manifest_file.exists() {
        return Ok(InitResult {
            created: false,
            manifest: load_manifest(&root)?,
            graph_migrated: false,
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
    atomic_write(&root.join(".icarus/policies/default.yaml"), b"# ICARUS Harness policy v1\npolicy_version: 1\nexternal_writes: approval_required\nnetwork: agent_managed\nlearning: proposal_only\n")?;
    for (name, title) in [
        ("manifest.schema.json", "ICARUS Harness Manifest"),
        ("contract.schema.json", "ICARUS Task Contract"),
        ("checkpoint.schema.json", "ICARUS Checkpoint"),
        ("receipt.schema.json", "ICARUS Verification Receipt"),
        ("skill.schema.json", "ICARUS Proposed Skill"),
    ] {
        atomic_write(&root.join(".icarus/schemas").join(name), format!("{{\n  \"$schema\": \"https://json-schema.org/draft/2020-12/schema\",\n  \"title\": \"{}\",\n  \"type\": \"object\"\n}}\n", title).as_bytes())?;
    }
    atomic_write(&runtime_root(&root).join(".gitignore"), b"*\n!.gitignore\n")?;
    ensure_root_gitignore(&root)?;

    let legacy_graph = root.join(".icarus-graph/graph.db");
    let runtime_graph = runtime_root(&root).join("graph/graph.db");
    let graph_migrated = legacy_graph.exists() && !runtime_graph.exists();
    if graph_migrated {
        let target_parent = runtime_graph.parent().unwrap();
        fs::create_dir_all(target_parent)?;
        fs::copy(&legacy_graph, &runtime_graph)?;
    }
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
            &root.display().to_string(),
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
    let dirty = !git_output(&root, &["status", "--porcelain=v1"])
        .unwrap_or_default()
        .is_empty();
    let (workspace_path, worktree_id) = if workspace_mode == "current" {
        if dirty && !acknowledge_dirty_current {
            return Err(HarnessError::invalid(
                "current workspace has uncommitted changes; pass explicit acknowledgment before adopting it",
            ));
        }
        (root.clone(), "current".into())
    } else {
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
                    &root.display().to_string(),
                    "worktree",
                    "add",
                    "--detach",
                    &path.display().to_string(),
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
        workspace_path: workspace_path.display().to_string(),
        certification: certification.into(),
        compatibility_mode: certification != "certified",
        capabilities,
        launch_arguments: adapter_launch_arguments(&agent, &workspace_path, task_id),
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
    let files_touched = status
        .as_deref()
        .map(parse_status_paths)
        .unwrap_or_default();
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
            let candidate = Path::new(artifact);
            if candidate.is_absolute()
                || candidate
                    .components()
                    .any(|component| matches!(component, Component::ParentDir))
            {
                return Err(HarnessError::invalid(
                    "artifact path must stay inside the repository",
                ));
            }
            let exists = root.join(candidate).exists();
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
    let changed =
        parse_status_paths(&git_output(&root, &["status", "--porcelain=v1"]).unwrap_or_default());
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
pub fn propose_skill(repo_root: &Path, mut skill: HarnessSkill) -> Result<HarnessSkill> {
    let root = canonical_root(repo_root)?;
    load_manifest(&root)?;
    if !skill_id_valid(&skill.id)
        || skill.instructions.trim().is_empty()
        || skill.source_tasks.is_empty()
    {
        return Err(HarnessError::invalid(
            "skill requires a safe id, instructions, and sealed source task",
        ));
    }
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
    let path = runtime_root(&root)
        .join("skills/proposed")
        .join(format!("{}.json", skill.id));
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
    let proposed = runtime_root(&root)
        .join("skills/proposed")
        .join(format!("{skill_id}.json"));
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
    if !high_risk
        && (skill.source_tasks.len() < 3
            || skill
                .replay_results
                .iter()
                .filter(|result| result.get("success").and_then(Value::as_bool) == Some(true))
                .count()
                < 2
            || skill.confidence <= 0.0)
    {
        return Err(HarnessError::invalid("low-risk promotion requires 3 sealed sources, 2 successful replays, and measurable confidence"));
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
            "source_task_count": skill.source_tasks.len(),
            "successful_replay_count": skill.replay_results.iter().filter(|result| result.get("success").and_then(Value::as_bool) == Some(true)).count(),
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
        .arg(root)
        .args(args)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|text| text.trim().to_owned())
}

fn parse_status_paths(status: &str) -> Vec<String> {
    status
        .lines()
        .filter_map(|line| line.get(3..))
        .map(|path| {
            path.rsplit_once(" -> ")
                .map(|(_, new)| new)
                .unwrap_or(path)
                .to_owned()
        })
        .collect()
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
    if !types.is_empty() {
        let Some(task_type) = contract.task_type.as_deref() else {
            return false;
        };
        if !types.iter().any(|kind| kind == task_type) {
            return false;
        }
    }
    let patterns = string_list(skill.get("file_patterns"));
    patterns.is_empty()
        || patterns.iter().any(|skill_pattern| {
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
            if active && verified && skills_match_contract(&skill, contract) {
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
    let policy_path = root.join(".icarus/policies/default.yaml");
    let policy = fs::read_to_string(&policy_path)
        .map_err(|_| HarnessError::invalid("ICARUS harness policy is missing"))?;
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
    let policy_bytes = fs::read(root.join(".icarus/policies/default.yaml"))
        .map_err(|_| HarnessError::invalid("ICARUS harness policy is missing"))?;
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
        .open(event_path)?;
    writeln!(log, "{}", serde_json::to_string(&event)?)?;
    log.sync_all()?;
    write_snapshot(
        root,
        "state/event-head.json",
        json!({"schema_version": 1, "repo_id": manifest.repo_id, "sequence": event.sequence, "event_hash": event.event_hash}),
    )?;
    Ok(event)
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

#[cfg(not(unix))]
fn process_is_alive(_pid: u32) -> bool {
    false
}

struct RuntimeLock {
    path: PathBuf,
}

impl RuntimeLock {
    fn acquire(root: &Path, name: &str) -> Result<Self> {
        let path = locks_dir(root).join(format!("{}.lock", name));
        fs::create_dir_all(path.parent().unwrap())?;
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
                Ok(Self { path })
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                Err(HarnessError::invalid(format!(
                    "active runtime lock {}; run `icarus doctor` before retrying",
                    name
                )))
            }
            Err(error) => Err(error.into()),
        }
    }
}

impl Drop for RuntimeLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
