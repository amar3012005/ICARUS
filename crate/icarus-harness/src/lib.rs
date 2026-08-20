//! ICARUS Harness durable runtime.
//!
//! This crate deliberately owns no model client, agent adapter, or network transport. It is the
//! local authority for repository identity, policy, event history, locks, and runtime snapshots.
//! Language bindings may call it, but must not reimplement these invariants.

use globset::{Glob, GlobSetBuilder};
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
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TaskRecord {
    pub schema_version: u32,
    pub task_id: String,
    pub objective: String,
    pub status: String,
    pub contract_version: u32,
    pub contract: TaskContract,
    pub execution_id: String,
    pub previous_execution_id: Option<String>,
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
        contract,
        execution_id: String::new(),
        previous_execution_id: None,
    };
    let mut task = task;
    task.execution_id = task_execution_id(&task.task_id);
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
    validate_contract(&task.contract)?;
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
    checks.push(DoctorCheck {
        id: "graph".into(),
        status: if runtime_graph.exists() {
            "pass"
        } else {
            "warn"
        }
        .into(),
        detail: if runtime_graph.exists() {
            "runtime graph present".into()
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
