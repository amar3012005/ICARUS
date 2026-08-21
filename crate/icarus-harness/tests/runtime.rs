use icarus_harness::{
    amend_task_contract, append_event, attest_task_criterion, authorize_action,
    authorize_adapter_write, bind_codex_app_server_thread, build_context, checkpoint_task,
    decide_codex_app_server_approval, doctor, evaluate_skill, export_task,
    graph_source_fingerprint, handoff_managed_task, init, load_repository_policy, migrate,
    prepare_run, read_snapshot, reconcile_run, record_active_skill_outcome,
    record_adapter_lifecycle, record_adapter_post_action, record_codex_app_server_event,
    record_graph_receipt, render_context_markdown, resume_task, retire_skill, review_active_skills,
    seal_task, start_task, task_status, transition_task, validate_agent_arguments,
    verify_event_chain, verify_task_criterion, write_snapshot, Action, ContextItem, EventInput,
    HarnessSkill, InitOptions, TaskContract,
};
use rusqlite::Connection;
use std::fs;
#[cfg(feature = "test-failpoints")]
use std::path::Path;
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
    let policy_schema: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(repo.path().join(".icarus/schemas/policy.schema.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(policy_schema["additionalProperties"], false);
    assert_eq!(
        policy_schema["properties"]["external_writes"]["enum"][0],
        "approval_required"
    );
    assert_eq!(
        load_repository_policy(repo.path()).unwrap().network,
        "agent_managed"
    );
    let skill_schema: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(repo.path().join(".icarus/schemas/skill.schema.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(skill_schema["additionalProperties"], false);
    assert!(skill_schema["required"]
        .as_array()
        .unwrap()
        .iter()
        .any(|field| field == "proof_expires_at"));
    assert_eq!(skill_schema["properties"]["state"]["enum"][2], "demoted");
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

    fs::remove_file(repo.path().join(".icarus/schemas/policy.schema.json")).unwrap();
    let upgraded = init(repo.path(), InitOptions::default()).unwrap();
    assert!(!upgraded.created);
    assert!(repo
        .path()
        .join(".icarus/schemas/policy.schema.json")
        .exists());
}

#[test]
fn init_safely_retries_a_legacy_graph_copy_after_manifest_creation() {
    let repo = repo();
    let legacy = repo.path().join(".icarus-graph/graph.db");
    fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    fs::write(&legacy, b"legacy graph fixture").unwrap();
    let first = init(repo.path(), InitOptions::default()).unwrap();
    assert!(first.graph_migrated);
    let runtime = repo.path().join(".icarus/runtime/graph/graph.db");
    assert_eq!(fs::read(&runtime).unwrap(), b"legacy graph fixture");
    fs::remove_file(&runtime).unwrap();
    let retried = init(repo.path(), InitOptions::default()).unwrap();
    assert!(!retried.created);
    assert!(retried.graph_migrated);
    assert!(legacy.exists());
    assert_eq!(fs::read(&runtime).unwrap(), b"legacy graph fixture");
}

#[test]
fn migration_dry_run_is_non_mutating_and_apply_preserves_amr_bytes() {
    let repo = repo();
    let legacy = repo.path().join(".icarus-graph/graph.db");
    fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    fs::write(&legacy, b"legacy graph fixture").unwrap();
    let shard = repo.path().join(".icarus/data/amar/shard.amr");
    fs::create_dir_all(shard.parent().unwrap()).unwrap();
    fs::write(&shard, b"amr bytes must remain opaque").unwrap();

    let preview = migrate(repo.path(), true, InitOptions::default()).unwrap();
    assert!(preview.dry_run && preview.needed && !preview.applied);
    assert!(!repo.path().join(".icarus/manifest.yaml").exists());
    assert!(!repo.path().join(".icarus/runtime/graph/graph.db").exists());
    assert_eq!(fs::read(&shard).unwrap(), b"amr bytes must remain opaque");

    let applied = migrate(repo.path(), false, InitOptions::default()).unwrap();
    assert!(applied.needed && applied.applied);
    assert!(repo.path().join(".icarus/manifest.yaml").exists());
    assert_eq!(
        fs::read(repo.path().join(".icarus/runtime/graph/graph.db")).unwrap(),
        b"legacy graph fixture"
    );
    assert!(legacy.exists());
    assert_eq!(fs::read(&shard).unwrap(), b"amr bytes must remain opaque");
}

#[test]
fn published_v03_migration_corpus_preserves_memory_bytes_and_legacy_graph() {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct MigrationCorpus {
        schema_version: u32,
        source: String,
        legacy_graph_path: String,
        shard_files: Vec<String>,
        tags: Vec<String>,
    }

    let corpus: MigrationCorpus = serde_json::from_str(include_str!(
        "../../../docs/evals/migration-corpus-v0.3.json"
    ))
    .unwrap();
    assert_eq!(corpus.schema_version, 1);
    assert_eq!(corpus.source, "public ICARUS git tags");
    assert!(!corpus.tags.is_empty());

    for tag in corpus.tags {
        let fixture = repo();
        let legacy = fixture.path().join(&corpus.legacy_graph_path);
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        let legacy_bytes = format!("legacy graph from {tag}").into_bytes();
        fs::write(&legacy, &legacy_bytes).unwrap();

        let shard_root = fixture.path().join(".icarus/data/default");
        fs::create_dir_all(&shard_root).unwrap();
        let shard_bytes: Vec<_> = corpus
            .shard_files
            .iter()
            .map(|name| {
                let path = shard_root.join(name);
                let bytes = format!("opaque {name} bytes from {tag}").into_bytes();
                fs::write(&path, &bytes).unwrap();
                (path, bytes)
            })
            .collect();

        let preview = migrate(fixture.path(), true, InitOptions::default()).unwrap();
        assert!(
            preview.dry_run && preview.needed && !preview.applied,
            "{tag}"
        );
        assert!(
            !fixture.path().join(".icarus/manifest.yaml").exists(),
            "{tag}"
        );
        assert!(
            !fixture
                .path()
                .join(".icarus/runtime/graph/graph.db")
                .exists(),
            "{tag}"
        );
        assert_eq!(fs::read(&legacy).unwrap(), legacy_bytes, "{tag}");
        for (path, bytes) in &shard_bytes {
            assert_eq!(fs::read(path).unwrap(), *bytes, "{tag}: {}", path.display());
        }

        let applied = migrate(fixture.path(), false, InitOptions::default()).unwrap();
        assert!(applied.needed && applied.applied, "{tag}");
        let copied = fixture.path().join(".icarus/runtime/graph/graph.db");
        assert_eq!(fs::read(&copied).unwrap(), legacy_bytes, "{tag}");
        assert_eq!(fs::read(&legacy).unwrap(), legacy_bytes, "{tag}");
        for (path, bytes) in &shard_bytes {
            assert_eq!(fs::read(path).unwrap(), *bytes, "{tag}: {}", path.display());
        }

        let rerun = migrate(fixture.path(), false, InitOptions::default()).unwrap();
        assert!(!rerun.needed && !rerun.applied, "{tag}");
    }
}

#[test]
fn malformed_repository_policy_fails_closed_and_doctor_reports_it() {
    let repo = repo();
    init(repo.path(), InitOptions::default()).unwrap();
    fs::write(
        repo.path().join(".icarus/policies/default.yaml"),
        "policy_version: 1\nexternal_writes: auto\nnetwork: agent_managed\nlearning: proposal_only\n",
    )
    .unwrap();
    assert!(load_repository_policy(repo.path()).is_err());
    let report = doctor(repo.path()).unwrap();
    assert!(!report.healthy);
    assert!(report
        .checks
        .iter()
        .any(|check| check.id == "policy" && check.status == "fail"));
}

#[test]
fn doctor_reports_when_no_managed_adapter_has_been_enabled() {
    let repo = repo();
    init(repo.path(), InitOptions::default()).unwrap();
    let report = doctor(repo.path()).unwrap();
    assert!(report.healthy);
    assert!(report.checks.iter().any(|check| {
        check.id == "adapters"
            && check.status == "warn"
            && check.detail.contains("no managed adapters enabled")
    }));
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
    assert!(append_event(repo.path(), EventInput::new("exec-1", "TASK-1", "resume"),).is_err());
}

#[test]
fn next_append_repairs_only_a_valid_stale_event_head_after_an_interrupted_append() {
    let repo = repo();
    let initialized = init(repo.path(), InitOptions::default()).unwrap();
    append_event(repo.path(), EventInput::new("exec-1", "TASK-1", "created")).unwrap();
    let head_path = repo.path().join(".icarus/runtime/state/event-head.json");
    let first_head = fs::read(&head_path).unwrap();

    append_event(
        repo.path(),
        EventInput::new("exec-1", "TASK-1", "checkpoint"),
    )
    .unwrap();
    // Model a process killed after the second log line had been fsync'd but before replacing its
    // head snapshot. The next append may repair this one exact, cryptographically valid state.
    fs::write(&head_path, first_head).unwrap();
    append_event(repo.path(), EventInput::new("exec-1", "TASK-1", "resumed")).unwrap();

    let report = verify_event_chain(repo.path(), &initialized.manifest.repo_id).unwrap();
    assert!(report.valid, "{:#?}", report.issues);
    assert_eq!(report.events, 3);
}

#[cfg(feature = "test-failpoints")]
#[test]
fn crash_child_after_event_log_sync() {
    let Ok(root) = std::env::var("ICARUS_TEST_CRASH_REPO") else {
        return;
    };
    append_event(
        Path::new(&root),
        EventInput::new("exec-crash", "TASK-CRASH", "crash-point"),
    )
    .unwrap();
}

#[cfg(feature = "test-failpoints")]
#[test]
fn crash_child_after_atomic_snapshot_rename() {
    let Ok(root) = std::env::var("ICARUS_TEST_CRASH_REPO") else {
        return;
    };
    write_snapshot(
        Path::new(&root),
        "state/atomic-crash.json",
        serde_json::json!({"generation": "new"}),
    )
    .unwrap();
}

#[cfg(feature = "test-failpoints")]
#[test]
fn crash_child_during_task_snapshot_transition() {
    let Ok(root) = std::env::var("ICARUS_TEST_CRASH_REPO") else {
        return;
    };
    let task_id = std::env::var("ICARUS_TEST_CRASH_TASK").unwrap();
    transition_task(Path::new(&root), &task_id, "orienting").unwrap();
}

#[cfg(feature = "test-failpoints")]
#[test]
fn killed_writer_reclaims_its_dead_lock_and_recovers_the_durable_event_log() {
    let repo = repo();
    let initialized = init(repo.path(), InitOptions::default()).unwrap();
    append_event(repo.path(), EventInput::new("exec-1", "TASK-1", "created")).unwrap();

    let child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "crash_child_after_event_log_sync", "--nocapture"])
        .env("ICARUS_TEST_CRASH_REPO", repo.path())
        .env("ICARUS_TEST_CRASH_POINT", "event-after-log-sync")
        .status()
        .unwrap();
    assert!(!child.success(), "crash child unexpectedly succeeded");
    assert!(repo
        .path()
        .join(".icarus/runtime/locks/events.lock")
        .exists());

    // This acquires the dead writer's lock, repairs the one valid stale-head state, and appends
    // without truncating either durable event.
    append_event(repo.path(), EventInput::new("exec-1", "TASK-1", "resumed")).unwrap();
    let report = verify_event_chain(repo.path(), &initialized.manifest.repo_id).unwrap();
    assert!(report.valid, "{:#?}", report.issues);
    assert_eq!(report.events, 3);
    assert!(!repo
        .path()
        .join(".icarus/runtime/locks/events.lock")
        .exists());
}

#[cfg(feature = "test-failpoints")]
#[test]
fn killed_writer_after_atomic_snapshot_rename_leaves_a_complete_recoverable_snapshot() {
    let repo = repo();
    init(repo.path(), InitOptions::default()).unwrap();
    write_snapshot(
        repo.path(),
        "state/atomic-crash.json",
        serde_json::json!({"generation": "old"}),
    )
    .unwrap();

    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "crash_child_after_atomic_snapshot_rename",
            "--nocapture",
        ])
        .env("ICARUS_TEST_CRASH_REPO", repo.path())
        .env("ICARUS_TEST_CRASH_POINT", "atomic-after-rename")
        .status()
        .unwrap();
    assert!(!child.success(), "crash child unexpectedly succeeded");

    // The candidate had completed file fsync + rename before it died; read through the public
    // snapshot API to prove the post-crash file is a complete JSON value rather than a torn one.
    assert_eq!(
        read_snapshot(repo.path(), "state/atomic-crash.json")
            .unwrap()
            .unwrap()["generation"],
        "new"
    );
    write_snapshot(
        repo.path(),
        "state/atomic-crash.json",
        serde_json::json!({"generation": "recovered"}),
    )
    .unwrap();
    assert_eq!(
        read_snapshot(repo.path(), "state/atomic-crash.json")
            .unwrap()
            .unwrap()["generation"],
        "recovered"
    );
}

#[cfg(feature = "test-failpoints")]
#[test]
fn killed_writer_during_task_snapshot_transition_leaves_a_complete_resumable_task() {
    let repo = repo();
    let initialized = init(repo.path(), InitOptions::default()).unwrap();
    let task = start_task(
        repo.path(),
        "crash during task state transition",
        contract(),
    )
    .unwrap();

    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "crash_child_during_task_snapshot_transition",
            "--nocapture",
        ])
        .env("ICARUS_TEST_CRASH_REPO", repo.path())
        .env("ICARUS_TEST_CRASH_TASK", &task.task_id)
        .env("ICARUS_TEST_CRASH_POINT", "atomic-after-rename:task.json")
        .status()
        .unwrap();
    assert!(!child.success(), "crash child unexpectedly succeeded");

    // This passes through the public parser, validates its immutable contract binding, and then
    // writes the next transition. It proves a process death cannot leave a torn task state that
    // makes a governed task permanently unreadable or unresumable.
    assert_eq!(
        task_status(repo.path(), &task.task_id).unwrap().status,
        "orienting"
    );
    assert_eq!(
        transition_task(repo.path(), &task.task_id, "contracted")
            .unwrap()
            .status,
        "contracted"
    );
    let events = fs::read_to_string(repo.path().join(".icarus/runtime/logs/events.jsonl")).unwrap();
    assert!(events.contains("task_transition_recovered"));
    assert!(
        verify_event_chain(repo.path(), &initialized.manifest.repo_id)
            .unwrap()
            .valid
    );
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

fn initialized_git_repo() -> tempfile::TempDir {
    let repo = repo();
    fs::remove_file(repo.path().join(".git")).unwrap();
    for args in [
        vec!["init", "-q"],
        vec!["config", "user.email", "test@example.invalid"],
        vec!["config", "user.name", "test"],
    ] {
        assert!(Command::new("git")
            .args(args)
            .current_dir(repo.path())
            .status()
            .unwrap()
            .success());
    }
    fs::create_dir_all(repo.path().join("src")).unwrap();
    fs::write(repo.path().join("src/lib.rs"), "pub fn before() {}\n").unwrap();
    fs::write(repo.path().join("README.md"), "documented baseline\n").unwrap();
    assert!(Command::new("git")
        .args(["add", "."])
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
    assert!(Command::new("git")
        .args(["add", ".icarus", ".gitignore"])
        .current_dir(repo.path())
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-qm", "initialize harness"])
        .current_dir(repo.path())
        .status()
        .unwrap()
        .success());
    repo
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
fn fresh_process_resume_preserves_every_nonterminal_lifecycle_phase() {
    // `resume_task` deliberately reconstructs authority from files rather than a process-local
    // cache. Exercise every recoverable phase so a crash cannot turn an in-flight governed task
    // into an implicit terminal state or silently lose its immutable contract/execution link.
    let repo = repo();
    let initialized = init(repo.path(), InitOptions::default()).unwrap();
    let cases: &[(&str, &[&str])] = &[
        ("created", &[]),
        ("orienting", &["orienting"]),
        ("contracted", &["orienting", "contracted"]),
        ("planned", &["orienting", "contracted", "planned"]),
        (
            "executing",
            &["orienting", "contracted", "planned", "executing"],
        ),
        (
            "verifying",
            &[
                "orienting",
                "contracted",
                "planned",
                "executing",
                "verifying",
            ],
        ),
        (
            "waiting_for_approval",
            &["orienting", "contracted", "planned", "waiting_for_approval"],
        ),
        (
            "blocked",
            &["orienting", "contracted", "planned", "blocked"],
        ),
    ];

    for (expected_status, transitions) in cases {
        let task = start_task(
            repo.path(),
            format!("recover {expected_status}"),
            contract(),
        )
        .unwrap();
        for target in *transitions {
            transition_task(repo.path(), &task.task_id, target).unwrap();
        }
        assert_eq!(
            task_status(repo.path(), &task.task_id).unwrap().status,
            *expected_status
        );

        // Calling the public resume entrypoint after persisting the state is equivalent to a
        // new launcher process: it receives only repo path + task id and reloads runtime files.
        let resumed = resume_task(repo.path(), &task.task_id).unwrap();
        assert_eq!(resumed.task_id, task.task_id);
        assert_eq!(resumed.status, *expected_status);
        assert_ne!(resumed.execution_id, task.execution_id);
        assert_eq!(
            resumed.previous_execution_id.as_deref(),
            Some(task.execution_id.as_str())
        );
        assert_eq!(task_status(repo.path(), &task.task_id).unwrap(), resumed);
    }
    assert!(
        verify_event_chain(repo.path(), &initialized.manifest.repo_id)
            .unwrap()
            .valid
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
fn launcher_lifecycle_receipts_are_bound_to_the_prepared_execution() {
    let repo = repo();
    let initialized = init(repo.path(), InitOptions::default()).unwrap();
    let task = start_task(repo.path(), "observe adapter lifecycle", contract()).unwrap();
    for state in ["orienting", "contracted", "planned"] {
        transition_task(repo.path(), &task.task_id, state).unwrap();
    }
    prepare_run(
        repo.path(),
        &task.task_id,
        "codex".into(),
        "current".into(),
        false,
    )
    .unwrap();
    assert!(
        record_adapter_lifecycle(repo.path(), &task.task_id, "adapter_session_started", None,)
            .is_err()
    );
    transition_task(repo.path(), &task.task_id, "executing").unwrap();
    let started =
        record_adapter_lifecycle(repo.path(), &task.task_id, "adapter_session_started", None)
            .unwrap();
    assert_eq!(started.agent, "codex");
    assert_eq!(started.worktree_id, "current");
    let handoff = handoff_managed_task(repo.path(), &task.task_id).unwrap();
    assert_eq!(handoff.status, "verifying");
    assert_eq!(
        task_status(repo.path(), &task.task_id).unwrap().status,
        "verifying"
    );
    assert!(handoff.event_sequence > started.event_sequence);
    assert!(handoff_managed_task(repo.path(), &task.task_id).is_err());
    let stopped =
        record_adapter_lifecycle(repo.path(), &task.task_id, "adapter_stop_observed", None)
            .unwrap();
    assert!(stopped.event_sequence > handoff.event_sequence);
    let ended =
        record_adapter_lifecycle(repo.path(), &task.task_id, "adapter_session_ended", Some(0))
            .unwrap();
    assert!(ended.event_sequence > stopped.event_sequence);
    assert!(
        record_adapter_lifecycle(repo.path(), &task.task_id, "adapter_stop_observed", Some(0),)
            .is_err()
    );
    assert!(
        record_adapter_lifecycle(repo.path(), &task.task_id, "untrusted_agent_event", None,)
            .is_err()
    );
    assert!(
        verify_event_chain(repo.path(), &initialized.manifest.repo_id)
            .unwrap()
            .valid
    );
    let events = fs::read_to_string(repo.path().join(".icarus/runtime/logs/events.jsonl")).unwrap();
    assert!(events.contains("managed_task_handed_off"));
    assert!(events.contains("agent_requested_verification"));
}

#[test]
fn codex_app_server_thread_and_approval_boundaries_are_rust_owned_and_fail_closed() {
    let repo = repo();
    let initialized = init(
        repo.path(),
        InitOptions {
            agents: vec!["codex".into()],
        },
    )
    .unwrap();
    let task = start_task(repo.path(), "Codex protocol boundary", contract()).unwrap();
    for state in ["orienting", "contracted", "planned"] {
        transition_task(repo.path(), &task.task_id, state).unwrap();
    }
    prepare_run(
        repo.path(),
        &task.task_id,
        "codex".into(),
        "current".into(),
        false,
    )
    .unwrap();
    transition_task(repo.path(), &task.task_id, "executing").unwrap();

    let session = bind_codex_app_server_thread(repo.path(), &task.task_id, "thread-123").unwrap();
    assert_eq!(session.thread_id, "thread-123");
    assert_eq!(
        bind_codex_app_server_thread(repo.path(), &task.task_id, "thread-123")
            .unwrap()
            .execution_id,
        session.execution_id
    );
    assert!(bind_codex_app_server_thread(repo.path(), &task.task_id, "thread-other").is_err());

    let started = record_codex_app_server_event(
        repo.path(),
        &task.task_id,
        "turn/started",
        &serde_json::json!({"threadId": "thread-123", "turnId": "turn-1"}),
    )
    .unwrap();
    assert_eq!(started.thread_id, "thread-123");
    assert_eq!(started.turn_id.as_deref(), Some("turn-1"));
    let completed = record_codex_app_server_event(
        repo.path(),
        &task.task_id,
        "item/completed",
        &serde_json::json!({
            "threadId": "thread-123",
            "turnId": "turn-1",
            "item": {"id": "item-1", "type": "agentMessage"},
        }),
    )
    .unwrap();
    assert_eq!(completed.item_id.as_deref(), Some("item-1"));
    assert!(record_codex_app_server_event(
        repo.path(),
        &task.task_id,
        "item/started",
        &serde_json::json!({"threadId": "thread-other", "turnId": "turn-1", "item": {"id": "item-2"}}),
    )
    .is_err());

    let file_change = decide_codex_app_server_approval(
        repo.path(),
        &task.task_id,
        "item/fileChange/requestApproval",
        &serde_json::json!({"threadId": "thread-123", "turnId": "turn-1", "itemId": "item-1"}),
    )
    .unwrap();
    assert_eq!(file_change.decision, "decline");
    assert!(file_change.reason.contains("prior structured file-change"));
    record_codex_app_server_event(
        repo.path(),
        &task.task_id,
        "item/started",
        &serde_json::json!({
            "threadId": "thread-123",
            "turnId": "turn-1",
            "startedAtMs": 2,
            "item": {
                "id": "item-allowed",
                "type": "fileChange",
                "status": "inProgress",
                "changes": [{"path": "src/allowed.rs", "diff": "@@", "kind": {"type": "add"}}],
            },
        }),
    )
    .unwrap();
    let allowed_file_change = decide_codex_app_server_approval(
        repo.path(),
        &task.task_id,
        "item/fileChange/requestApproval",
        &serde_json::json!({"threadId": "thread-123", "turnId": "turn-1", "itemId": "item-allowed"}),
    )
    .unwrap();
    assert_eq!(allowed_file_change.decision, "accept");
    record_codex_app_server_event(
        repo.path(),
        &task.task_id,
        "item/completed",
        &serde_json::json!({
            "threadId": "thread-123",
            "turnId": "turn-1",
            "item": {
                "id": "item-allowed",
                "type": "fileChange",
                "status": "completed",
                "changes": [{"path": "src/allowed.rs", "diff": "@@", "kind": {"type": "add"}}],
            },
        }),
    )
    .unwrap();
    record_codex_app_server_event(
        repo.path(),
        &task.task_id,
        "item/started",
        &serde_json::json!({
            "threadId": "thread-123",
            "turnId": "turn-1",
            "startedAtMs": 3,
            "item": {
                "id": "item-forbidden",
                "type": "fileChange",
                "status": "inProgress",
                "changes": [{"path": "README.md", "diff": "@@", "kind": {"type": "update"}}],
            },
        }),
    )
    .unwrap();
    assert_eq!(
        decide_codex_app_server_approval(
            repo.path(),
            &task.task_id,
            "item/fileChange/requestApproval",
            &serde_json::json!({"threadId": "thread-123", "turnId": "turn-1", "itemId": "item-forbidden"}),
        )
        .unwrap()
        .decision,
        "decline"
    );
    let command = decide_codex_app_server_approval(
        repo.path(),
        &task.task_id,
        "item/commandExecution/requestApproval",
        &serde_json::json!({"threadId": "thread-123", "turnId": "turn-1", "itemId": "item-2", "command": "echo unsafe"}),
    )
    .unwrap();
    assert_eq!(command.decision, "decline");
    assert!(command.event_sequence > file_change.event_sequence);
    assert!(decide_codex_app_server_approval(
        repo.path(),
        &task.task_id,
        "item/fileChange/requestApproval",
        &serde_json::json!({"threadId": "thread-other", "turnId": "turn-1", "itemId": "item-3"}),
    )
    .is_err());
    assert!(
        verify_event_chain(repo.path(), &initialized.manifest.repo_id)
            .unwrap()
            .valid
    );
    let events = fs::read_to_string(repo.path().join(".icarus/runtime/logs/events.jsonl")).unwrap();
    assert!(events.contains("codex_app_server_thread_bound"));
    assert!(events.contains("codex_app_server_turn_started"));
    assert!(events.contains("codex_app_server_approval_declined"));
    assert!(events.contains("codex_app_server_approval_authorized"));
}

#[cfg(unix)]
#[test]
fn rust_codex_app_server_bridge_binds_and_declines_without_a_model_or_network() {
    use std::os::unix::fs::PermissionsExt;

    let repo = repo();
    let initialized = init(
        repo.path(),
        InitOptions {
            agents: vec!["codex".into()],
        },
    )
    .unwrap();
    let task = start_task(repo.path(), "bridge fixture task", contract()).unwrap();
    for state in ["orienting", "contracted", "planned"] {
        transition_task(repo.path(), &task.task_id, state).unwrap();
    }
    prepare_run(
        repo.path(),
        &task.task_id,
        "codex".into(),
        "current".into(),
        false,
    )
    .unwrap();
    transition_task(repo.path(), &task.task_id, "executing").unwrap();

    let fake = repo.path().join("fake-codex-app-server.sh");
    fs::write(
        &fake,
        r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      echo '{"id":1,"result":{}}'
      ;;
    *'"method":"thread/start"'*)
      echo '{"method":"thread/started","params":{"thread":{"id":"thread-fixture"}}}'
      echo '{"id":2,"result":{"thread":{"id":"thread-fixture"}}}'
      ;;
    *'"method":"turn/start"'*)
      echo '{"id":3,"result":{"turn":{"id":"turn-fixture"}}}'
      echo '{"method":"item/started","params":{"threadId":"thread-fixture","turnId":"turn-fixture","item":{"id":"item-fixture","type":"fileChange","status":"inProgress","changes":[{"path":"src/fixture.rs","diff":"@@","kind":{"type":"add"}}]}}}'
      echo '{"id":90,"method":"item/fileChange/requestApproval","params":{"threadId":"thread-fixture","turnId":"turn-fixture","itemId":"item-fixture","startedAtMs":1}}'
      IFS= read -r approval
      case "$approval" in
        *'"decision":"accept"'*) ;;
        *) exit 91 ;;
      esac
      echo '{"method":"turn/started","params":{"threadId":"thread-fixture","turnId":"turn-fixture","startedAtMs":2}}'
      echo '{"method":"item/completed","params":{"threadId":"thread-fixture","turnId":"turn-fixture","completedAtMs":3,"item":{"id":"item-fixture","type":"fileChange","status":"completed","changes":[{"path":"src/fixture.rs","diff":"@@","kind":{"type":"add"}}]}}}'
      echo '{"method":"turn/completed","params":{"threadId":"thread-fixture","turn":{"id":"turn-fixture"}}}'
      exit 0
      ;;
  esac
done
exit 92
"#,
    )
    .unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o700)).unwrap();
    let binary = env!("CARGO_BIN_EXE_icarus-codex-bridge");
    let output = Command::new(binary)
        .args([
            "--repo",
            repo.path().to_str().unwrap(),
            "--task",
            &task.task_id,
            "--app-server",
            fake.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "bridge stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        verify_event_chain(repo.path(), &initialized.manifest.repo_id)
            .unwrap()
            .valid
    );
    let events = fs::read_to_string(repo.path().join(".icarus/runtime/logs/events.jsonl")).unwrap();
    assert!(events.contains("codex_app_server_thread_bound"));
    assert!(events.contains("codex_app_server_approval_authorized"));
    assert!(events.contains("codex_app_server_turn_completed"));
    assert!(events.contains("adapter_session_ended"));
}

#[test]
fn claude_pre_action_decisions_are_audited_for_both_allow_and_deny() {
    let repo = repo();
    let initialized = init(
        repo.path(),
        InitOptions {
            agents: vec!["claude".into()],
        },
    )
    .unwrap();
    let task = start_task(repo.path(), "audit hook decisions", contract()).unwrap();
    for state in ["orienting", "contracted", "planned"] {
        transition_task(repo.path(), &task.task_id, state).unwrap();
    }
    prepare_run(
        repo.path(),
        &task.task_id,
        "claude".into(),
        "current".into(),
        false,
    )
    .unwrap();
    transition_task(repo.path(), &task.task_id, "executing").unwrap();
    let allowed = authorize_adapter_write(
        repo.path(),
        &task.task_id,
        "claude",
        "Edit",
        "src/allowed.rs",
    )
    .unwrap();
    assert!(allowed.allowed);
    let denied =
        authorize_adapter_write(repo.path(), &task.task_id, "claude", "Write", "README.md")
            .unwrap();
    assert!(!denied.allowed);
    assert!(denied.event_sequence > allowed.event_sequence);
    let denial_id = denied.denial_id.as_deref().unwrap();
    let explanation = icarus_harness::explain_policy_denial(repo.path(), denial_id).unwrap();
    assert_eq!(explanation.reason, denied.reason);
    assert_eq!(explanation.path, "README.md");
    assert_eq!(explanation.event_sequence, denied.event_sequence);
    assert!(icarus_harness::explain_policy_denial(repo.path(), "DENIAL-not-real").is_err());
    assert!(
        authorize_adapter_write(repo.path(), &task.task_id, "codex", "Write", "src/other.rs",)
            .is_err()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        fs::create_dir_all(repo.path().join("src")).unwrap();
        let outside = repo.path().parent().unwrap().join("outside-hook-target.rs");
        fs::write(&outside, "outside\n").unwrap();
        symlink(&outside, repo.path().join("src/escaped.rs")).unwrap();
        assert!(authorize_adapter_write(
            repo.path(),
            &task.task_id,
            "claude",
            "Edit",
            "src/escaped.rs",
        )
        .is_err());
    }
    assert!(
        verify_event_chain(repo.path(), &initialized.manifest.repo_id)
            .unwrap()
            .valid
    );
    let events = fs::read_to_string(repo.path().join(".icarus/runtime/logs/events.jsonl")).unwrap();
    assert!(events.contains("adapter_pre_action_authorized"));
    assert!(events.contains("adapter_pre_action_denied"));
}

#[test]
fn claude_post_action_receipts_are_bound_and_path_validated_in_rust() {
    let repo = repo();
    let initialized = init(
        repo.path(),
        InitOptions {
            agents: vec!["claude".into()],
        },
    )
    .unwrap();
    let task = start_task(repo.path(), "capture completed Claude writes", contract()).unwrap();
    for state in ["orienting", "contracted", "planned"] {
        transition_task(repo.path(), &task.task_id, state).unwrap();
    }
    prepare_run(
        repo.path(),
        &task.task_id,
        "claude".into(),
        "current".into(),
        false,
    )
    .unwrap();
    transition_task(repo.path(), &task.task_id, "executing").unwrap();
    let observed = record_adapter_post_action(
        repo.path(),
        &task.task_id,
        "claude",
        "Write",
        "src/allowed.rs",
    )
    .unwrap();
    assert_eq!(observed.agent, "claude");
    assert_eq!(observed.tool_name, "Write");
    assert_eq!(observed.path, "src/allowed.rs");
    assert!(record_adapter_post_action(
        repo.path(),
        &task.task_id,
        "codex",
        "Write",
        "src/allowed.rs",
    )
    .is_err());
    assert!(record_adapter_post_action(
        repo.path(),
        &task.task_id,
        "claude",
        "Bash",
        "src/allowed.rs",
    )
    .is_err());
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        fs::create_dir_all(repo.path().join("src")).unwrap();
        let outside = repo
            .path()
            .parent()
            .unwrap()
            .join("outside-post-hook-target.rs");
        fs::write(&outside, "outside\n").unwrap();
        symlink(&outside, repo.path().join("src/escaped.rs")).unwrap();
        assert!(record_adapter_post_action(
            repo.path(),
            &task.task_id,
            "claude",
            "Edit",
            "src/escaped.rs",
        )
        .is_err());
    }
    assert!(
        verify_event_chain(repo.path(), &initialized.manifest.repo_id)
            .unwrap()
            .valid
    );
    let events = fs::read_to_string(repo.path().join(".icarus/runtime/logs/events.jsonl")).unwrap();
    assert!(events.contains("adapter_post_action_observed"));
    assert!(events.contains("hook_post_action"));
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
        r#"{"state":"active","task_types":["code_change"],"file_patterns":["src/**"],"proof_expires_at":"2099-01-01T00:00:00Z","verification":{"status":"verified"},"instructions":"Run parser regression tests."}"#,
    )
    .unwrap();
    fs::write(
        repo.path().join(".icarus/skills/unverified.json"),
        r#"{"state":"proposed","task_types":["code_change"],"file_patterns":["src/**"],"verification":{"status":"unverified"},"instructions":"Must not enter context."}"#,
    )
    .unwrap();
    fs::write(
        repo.path().join(".icarus/skills/unscoped.json"),
        r#"{"state":"active","verification":{"status":"verified"},"instructions":"Must not enter context without an explicit scope."}"#,
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
            agents: vec!["claude".into(), "codex".into()],
        },
    )
    .unwrap();
    assert!(Command::new("git")
        .args(["add", "."])
        .current_dir(repo.path())
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-qm", "initialize harness"])
        .current_dir(repo.path())
        .status()
        .unwrap()
        .success());
    let task = start_task(repo.path(), "managed run", contract()).unwrap();
    for state in ["orienting", "contracted", "planned"] {
        transition_task(repo.path(), &task.task_id, state).unwrap();
    }
    fs::write(repo.path().join("README.md"), "dirty fixture\n").unwrap();
    assert!(prepare_run(
        repo.path(),
        &task.task_id,
        "codex".into(),
        "current".into(),
        false
    )
    .is_err());
    fs::write(repo.path().join("README.md"), "fixture\n").unwrap();
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
    let deadline = prepared
        .wall_time_deadline
        .as_deref()
        .expect("contract wall-time budget creates a Rust-owned deadline");
    assert!(
        time::OffsetDateTime::parse(deadline, &time::format_description::well_known::Rfc3339)
            .is_ok()
    );
    assert!(!prepared.capabilities.pre_action_authorization);
    assert!(prepared
        .launch_arguments
        .windows(2)
        .any(|pair| pair == ["--cd", prepared.workspace_path.as_str()]));
    assert!(prepared
        .launch_arguments
        .windows(2)
        .any(|pair| pair == ["--sandbox", "workspace-write"]));
    assert!(prepared
        .launch_arguments
        .iter()
        .any(|argument| argument == "--strict-config"));
    assert!(prepared
        .launch_arguments
        .iter()
        .any(|argument| argument == "mcp_servers.icarus.command=\"icarus\""));
    assert!(prepared.launch_arguments.iter().any(|argument| {
        argument.starts_with("developer_instructions=") && argument.contains(&task.task_id)
    }));
    assert!(std::path::Path::new(&prepared.workspace_path)
        .join("README.md")
        .exists());
    let launch_context = std::path::Path::new(&prepared.context_pack_path);
    assert!(launch_context.exists());
    let rendered_context = fs::read_to_string(launch_context).unwrap();
    assert!(rendered_context.contains("# ICARUS context pack"));
    assert!(rendered_context.contains(&task.task_id));
    assert_eq!(prepared.context_pack_hash.len(), 64);
    let claude_prepared = prepare_run(
        repo.path(),
        &task.task_id,
        "claude".into(),
        "isolated".into(),
        false,
    )
    .unwrap();
    assert_eq!(claude_prepared.certification, "compatibility");
    assert_eq!(claude_prepared.adapter_config_paths.len(), 1);
    let mcp_config = std::path::Path::new(&claude_prepared.adapter_config_paths[0]);
    let mcp: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(mcp_config).unwrap()).unwrap();
    assert_eq!(mcp["mcpServers"]["icarus"]["command"], "icarus");
    assert_eq!(
        mcp["mcpServers"]["icarus"]["args"],
        serde_json::json!(["mcp", "serve"])
    );
    assert!(claude_prepared.launch_arguments.windows(2).any(|pair| {
        pair[0] == "--mcp-config" && pair[1] == claude_prepared.adapter_config_paths[0]
    }));
    assert!(claude_prepared
        .launch_arguments
        .iter()
        .any(|argument| argument == "--strict-mcp-config"));
    let settings_path = claude_prepared
        .adapter_settings_path
        .as_ref()
        .expect("Claude receives a task-scoped hook settings file");
    let settings: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(settings_path).unwrap()).unwrap();
    assert_eq!(settings["disableAllHooks"], false);
    assert_eq!(settings["hooks"]["PreToolUse"][0]["matcher"], "Edit|Write");
    assert!(settings["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap()
        .contains(&task.task_id));
    assert_eq!(settings["hooks"]["PostToolUse"][0]["matcher"], "Edit|Write");
    assert!(settings["hooks"]["PostToolUse"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap()
        .contains("--event post-tool"));
    assert!(settings["hooks"]["Stop"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap()
        .contains("--event stop"));
    assert!(claude_prepared
        .launch_arguments
        .windows(2)
        .any(|pair| { pair[0] == "--settings" && pair[1] == *settings_path }));
    assert!(repo
        .path()
        .join(".icarus/runtime/context")
        .join(&task.task_id)
        .join(format!("{}.json", prepared.execution_id))
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
fn wall_time_budget_is_validated_before_task_creation() {
    let repo = repo();
    init(repo.path(), InitOptions::default()).unwrap();
    let mut invalid = contract();
    invalid.budgets = serde_json::json!({"wall_time_minutes": 0});
    let error = start_task(repo.path(), "invalid zero budget", invalid).unwrap_err();
    assert!(error.to_string().contains("wall_time_minutes"));

    let mut fractional = contract();
    fractional.budgets = serde_json::json!({"wall_time_minutes": 1.5});
    let error = start_task(repo.path(), "invalid fractional budget", fractional).unwrap_err();
    assert!(error.to_string().contains("wall_time_minutes"));

    let mut non_object = contract();
    non_object.budgets = serde_json::json!("unbounded");
    let error = start_task(repo.path(), "invalid budget shape", non_object).unwrap_err();
    assert!(error.to_string().contains("budgets"));
}

#[test]
fn expired_rust_owned_wall_time_deadline_blocks_adapter_start_and_handoff() {
    let repo = repo();
    init(repo.path(), InitOptions::default()).unwrap();
    let task = start_task(repo.path(), "expired managed deadline", contract()).unwrap();
    for state in ["orienting", "contracted", "planned"] {
        transition_task(repo.path(), &task.task_id, state).unwrap();
    }
    prepare_run(
        repo.path(),
        &task.task_id,
        "claude".into(),
        "current".into(),
        false,
    )
    .unwrap();
    let snapshot_path = format!("state/run-{}.json", task.task_id);
    let mut snapshot = read_snapshot(repo.path(), &snapshot_path).unwrap().unwrap();
    snapshot["wall_time_deadline"] = serde_json::json!("1970-01-01T00:00:00Z");
    write_snapshot(repo.path(), &snapshot_path, snapshot).unwrap();
    transition_task(repo.path(), &task.task_id, "executing").unwrap();

    let start_error =
        record_adapter_lifecycle(repo.path(), &task.task_id, "adapter_session_started", None)
            .unwrap_err();
    assert!(start_error.to_string().contains("wall-time budget expired"));
    let handoff_error = handoff_managed_task(repo.path(), &task.task_id).unwrap_err();
    assert!(handoff_error
        .to_string()
        .contains("wall-time budget expired"));
}

#[test]
fn isolated_run_reconciliation_imports_only_contract_scoped_regular_files() {
    let repo = repo();
    fs::remove_file(repo.path().join(".git")).unwrap();
    for args in [
        vec!["init", "-q"],
        vec!["config", "user.email", "test@example.invalid"],
        vec!["config", "user.name", "test"],
    ] {
        assert!(Command::new("git")
            .args(args)
            .current_dir(repo.path())
            .status()
            .unwrap()
            .success());
    }
    fs::create_dir_all(repo.path().join("src")).unwrap();
    fs::write(repo.path().join("src/lib.rs"), "pub fn before() {}\n").unwrap();
    assert!(Command::new("git")
        .args(["add", "."])
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
    assert!(Command::new("git")
        .args(["add", "."])
        .current_dir(repo.path())
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-qm", "initialize harness"])
        .current_dir(repo.path())
        .status()
        .unwrap()
        .success());
    let task = start_task(repo.path(), "change the library safely", contract()).unwrap();
    for state in ["orienting", "contracted", "planned"] {
        transition_task(repo.path(), &task.task_id, state).unwrap();
    }
    let prepared = prepare_run(
        repo.path(),
        &task.task_id,
        "codex".into(),
        "isolated".into(),
        false,
    )
    .unwrap();
    let workspace = std::path::Path::new(&prepared.workspace_path);
    fs::write(workspace.join("src/lib.rs"), "pub fn after() {}\n").unwrap();
    fs::write(workspace.join("src/new.rs"), "pub fn new_file() {}\n").unwrap();
    fs::write(workspace.join("README.md"), "out of contract\n").unwrap();
    transition_task(repo.path(), &task.task_id, "executing").unwrap();

    assert!(reconcile_run(repo.path(), &task.task_id).is_err());
    assert_eq!(
        fs::read_to_string(repo.path().join("src/lib.rs")).unwrap(),
        "pub fn before() {}\n"
    );
    assert!(!repo.path().join("src/new.rs").exists());
    fs::remove_file(workspace.join("README.md")).unwrap();

    let result = reconcile_run(repo.path(), &task.task_id).unwrap();
    assert!(result.reconciled);
    assert_eq!(result.changed_files, vec!["src/lib.rs", "src/new.rs"]);
    assert!(result.patch_digest.is_some());
    assert_eq!(
        fs::read_to_string(repo.path().join("src/lib.rs")).unwrap(),
        "pub fn after() {}\n"
    );
    assert_eq!(
        fs::read_to_string(repo.path().join("src/new.rs")).unwrap(),
        "pub fn new_file() {}\n"
    );
    assert!(Command::new("git")
        .args(["worktree", "remove", "--force", &prepared.workspace_path])
        .current_dir(repo.path())
        .status()
        .unwrap()
        .success());
}

#[test]
fn current_workspace_reconciliation_preserves_baseline_and_blocks_scope_escape() {
    let repo = initialized_git_repo();
    // This is user work that predates the managed run and is deliberately outside the contract.
    fs::write(repo.path().join("README.md"), "user draft before launch\n").unwrap();
    let task = start_task(repo.path(), "change only the library", contract()).unwrap();
    for state in ["orienting", "contracted", "planned"] {
        transition_task(repo.path(), &task.task_id, state).unwrap();
    }
    let prepared = prepare_run(
        repo.path(),
        &task.task_id,
        "codex".into(),
        "current".into(),
        true,
    )
    .unwrap();
    assert!(prepared
        .current_workspace_baseline
        .contains_key("README.md"));
    transition_task(repo.path(), &task.task_id, "executing").unwrap();
    fs::write(repo.path().join("src/lib.rs"), "pub fn after() {}\n").unwrap();
    let result = reconcile_run(repo.path(), &task.task_id).unwrap();
    assert!(!result.reconciled);
    assert_eq!(result.changed_files, vec!["src/lib.rs"]);
    assert!(result.patch_digest.is_some());

    let second = start_task(repo.path(), "must not touch documentation", contract()).unwrap();
    for state in ["orienting", "contracted", "planned"] {
        transition_task(repo.path(), &second.task_id, state).unwrap();
    }
    prepare_run(
        repo.path(),
        &second.task_id,
        "codex".into(),
        "current".into(),
        true,
    )
    .unwrap();
    transition_task(repo.path(), &second.task_id, "executing").unwrap();
    fs::write(
        repo.path().join("README.md"),
        "adapter changed user draft\n",
    )
    .unwrap();
    let error = reconcile_run(repo.path(), &second.task_id).unwrap_err();
    assert!(error.to_string().contains("outside the task contract"));
    let events = fs::read_to_string(repo.path().join(".icarus/runtime/logs/events.jsonl")).unwrap();
    assert!(events.contains("current_workspace_scope_checked"));
    assert!(events.contains("README.md"));
}

#[test]
fn seal_uses_nul_delimited_git_paths_for_scope_enforcement() {
    let repo = initialized_git_repo();
    let mut no_receipt_contract = contract();
    no_receipt_contract.acceptance_criteria = serde_json::json!([]);
    let task = start_task(repo.path(), "do not modify secrets", no_receipt_contract).unwrap();
    for state in [
        "orienting",
        "contracted",
        "planned",
        "executing",
        "verifying",
    ] {
        transition_task(repo.path(), &task.task_id, state).unwrap();
    }
    // Porcelain's line-oriented representation quotes or splits this path. A NUL-delimited
    // collector must preserve it exactly before matching the forbidden `secrets/**` contract.
    let escaped_path = "secrets/owner\nnotes.txt";
    fs::create_dir_all(repo.path().join("secrets")).unwrap();
    fs::write(repo.path().join(escaped_path), "must not seal\n").unwrap();
    let result = seal_task(repo.path(), &task.task_id).unwrap();
    assert!(!result.sealed);
    assert!(result
        .issues
        .iter()
        .any(|issue| issue == &format!("out-of-scope changed file: {escaped_path}")));
}

#[test]
fn seal_checks_both_sides_of_a_git_rename() {
    let repo = initialized_git_repo();
    fs::create_dir_all(repo.path().join("secrets")).unwrap();
    fs::write(repo.path().join("secrets/owner.txt"), "protected\n").unwrap();
    assert!(Command::new("git")
        .args(["add", "secrets/owner.txt"])
        .current_dir(repo.path())
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args(["commit", "-qm", "add protected fixture"])
        .current_dir(repo.path())
        .status()
        .unwrap()
        .success());
    let mut no_receipt_contract = contract();
    no_receipt_contract.acceptance_criteria = serde_json::json!([]);
    let task = start_task(
        repo.path(),
        "rename only a permitted source file",
        no_receipt_contract,
    )
    .unwrap();
    for state in [
        "orienting",
        "contracted",
        "planned",
        "executing",
        "verifying",
    ] {
        transition_task(repo.path(), &task.task_id, state).unwrap();
    }
    // The destination matches `src/**`; the source is forbidden. Seal must inspect both
    // NUL-delimited paths in Git's rename record rather than accepting destination-only output.
    assert!(Command::new("git")
        .args(["mv", "secrets/owner.txt", "src/renamed-owner.txt"])
        .current_dir(repo.path())
        .status()
        .unwrap()
        .success());
    let result = seal_task(repo.path(), &task.task_id).unwrap();
    assert!(!result.sealed);
    assert!(result
        .issues
        .iter()
        .any(|issue| issue == "out-of-scope changed file: secrets/owner.txt"));
}

#[test]
fn agent_arguments_cannot_weaken_rust_selected_launch_controls() {
    assert!(validate_agent_arguments("codex", &["--model".into(), "gpt-5".into()]).is_ok());
    assert!(validate_agent_arguments("claude", &["--model".into(), "sonnet".into()]).is_ok());
    assert!(
        validate_agent_arguments("claude", &["--settings".into(), "unsafe.json".into()]).is_err()
    );
    assert!(validate_agent_arguments("codex", &["--sandbox=danger-full-access".into()]).is_err());
    assert!(validate_agent_arguments("codex", &["-sdanger-full-access".into()]).is_err());
    assert!(validate_agent_arguments(
        "codex",
        &[
            "--config".into(),
            "sandbox_mode=\"danger-full-access\"".into()
        ]
    )
    .is_err());
    assert!(
        validate_agent_arguments("codex", &["-cmcp_servers.evil.command=\"sh\"".into()]).is_err()
    );
    assert!(validate_agent_arguments("codex", &["--profile".into(), "unsafe".into()]).is_err());
    assert!(validate_agent_arguments(
        "codex",
        &["--dangerously-bypass-approvals-and-sandbox".into()]
    )
    .is_err());
    assert!(validate_agent_arguments(
        "claude",
        &["--permission-mode".into(), "bypassPermissions".into()]
    )
    .is_err());
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
fn sealed_task_export_is_receipt_bound_and_can_remove_sensitive_fields() {
    let repo = repo();
    init(repo.path(), InitOptions::default()).unwrap();
    fs::write(repo.path().join("README.md"), "exportable artifact\n").unwrap();
    let mut export_contract = contract();
    export_contract.acceptance_criteria = serde_json::json!([
        {"id":"artifact","type":"artifact","path":"README.md","required":true}
    ]);
    let task = start_task(
        repo.path(),
        "export a sensitive task objective",
        export_contract,
    )
    .unwrap();
    assert!(export_task(repo.path(), &task.task_id, true).is_err());
    for state in [
        "orienting",
        "contracted",
        "planned",
        "executing",
        "verifying",
    ] {
        transition_task(repo.path(), &task.task_id, state).unwrap();
    }
    verify_task_criterion(repo.path(), &task.task_id, "artifact").unwrap();
    assert!(seal_task(repo.path(), &task.task_id).unwrap().sealed);

    let full = export_task(repo.path(), &task.task_id, false).unwrap();
    assert_eq!(full.status, "sealed");
    assert_eq!(
        full.objective.as_deref(),
        Some("export a sensitive task objective")
    );
    assert!(full.final_receipt_path.is_some());
    assert_eq!(full.criteria[0]["criterion_id"], "artifact");
    assert_eq!(full.criteria[0]["artifacts"][0], "README.md");

    let redacted = export_task(repo.path(), &task.task_id, true).unwrap();
    assert!(redacted.objective.is_none());
    assert!(redacted.final_receipt_path.is_none());
    assert!(redacted.criteria[0].get("criterion_id").is_none());
    assert!(redacted.criteria[0].get("artifacts").is_none());
    assert!(redacted.criteria[0].get("output_excerpt").is_none());
    assert!(redacted.criteria[0].get("attestation").is_none());
    assert!(!redacted.criteria[0]["output_digest"]
        .as_str()
        .unwrap()
        .is_empty());
}

#[cfg(unix)]
#[test]
fn artifact_criteria_reject_symlink_escapes_before_recording_evidence() {
    let repo = repo();
    init(repo.path(), InitOptions::default()).unwrap();
    let mut artifact_contract = contract();
    artifact_contract.acceptance_criteria = serde_json::json!([
        {"id":"artifact","type":"artifact","path":"artifact-link","required":true}
    ]);
    let task = start_task(
        repo.path(),
        "verify only local artifacts",
        artifact_contract,
    )
    .unwrap();
    for state in [
        "orienting",
        "contracted",
        "planned",
        "executing",
        "verifying",
    ] {
        transition_task(repo.path(), &task.task_id, state).unwrap();
    }
    std::os::unix::fs::symlink("/tmp", repo.path().join("artifact-link")).unwrap();
    let error = verify_task_criterion(repo.path(), &task.task_id, "artifact").unwrap_err();
    assert!(error
        .to_string()
        .contains("adapter write path resolves outside the managed workspace"));
    assert!(!repo
        .path()
        .join(format!(
            ".icarus/runtime/evidence/{}/commands.jsonl",
            task.task_id
        ))
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
fn context_retrieves_task_relevant_committed_repo_local_amr_evidence() {
    let outer = tempdir().unwrap();
    let repo_path = outer.path().join("harness-recall-fixture");
    fs::create_dir_all(&repo_path).unwrap();
    fs::write(repo_path.join(".git"), "gitdir: fake\n").unwrap();
    init(&repo_path, InitOptions::default()).unwrap();
    let mut shard =
        mseg::Shard::open(&repo_path.join(".icarus/data"), "harness-recall-fixture", 4).unwrap();
    shard
        .segment()
        .insert(mseg::MemoryInput::new(
            "The orbital cache invalidation path is owned by src/cache.rs.",
            vec![0.0; 4],
        ))
        .unwrap();
    shard
        .segment()
        .insert(mseg::MemoryInput::new(
            "Unrelated expense policy evidence.",
            vec![0.0; 4],
        ))
        .unwrap();
    shard.segment().flush().unwrap();
    drop(shard);

    let task = start_task(&repo_path, "repair orbital cache invalidation", contract()).unwrap();
    let pack = build_context(&repo_path, &task.task_id, 20_000).unwrap();
    let recalled: Vec<_> = pack
        .items
        .iter()
        .filter(|item| item.kind == "local_memory_evidence")
        .collect();
    assert_eq!(recalled.len(), 1);
    assert!(recalled[0]
        .source
        .contains("harness-recall-fixture/shard.amr#slot-0"));
    assert!(recalled[0].content.contains("orbital cache invalidation"));
    assert!(recalled[0].retrieval_reason.contains("full-corpus BM25"));
}

#[test]
fn published_context_corpus_retains_required_evidence_and_halves_unbounded_startup_context() {
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("../../../docs/evals/context-corpus-v1.json")).unwrap();
    assert_eq!(corpus["schema_version"], 1);
    let cases = corpus["cases"].as_array().unwrap();
    assert!(
        cases.len() >= 3,
        "the public corpus needs diverse task cases"
    );

    for case in cases {
        let id = case["id"].as_str().unwrap();
        let objective = case["objective"].as_str().unwrap();
        let required_anchor = case["required_anchor"].as_str().unwrap();
        let irrelevant_count = case["irrelevant_count"].as_u64().unwrap() as usize;
        let irrelevant_template = case["irrelevant_template"].as_str().unwrap();
        let minimum_reduction = case["minimum_reduction"].as_f64().unwrap();

        let outer = tempdir().unwrap();
        let repo_path = outer.path().join(format!("context-eval-{id}"));
        fs::create_dir_all(&repo_path).unwrap();
        fs::write(repo_path.join(".git"), "gitdir: fake\n").unwrap();
        init(&repo_path, InitOptions::default()).unwrap();

        let mut documents = vec![format!(
            "{required_anchor}: authoritative repository evidence for {objective}."
        )];
        documents.extend((0..irrelevant_count).map(|index| {
            format!(
                "irrelevant-record-{index}: {}",
                irrelevant_template.repeat(8)
            )
        }));
        let local_org = format!("context-eval-{id}");
        let mut shard = mseg::Shard::open(&repo_path.join(".icarus/data"), &local_org, 4).unwrap();
        for document in &documents {
            shard
                .segment()
                .insert(mseg::MemoryInput::new(document, vec![0.0; 4]))
                .unwrap();
        }
        shard.segment().flush().unwrap();
        drop(shard);

        let task = start_task(&repo_path, objective, contract()).unwrap();
        let compiled = build_context(&repo_path, &task.task_id, 100_000).unwrap();
        assert!(
            compiled.items.iter().any(|item| {
                item.kind == "local_memory_evidence" && item.content.contains(required_anchor)
            }),
            "{id} dropped its required evidence anchor"
        );

        // The corpus baseline is deliberately transparent: it is the exact compiled pack with
        // every local evidence record injected, which models the old unbounded-startup approach.
        // It does not use a model-generated summary or a hand-picked token estimate.
        let mut unbounded = compiled.clone();
        unbounded.items.retain(|item| {
            item.kind != "local_memory_evidence" && item.kind != "local_memory_recall"
        });
        for (index, document) in documents.iter().enumerate() {
            unbounded.items.push(ContextItem {
                kind: "unbounded_local_memory_baseline".into(),
                source: format!(".icarus/data/{local_org}/shard.amr#slot-{index}"),
                digest: format!("baseline-{index}"),
                freshness: "committed snapshot".into(),
                authority: "repository-local AMR evidence".into(),
                retrieval_reason: "unbounded local-evidence startup baseline".into(),
                mandatory: false,
                content: document.clone(),
            });
        }
        let compiled_units = render_context_markdown(&compiled).len();
        let baseline_units = render_context_markdown(&unbounded).len();
        let reduction = 1.0 - compiled_units as f64 / baseline_units as f64;
        eprintln!(
            "context-corpus {id}: compiled={compiled_units} baseline={baseline_units} reduction={:.1}%",
            reduction * 100.0
        );
        assert!(
            reduction >= minimum_reduction,
            "{id} reduced startup context by {:.1}%, below the published {:.1}% gate ({} vs {} byte upper-bound units)",
            reduction * 100.0,
            minimum_reduction * 100.0,
            compiled_units,
            baseline_units,
        );
    }
}

#[test]
fn context_never_waits_for_or_bypasses_a_repo_local_shard_writer() {
    let outer = tempdir().unwrap();
    let repo_path = outer.path().join("harness-locked-recall");
    fs::create_dir_all(&repo_path).unwrap();
    fs::write(repo_path.join(".git"), "gitdir: fake\n").unwrap();
    init(&repo_path, InitOptions::default()).unwrap();
    let _writer =
        mseg::Shard::open(&repo_path.join(".icarus/data"), "harness-locked-recall", 4).unwrap();
    let task = start_task(&repo_path, "inspect local evidence", contract()).unwrap();

    let pack = build_context(&repo_path, &task.task_id, 20_000).unwrap();
    let recall_status = pack
        .items
        .iter()
        .find(|item| item.kind == "local_memory_recall")
        .unwrap();
    assert_eq!(recall_status.freshness, "unavailable");
    assert!(recall_status.content.contains("shard is busy"));
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
fn seal_rejects_an_unresolved_high_risk_until_a_later_checkpoint_clears_it() {
    let repo = repo();
    init(repo.path(), InitOptions::default()).unwrap();
    let mut high_risk_contract = contract();
    high_risk_contract.risk = "high security change".into();
    high_risk_contract.acceptance_criteria = serde_json::json!([
        {"id":"unit","type":"test","command":"printf 'pass\\n'","required":true}
    ]);
    let task = start_task(repo.path(), "guard a high-risk change", high_risk_contract).unwrap();
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
    checkpoint_task(
        repo.path(),
        &task.task_id,
        "risk_review",
        serde_json::json!({"open_risks":[{"id":"RISK-1","severity":"high"}]}),
    )
    .unwrap();
    let blocked = seal_task(repo.path(), &task.task_id).unwrap();
    assert!(!blocked.sealed);
    assert!(blocked.issues.iter().any(|issue| issue.contains("RISK-1")));
    checkpoint_task(
        repo.path(),
        &task.task_id,
        "risk_resolved",
        serde_json::json!({"open_risks":[]}),
    )
    .unwrap();
    assert!(seal_task(repo.path(), &task.task_id).unwrap().sealed);
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
        task_types: vec!["implementation".into()],
        file_patterns: vec!["src/**".into()],
        proof_expires_at: Some("2099-01-01T00:00:00Z".into()),
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

fn sealed_replay_task(repo: &std::path::Path, objective: &str, skill_id: &str) -> String {
    let mut replay_contract = contract();
    replay_contract.acceptance_criteria = serde_json::json!([
        {"id":"unit","type":"test","command":"printf 'skill replay pass\\n'","required":true}
    ]);
    let task = start_task(repo, objective, replay_contract).unwrap();
    for state in ["orienting", "contracted", "planned", "executing"] {
        transition_task(repo, &task.task_id, state).unwrap();
    }
    checkpoint_task(
        repo,
        &task.task_id,
        "skill_replay",
        serde_json::json!({"applied_skill_id": skill_id, "open_risks": []}),
    )
    .unwrap();
    transition_task(repo, &task.task_id, "verifying").unwrap();
    assert_eq!(
        verify_task_criterion(repo, &task.task_id, "unit")
            .unwrap()
            .status,
        "pass"
    );
    assert!(seal_task(repo, &task.task_id).unwrap().sealed);
    task.task_id
}

fn blocked_skill_task(
    repo: &std::path::Path,
    objective: &str,
    skill_id: &str,
    safety_violation: bool,
) -> String {
    let task = start_task(repo, objective, contract()).unwrap();
    for state in ["orienting", "contracted", "planned", "executing"] {
        transition_task(repo, &task.task_id, state).unwrap();
    }
    checkpoint_task(
        repo,
        &task.task_id,
        "skill_outcome",
        serde_json::json!({"applied_skill_id": skill_id, "safety_violation": safety_violation}),
    )
    .unwrap();
    transition_task(repo, &task.task_id, "blocked").unwrap();
    task.task_id
}

#[test]
fn low_risk_skill_promotion_requires_native_replay_evaluations_not_candidate_claims() {
    let repo = repo();
    init(repo.path(), InitOptions::default()).unwrap();
    let sources = vec![
        sealed_source_task(repo.path(), "source one"),
        sealed_source_task(repo.path(), "source two"),
        sealed_source_task(repo.path(), "source three"),
    ];
    let skill = HarnessSkill {
        schema_version: 0,
        id: "safe-review".into(),
        state: "active".into(),
        triggers: vec!["review".into()],
        instructions: "Run scoped checks and inspect their receipts.".into(),
        allowed_tools: vec!["shell".into()],
        policy_requirements: vec![],
        verification_steps: vec!["test".into()],
        source_tasks: sources,
        decision_references: vec![],
        task_types: vec!["implementation".into()],
        file_patterns: vec!["src/**".into()],
        proof_expires_at: Some("2099-01-01T00:00:00Z".into()),
        risk: "low".into(),
        owner: "owner".into(),
        version: 0,
        confidence: 1.0,
        replay_results: vec![
            serde_json::json!({"success":true}),
            serde_json::json!({"success":true}),
        ],
        verification: serde_json::Value::Null,
    };
    icarus_harness::propose_skill(repo.path(), skill).unwrap();
    assert!(icarus_harness::promote_skill(repo.path(), "safe-review", None).is_err());
    let replay_one = sealed_replay_task(repo.path(), "replay one", "safe-review");
    let replay_two = sealed_replay_task(repo.path(), "replay two", "safe-review");
    assert_eq!(
        evaluate_skill(repo.path(), "safe-review", &replay_one)
            .unwrap()
            .status,
        "pass"
    );
    assert_eq!(
        evaluate_skill(repo.path(), "safe-review", &replay_two)
            .unwrap()
            .status,
        "pass"
    );
    let active = icarus_harness::promote_skill(repo.path(), "safe-review", None).unwrap();
    assert_eq!(
        active.verification["promotion"]["successful_native_replay_count"],
        2
    );
    for index in 0..3 {
        let failed = blocked_skill_task(
            repo.path(),
            &format!("failed replay {index}"),
            "safe-review",
            false,
        );
        assert_eq!(
            record_active_skill_outcome(repo.path(), "safe-review", &failed)
                .unwrap()
                .status,
            "fail"
        );
    }
    let review = review_active_skills(repo.path()).unwrap();
    assert_eq!(review.demoted_skill_ids, vec!["safe-review"]);
    let demoted: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(repo.path().join(".icarus/skills/active/safe-review.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(demoted["state"], "demoted");
    assert!(repo
        .path()
        .join(".icarus/runtime/skills/demoted/safe-review-v1.json")
        .exists());
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
        task_types: vec!["implementation".into()],
        file_patterns: vec!["src/**".into()],
        proof_expires_at: Some("2099-01-01T00:00:00Z".into()),
        risk: "deploy".into(),
        owner: "owner".into(),
        version: 0,
        confidence: 1.0,
        replay_results: vec![],
        verification: serde_json::Value::Null,
    };
    icarus_harness::propose_skill(repo.path(), skill).unwrap();
    assert!(icarus_harness::promote_skill(repo.path(), "deploy-review", None).is_err());
    let replay = sealed_replay_task(repo.path(), "replay deployment review", "deploy-review");
    assert_eq!(
        icarus_harness::evaluate_skill(repo.path(), "deploy-review", &replay)
            .unwrap()
            .status,
        "pass"
    );
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
