use icarus_harness::{
    amend_task_contract, append_event, attest_task_criterion, authorize_action, build_context,
    checkpoint_task, doctor, graph_source_fingerprint, init, prepare_run, read_snapshot,
    record_graph_receipt, resume_task, retire_skill, seal_task, start_task, task_status,
    transition_task, verify_event_chain, verify_task_criterion, write_snapshot, Action, EventInput,
    HarnessSkill, InitOptions, TaskContract,
};
use rusqlite::Connection;
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
        decision_references: Vec::new(),
        task_type: None,
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

#[test]
fn context_compiler_is_deterministic_traceable_and_budgeted() {
    let repo = repo();
    init(repo.path(), InitOptions::default()).unwrap();
    let task = start_task(repo.path(), "compile context", contract()).unwrap();
    let first = build_context(repo.path(), &task.task_id, 20_000).unwrap();
    let second = build_context(repo.path(), &task.task_id, 20_000).unwrap();
    assert_eq!(first, second);
    assert_eq!(first.task_id, task.task_id);
    assert!(first
        .items
        .iter()
        .any(|item| item.kind == "contract" && item.mandatory));
    assert!(first
        .items
        .iter()
        .all(|item| !item.digest.is_empty() && !item.source.is_empty()));
    assert!(first.upper_bound_tokens <= first.budget_tokens);
    assert!(build_context(repo.path(), &task.task_id, 1)
        .unwrap_err()
        .to_string()
        .contains("budget_unsatisfied"));
}

#[test]
fn delta_context_contains_only_changes_after_a_checkpoint() {
    let repo = repo();
    init(repo.path(), InitOptions::default()).unwrap();
    let mut scoped_contract = contract();
    scoped_contract.decision_references = vec!["DEC-missing".into()];
    let task = start_task(repo.path(), "delta context", scoped_contract).unwrap();
    let checkpoint = checkpoint_task(
        repo.path(),
        &task.task_id,
        "planned",
        serde_json::json!({"next_valid_action":"edit"}),
    )
    .unwrap();
    transition_task(repo.path(), &task.task_id, "orienting").unwrap();
    let delta = icarus_harness::build_context_delta(
        repo.path(),
        &task.task_id,
        checkpoint.sequence,
        20_000,
    )
    .unwrap();
    assert_eq!(delta.base_checkpoint_sequence, Some(checkpoint.sequence));
    assert!(delta
        .items
        .iter()
        .any(|item| item.kind == "lifecycle_delta"));
    assert!(!delta.items.iter().any(|item| item.kind == "contract"));
    assert!(delta
        .items
        .iter()
        .any(|item| item.kind == "decision_reference_delta" && item.freshness == "unavailable"));
}

#[test]
fn graph_receipt_is_atomically_bound_to_source_and_database() {
    let repo = repo();
    init(repo.path(), InitOptions::default()).unwrap();
    fs::create_dir_all(repo.path().join("src")).unwrap();
    fs::write(repo.path().join("src/lib.rs"), "pub fn stable() {}\n").unwrap();
    fs::create_dir_all(repo.path().join(".icarus/runtime/graph")).unwrap();
    fs::write(
        repo.path().join(".icarus/runtime/graph/graph.db"),
        b"graph-v1",
    )
    .unwrap();
    let fingerprint = graph_source_fingerprint(repo.path()).unwrap();
    let receipt = record_graph_receipt(repo.path(), fingerprint).unwrap();
    assert_eq!(receipt.schema_version, 1);
    let task = start_task(repo.path(), "graph-aware context", contract()).unwrap();
    let current = build_context(repo.path(), &task.task_id, 20_000).unwrap();
    let worktree = current
        .items
        .iter()
        .find(|item| item.kind == "worktree")
        .unwrap();
    assert!(worktree.content.contains("\"current\": true"));

    fs::write(repo.path().join("src/lib.rs"), "pub fn changed() {}\n").unwrap();
    let stale = build_context(repo.path(), &task.task_id, 20_000).unwrap();
    let worktree = stale
        .items
        .iter()
        .find(|item| item.kind == "worktree")
        .unwrap();
    assert!(worktree.content.contains("\"current\": false"));
    assert!(doctor(repo.path())
        .unwrap()
        .checks
        .iter()
        .any(|check| check.id == "graph" && check.status == "warn"));
}

#[test]
fn context_compiler_reads_a_bounded_current_graph_slice_in_rust() {
    let repo = repo();
    init(repo.path(), InitOptions::default()).unwrap();
    fs::create_dir_all(repo.path().join("src")).unwrap();
    fs::write(
        repo.path().join("src/parser.rs"),
        "pub fn graph_parser() { graph_helper(); }\npub fn graph_helper() {}\n",
    )
    .unwrap();
    let graph_dir = repo.path().join(".icarus/runtime/graph");
    fs::create_dir_all(&graph_dir).unwrap();
    let connection = Connection::open(graph_dir.join("graph.db")).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE nodes (qualified_name TEXT, file_path TEXT, start_line INTEGER, end_line INTEGER, language TEXT, name TEXT);
             CREATE TABLE edges (kind TEXT, source_qualified TEXT, target_qualified TEXT, file_path TEXT, line INTEGER);",
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO nodes VALUES (?1, ?2, 1, 1, 'rust', 'graph_parser')",
            ["src/parser.rs::graph_parser", "src/parser.rs"],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO nodes VALUES (?1, ?2, 2, 2, 'rust', 'graph_helper')",
            ["src/parser.rs::graph_helper", "src/parser.rs"],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO edges VALUES ('CALLS', ?1, ?2, 'src/parser.rs', 1)",
            ["src/parser.rs::graph_parser", "src/parser.rs::graph_helper"],
        )
        .unwrap();
    drop(connection);
    record_graph_receipt(repo.path(), graph_source_fingerprint(repo.path()).unwrap()).unwrap();
    let task = start_task(repo.path(), "improve graph parser", contract()).unwrap();
    let pack = build_context(repo.path(), &task.task_id, 20_000).unwrap();
    let graph = pack
        .items
        .iter()
        .find(|item| item.kind == "graph_slice")
        .unwrap();
    assert_eq!(graph.freshness, "current");
    assert!(graph.content.contains("src/parser.rs::graph_parser"));
    assert!(graph.content.contains("graph_helper"));
}

#[test]
fn context_includes_only_task_linked_decisions_and_verified_matching_skills() {
    let repo = repo();
    init(repo.path(), InitOptions::default()).unwrap();
    fs::create_dir_all(repo.path().join(".icarus/decisions")).unwrap();
    fs::write(
        repo.path().join(".icarus/decisions/DEC-42.json"),
        r#"{"id":"DEC-42","authority":"owner","content":"Keep the parser offline."}"#,
    )
    .unwrap();
    fs::create_dir_all(repo.path().join(".icarus/skills")).unwrap();
    fs::write(
        repo.path().join(".icarus/skills/parser-review.json"),
        r#"{"state":"active","task_types":["code_change"],"file_patterns":["src/**"],"verification":{"status":"verified"},"instructions":"Run parser regression tests."}"#,
    )
    .unwrap();
    fs::write(
        repo.path().join(".icarus/skills/unverified.json"),
        r#"{"state":"proposed","task_types":["code_change"],"file_patterns":["src/**"],"verification":{"status":"unverified"},"instructions":"Must not enter context."}"#,
    )
    .unwrap();
    let mut scoped_contract = contract();
    scoped_contract.decision_references = vec!["DEC-42".into(), "DEC-missing".into()];
    scoped_contract.task_type = Some("code_change".into());
    let task = start_task(repo.path(), "improve parser", scoped_contract).unwrap();
    let pack = build_context(repo.path(), &task.task_id, 20_000).unwrap();
    assert!(pack
        .items
        .iter()
        .any(|item| item.kind == "decision_reference"
            && item.content.contains("Keep the parser offline")));
    assert!(pack
        .items
        .iter()
        .any(|item| item.kind == "decision_reference" && item.freshness == "unavailable"));
    assert!(pack.items.iter().any(|item| item.kind == "verified_skill"
        && item.content.contains("Run parser regression tests")));
    assert!(!pack
        .items
        .iter()
        .any(|item| item.content.contains("Must not enter context")));
}

#[test]
fn managed_run_prepares_an_isolated_worktree_and_requires_current_acknowledgment() {
    let repo = repo();
    fs::remove_file(repo.path().join(".git")).unwrap();
    assert!(Command::new("git")
        .args(["init", "-q"])
        .current_dir(repo.path())
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["config", "user.email", "test@example.invalid"])
        .current_dir(repo.path())
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["config", "user.name", "test"])
        .current_dir(repo.path())
        .status()
        .unwrap()
        .success());
    fs::write(repo.path().join("README.md"), "fixture\n").unwrap();
    assert!(Command::new("git")
        .args(["add", "README.md"])
        .current_dir(repo.path())
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-qm", "fixture"])
        .current_dir(repo.path())
        .status()
        .unwrap()
        .success());
    init(
        repo.path(),
        InitOptions {
            agents: vec!["codex".into()],
        },
    )
    .unwrap();
    let task = start_task(repo.path(), "managed run", contract()).unwrap();
    for state in ["orienting", "contracted", "planned"] {
        transition_task(repo.path(), &task.task_id, state).unwrap();
    }
    assert!(prepare_run(
        repo.path(),
        &task.task_id,
        "codex".into(),
        "current".into(),
        false
    )
    .is_err());
    let prepared = prepare_run(
        repo.path(),
        &task.task_id,
        "codex".into(),
        "isolated".into(),
        false,
    )
    .unwrap();
    assert_eq!(prepared.workspace_mode, "isolated");
    assert_eq!(prepared.certification, "compatibility");
    assert!(prepared.compatibility_mode);
    assert!(!prepared.capabilities.pre_action_authorization);
    assert_eq!(
        prepared.launch_arguments,
        vec![
            "--cd",
            prepared.workspace_path.as_str(),
            "--sandbox",
            "workspace-write",
            "--ask-for-approval",
            "on-request",
        ]
    );
    assert!(std::path::Path::new(&prepared.workspace_path)
        .join("README.md")
        .exists());
    assert!(
        read_snapshot(repo.path(), &format!("state/run-{}.json", task.task_id))
            .unwrap()
            .is_some()
    );
    assert!(Command::new("git")
        .args(["worktree", "remove", "--force", &prepared.workspace_path])
        .current_dir(repo.path())
        .status()
        .unwrap()
        .success());
}

#[test]
fn verifier_executes_immutable_criteria_and_records_machine_receipts() {
    let repo = repo();
    init(repo.path(), InitOptions::default()).unwrap();
    let mut verified_contract = contract();
    verified_contract.acceptance_criteria = serde_json::json!([
        {"id":"unit","type":"test","command":"printf 'unit pass\\n'","required":true},
        {"id":"artifact","type":"artifact","path":"README.md","required":true}
    ]);
    fs::write(repo.path().join("README.md"), "artifact\n").unwrap();
    let task = start_task(repo.path(), "verify real evidence", verified_contract).unwrap();
    for state in [
        "orienting",
        "contracted",
        "planned",
        "executing",
        "verifying",
    ] {
        transition_task(repo.path(), &task.task_id, state).unwrap();
    }
    let receipt = verify_task_criterion(repo.path(), &task.task_id, "unit").unwrap();
    assert_eq!(receipt.status, "pass");
    assert!(receipt.output_excerpt.contains("unit pass"));
    assert!(repo.path().join(&receipt.output_path).exists());
    assert!(verify_task_criterion(repo.path(), &task.task_id, "not-in-contract").is_err());
    let sealed = seal_task(repo.path(), &task.task_id).unwrap();
    assert!(!sealed.sealed);
    assert!(sealed
        .unmet_criteria
        .iter()
        .any(|item| item.contains("artifact")));
    let artifact = verify_task_criterion(repo.path(), &task.task_id, "artifact").unwrap();
    assert_eq!(artifact.status, "pass");
    assert_eq!(artifact.artifacts, vec!["README.md"]);
    let sealed = seal_task(repo.path(), &task.task_id).unwrap();
    assert!(sealed.sealed);
    assert!(repo
        .path()
        .join(sealed.final_receipt_path.unwrap())
        .exists());
}

#[test]
fn external_approval_is_expiry_bound_and_cannot_be_replaced_by_pending_prose() {
    let repo = repo();
    init(repo.path(), InitOptions::default()).unwrap();
    let mut approval_contract = contract();
    approval_contract.acceptance_criteria = serde_json::json!([
        {"id":"owner","type":"external_approval","required":true}
    ]);
    let task = start_task(repo.path(), "owner gate", approval_contract).unwrap();
    for state in [
        "orienting",
        "contracted",
        "planned",
        "executing",
        "verifying",
    ] {
        transition_task(repo.path(), &task.task_id, state).unwrap();
    }
    assert_eq!(
        verify_task_criterion(repo.path(), &task.task_id, "owner")
            .unwrap()
            .status,
        "pending"
    );
    assert!(!seal_task(repo.path(), &task.task_id).unwrap().sealed);
    assert!(attest_task_criterion(
        repo.path(),
        &task.task_id,
        "owner",
        "APR-100",
        "owner@example.test",
        None,
    )
    .is_err());
    assert!(attest_task_criterion(
        repo.path(),
        &task.task_id,
        "owner",
        "APR-100",
        "owner@example.test",
        Some("2000-01-01T00:00:00Z".into()),
    )
    .is_err());
    let receipt = attest_task_criterion(
        repo.path(),
        &task.task_id,
        "owner",
        "APR-100",
        "owner@example.test",
        Some("2099-01-01T00:00:00Z".into()),
    )
    .unwrap();
    assert_eq!(receipt.status, "pass");
    assert_eq!(receipt.expires_at.as_deref(), Some("2099-01-01T00:00:00Z"));
    assert!(seal_task(repo.path(), &task.task_id).unwrap().sealed);
}

#[test]
fn context_exposes_failed_evidence_and_unresolved_risks_without_agent_inference() {
    let repo = repo();
    init(repo.path(), InitOptions::default()).unwrap();
    let mut failing_contract = contract();
    failing_contract.acceptance_criteria = serde_json::json!([
        {"id":"unit","type":"test","command":"exit 7","required":true}
    ]);
    let task = start_task(repo.path(), "repair a failing check", failing_contract).unwrap();
    for state in [
        "orienting",
        "contracted",
        "planned",
        "executing",
        "verifying",
    ] {
        transition_task(repo.path(), &task.task_id, state).unwrap();
    }
    assert_eq!(
        verify_task_criterion(repo.path(), &task.task_id, "unit")
            .unwrap()
            .status,
        "fail"
    );
    checkpoint_task(
        repo.path(),
        &task.task_id,
        "verification",
        serde_json::json!({"open_risks":["unit test still fails"],"next_valid_action":"repair and rerun unit"}),
    )
    .unwrap();
    let pack = build_context(repo.path(), &task.task_id, 20_000).unwrap();
    assert!(pack
        .items
        .iter()
        .any(|item| item.kind == "failed_criteria" && item.content.contains("exit 7")));
    assert!(pack
        .items
        .iter()
        .any(|item| item.kind == "unresolved_risks"
            && item.content.contains("unit test still fails")));
}

#[test]
fn seal_rejects_a_receipt_after_a_real_worktree_edit() {
    let repo = repo();
    fs::remove_file(repo.path().join(".git")).unwrap();
    for args in [
        ["init", "-q"].as_slice(),
        ["config", "user.email", "test@example.invalid"].as_slice(),
        ["config", "user.name", "test"].as_slice(),
    ] {
        assert!(Command::new("git")
            .args(args)
            .current_dir(repo.path())
            .status()
            .unwrap()
            .success());
    }
    fs::create_dir_all(repo.path().join("src")).unwrap();
    fs::write(repo.path().join("src/initial.rs"), "// baseline\n").unwrap();
    assert!(Command::new("git")
        .args(["add", "."])
        .current_dir(repo.path())
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-qm", "baseline"])
        .current_dir(repo.path())
        .status()
        .unwrap()
        .success());
    init(repo.path(), InitOptions::default()).unwrap();
    assert!(Command::new("git")
        .args(["add", ".icarus", ".gitignore"])
        .current_dir(repo.path())
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-qm", "harness init"])
        .current_dir(repo.path())
        .status()
        .unwrap()
        .success());
    let mut verified_contract = contract();
    verified_contract.acceptance_criteria = serde_json::json!([
        {"id":"unit","type":"test","command":"printf 'pass\\n'","required":true}
    ]);
    let task = start_task(repo.path(), "guard stale evidence", verified_contract).unwrap();
    for state in [
        "orienting",
        "contracted",
        "planned",
        "executing",
        "verifying",
    ] {
        transition_task(repo.path(), &task.task_id, state).unwrap();
    }
    assert_eq!(
        verify_task_criterion(repo.path(), &task.task_id, "unit")
            .unwrap()
            .status,
        "pass"
    );
    fs::write(
        repo.path().join("src/after-verification.rs"),
        "// changed after receipt\n",
    )
    .unwrap();
    let seal = seal_task(repo.path(), &task.task_id).unwrap();
    assert!(!seal.sealed);
    assert!(seal
        .unmet_criteria
        .iter()
        .any(|reason| reason.contains("workspace changed since verification")));
}

#[test]
fn harness_skill_cannot_be_proposed_from_an_unsealed_task() {
    let repo = repo();
    init(repo.path(), InitOptions::default()).unwrap();
    let task = start_task(repo.path(), "unsealed source", contract()).unwrap();
    let skill = HarnessSkill {
        schema_version: 0,
        id: "safe-review".into(),
        state: "active".into(),
        triggers: vec!["review".into()],
        instructions: "Run the scoped tests.".into(),
        allowed_tools: vec!["shell".into()],
        policy_requirements: vec![],
        verification_steps: vec!["test".into()],
        source_tasks: vec![task.task_id],
        decision_references: vec![],
        risk: "low".into(),
        owner: "owner".into(),
        version: 0,
        confidence: 1.0,
        replay_results: vec![],
        verification: serde_json::Value::Null,
    };
    assert!(icarus_harness::propose_skill(repo.path(), skill).is_err());
}

fn sealed_source_task(repo: &std::path::Path, objective: &str) -> String {
    let mut source_contract = contract();
    source_contract.acceptance_criteria = serde_json::json!([
        {"id":"unit","type":"test","command":"printf 'skill source pass\\n'","required":true}
    ]);
    let task = start_task(repo, objective, source_contract).unwrap();
    for state in [
        "orienting",
        "contracted",
        "planned",
        "executing",
        "verifying",
    ] {
        transition_task(repo, &task.task_id, state).unwrap();
    }
    assert_eq!(
        verify_task_criterion(repo, &task.task_id, "unit")
            .unwrap()
            .status,
        "pass"
    );
    assert!(seal_task(repo, &task.task_id).unwrap().sealed);
    task.task_id
}

#[test]
fn skill_promotion_writes_verified_authority_and_retirement_preserves_audit_trail() {
    let repo = repo();
    init(repo.path(), InitOptions::default()).unwrap();
    let source = sealed_source_task(repo.path(), "derive reviewed procedure");
    let skill = HarnessSkill {
        schema_version: 0,
        id: "deploy-review".into(),
        state: "active".into(),
        triggers: vec!["deployment review".into()],
        instructions: "Review the deployment receipt before approval.".into(),
        allowed_tools: vec!["shell".into()],
        policy_requirements: vec!["require owner approval".into()],
        verification_steps: vec!["receipt review".into()],
        source_tasks: vec![source],
        decision_references: vec![],
        risk: "deploy".into(),
        owner: "owner".into(),
        version: 0,
        confidence: 1.0,
        replay_results: vec![],
        verification: serde_json::Value::Null,
    };
    icarus_harness::propose_skill(repo.path(), skill).unwrap();
    assert!(icarus_harness::promote_skill(repo.path(), "deploy-review", None).is_err());
    let active =
        icarus_harness::promote_skill(repo.path(), "deploy-review", Some("APR-42".into())).unwrap();
    assert_eq!(active.verification["status"], "verified");
    let active_path = repo.path().join(".icarus/skills/active/deploy-review.json");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&fs::read_to_string(&active_path).unwrap())
            .unwrap()["verification"]["status"],
        "verified"
    );
    assert!(retire_skill(repo.path(), "deploy-review", "superseded procedure", None).is_err());
    let retired = retire_skill(
        repo.path(),
        "deploy-review",
        "superseded procedure",
        Some("APR-43".into()),
    )
    .unwrap();
    assert_eq!(retired.state, "retired");
    assert_eq!(retired.verification["status"], "retired");
    assert!(repo
        .path()
        .join(".icarus/runtime/skills/retired/deploy-review-v1.json")
        .exists());
    assert!(repo
        .path()
        .join(".icarus/skills/retired/deploy-review-v1.json")
        .exists());
}
