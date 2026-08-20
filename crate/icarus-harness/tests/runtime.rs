use icarus_harness::{
    amend_task_contract, append_event, authorize_action, checkpoint_task, doctor, init,
    read_snapshot, resume_task, start_task, task_status, transition_task, verify_event_chain,
    write_snapshot, Action, EventInput, InitOptions, TaskContract,
};
use std::fs;
use std::process::Command;
use tempfile::tempdir;

fn repo() -> tempfile::TempDir {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join(".git"), "gitdir: fake\n").unwrap();
    dir
}

#[test]
fn init_is_idempotent_and_creates_a_tracked_contract() {
    let repo = repo();
    let first = init(
        repo.path(),
        InitOptions {
            agents: vec!["claude".into(), "codex".into()],
        },
    )
    .unwrap();
    assert!(first.created);
    assert!(repo.path().join(".icarus/manifest.yaml").exists());
    assert!(repo.path().join(".icarus/policies/default.yaml").exists());
    assert!(repo
        .path()
        .join(".icarus/schemas/manifest.schema.json")
        .exists());
    assert!(repo.path().join(".icarus/runtime/.gitignore").exists());
    assert!(fs::read_to_string(repo.path().join(".gitignore"))
        .unwrap()
        .contains(".icarus/runtime/"));

    let again = init(
        repo.path(),
        InitOptions {
            agents: vec!["grok".into()],
        },
    )
    .unwrap();
    assert!(!again.created);
    assert_eq!(again.manifest.repo_id, first.manifest.repo_id);
    assert_eq!(again.manifest.agents, vec!["claude", "codex"]);
}

#[test]
fn events_have_a_durable_tamper_evident_chain_and_head() {
    let repo = repo();
    let initialized = init(repo.path(), InitOptions::default()).unwrap();
    append_event(repo.path(), EventInput::new("exec-1", "TASK-1", "created")).unwrap();
    append_event(
        repo.path(),
        EventInput::new("exec-1", "TASK-1", "checkpoint"),
    )
    .unwrap();
    assert!(
        verify_event_chain(repo.path(), &initialized.manifest.repo_id)
            .unwrap()
            .valid
    );

    let log = repo.path().join(".icarus/runtime/logs/events.jsonl");
    fs::write(
        &log,
        fs::read_to_string(&log)
            .unwrap()
            .replace("exec-1", "exec-2"),
    )
    .unwrap();
    let report = verify_event_chain(repo.path(), &initialized.manifest.repo_id).unwrap();
    assert!(!report.valid);
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.contains("event hash mismatch")));
}

#[test]
fn snapshots_cannot_escape_runtime_and_doctor_reports_tampering() {
    let repo = repo();
    let initialized = init(repo.path(), InitOptions::default()).unwrap();
    write_snapshot(
        repo.path(),
        "state/current-task.json",
        serde_json::json!({"task_id":"TASK-1"}),
    )
    .unwrap();
    assert_eq!(
        read_snapshot(repo.path(), "state/current-task.json")
            .unwrap()
            .unwrap()["task_id"],
        "TASK-1"
    );
    assert!(write_snapshot(repo.path(), "../outside.json", serde_json::json!({})).is_err());

    append_event(repo.path(), EventInput::new("exec-1", "TASK-1", "created")).unwrap();
    let log = repo.path().join(".icarus/runtime/logs/events.jsonl");
    fs::write(&log, "").unwrap();
    let report = doctor(repo.path()).unwrap();
    assert!(!report.healthy);
    assert_eq!(
        report.repo_id.as_deref(),
        Some(initialized.manifest.repo_id.as_str())
    );
    assert!(report
        .checks
        .iter()
        .any(|check| check.id == "event_chain" && check.status == "fail"));
}

fn contract() -> TaskContract {
    TaskContract {
        allowed_paths: vec!["src/**".into()],
        forbidden_paths: vec!["secrets/**".into()],
        acceptance_criteria: serde_json::json!([{"id":"unit","type":"test","command":"npm test","required":true}]),
        risk: "low".into(),
        budgets: serde_json::json!({"wall_time_minutes": 30}),
        authority: "local".into(),
        external_write_policy: "approval_required".into(),
    }
}

#[test]
fn lifecycle_keeps_immutable_contracts_and_scoped_writes() {
    let repo = repo();
    init(repo.path(), InitOptions::default()).unwrap();
    let task = start_task(repo.path(), "add a safe command", contract()).unwrap();
    assert!(task.task_id.starts_with("TASK-"));
    assert_eq!(task.status, "created");
    assert_eq!(
        task_status(repo.path(), &task.task_id)
            .unwrap()
            .contract_version,
        1
    );
    assert!(transition_task(repo.path(), &task.task_id, "executing").is_err());
    assert!(
        !authorize_action(repo.path(), &task.task_id, Action::write("src/new.rs"))
            .unwrap()
            .allowed
    );
    for state in ["orienting", "contracted", "planned", "executing"] {
        transition_task(repo.path(), &task.task_id, state).unwrap();
    }
    assert!(
        authorize_action(repo.path(), &task.task_id, Action::write("src/new.rs"))
            .unwrap()
            .allowed
    );
    assert!(
        !authorize_action(repo.path(), &task.task_id, Action::write("secrets/key.txt"))
            .unwrap()
            .allowed
    );
    assert!(
        !authorize_action(repo.path(), &task.task_id, Action::write("README.md"))
            .unwrap()
            .allowed
    );
}

#[test]
fn resume_preserves_task_identity_and_links_attempts() {
    let repo = repo();
    init(repo.path(), InitOptions::default()).unwrap();
    let task = start_task(repo.path(), "recover after interruption", contract()).unwrap();
    for state in ["orienting", "contracted", "planned"] {
        transition_task(repo.path(), &task.task_id, state).unwrap();
    }
    let resumed = resume_task(repo.path(), &task.task_id).unwrap();
    assert_eq!(resumed.task_id, task.task_id);
    assert_ne!(resumed.execution_id, task.execution_id);
    assert_eq!(resumed.status, "planned");
    assert_eq!(
        resumed.previous_execution_id.as_deref(),
        Some(task.execution_id.as_str())
    );
}

#[test]
fn doctor_detects_dead_stale_locks_without_flagging_a_live_writer() {
    let repo = repo();
    init(repo.path(), InitOptions::default()).unwrap();
    let locks = repo.path().join(".icarus/runtime/locks");
    fs::create_dir_all(locks.join("dead.lock")).unwrap();
    fs::write(
        locks.join("dead.lock/owner.json"),
        "{\"pid\":999999,\"acquired_at_unix_seconds\":0}\n",
    )
    .unwrap();
    let report = doctor(repo.path()).unwrap();
    assert!(!report.healthy);
    assert!(report
        .checks
        .iter()
        .any(|check| check.id == "stale_locks" && check.status == "fail"));
}

#[test]
fn amendments_preserve_contract_history_and_require_approval_after_execution() {
    let repo = repo();
    init(repo.path(), InitOptions::default()).unwrap();
    let task = start_task(repo.path(), "amend scope", contract()).unwrap();
    for state in ["orienting", "contracted", "planned", "executing"] {
        transition_task(repo.path(), &task.task_id, state).unwrap();
    }
    let mut amended = contract();
    amended.allowed_paths.push("tests/**".into());
    assert!(amend_task_contract(
        repo.path(),
        &task.task_id,
        amended.clone(),
        "need coverage",
        None
    )
    .is_err());
    let changed = amend_task_contract(
        repo.path(),
        &task.task_id,
        amended,
        "need coverage",
        Some("APPROVAL-1".into()),
    )
    .unwrap();
    assert_eq!(changed.contract_version, 2);
    assert!(repo
        .path()
        .join(format!(
            ".icarus/runtime/tasks/{}/contract.v1.json",
            task.task_id
        ))
        .exists());
    assert!(repo
        .path()
        .join(format!(
            ".icarus/runtime/tasks/{}/contract.v2.json",
            task.task_id
        ))
        .exists());
}

#[test]
fn checkpoints_capture_worktree_fingerprint_and_agent_supplied_progress() {
    let repo = repo();
    init(repo.path(), InitOptions::default()).unwrap();
    let task = start_task(repo.path(), "capture progress", contract()).unwrap();
    let checkpoint = checkpoint_task(repo.path(), &task.task_id, "planning", serde_json::json!({
        "open_risks": ["needs review"], "next_valid_action": "implement", "budget_consumption": {"tokens": 50}
    })).unwrap();
    assert_eq!(checkpoint.sequence, 1);
    assert_eq!(checkpoint.phase, "planning");
    assert_eq!(checkpoint.next_valid_action.as_deref(), Some("implement"));
    assert!(repo
        .path()
        .join(format!(
            ".icarus/runtime/tasks/{}/checkpoints.jsonl",
            task.task_id
        ))
        .exists());
}

#[test]
fn resume_refuses_worktree_divergence_since_the_last_checkpoint() {
    let repo = repo();
    fs::remove_file(repo.path().join(".git")).unwrap();
    assert!(Command::new("git")
        .args(["init", "-q"])
        .current_dir(repo.path())
        .status()
        .unwrap()
        .success());
    init(repo.path(), InitOptions::default()).unwrap();
    let task = start_task(repo.path(), "safe resume", contract()).unwrap();
    for state in ["orienting", "contracted", "planned"] {
        transition_task(repo.path(), &task.task_id, state).unwrap();
    }
    checkpoint_task(repo.path(), &task.task_id, "planned", serde_json::json!({})).unwrap();
    fs::create_dir_all(repo.path().join("src")).unwrap();
    fs::write(repo.path().join("src/changed.rs"), "changed\n").unwrap();
    let error = resume_task(repo.path(), &task.task_id).unwrap_err();
    assert!(error.to_string().contains("worktree divergence"));
}
