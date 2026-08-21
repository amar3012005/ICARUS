//! mneme Node.js binding (napi-rs). Exposes the `.amr` engine as a drop-in vector store so
//! HIVEMIND's `indexer.js` can call it in place of Qdrant. Methods are synchronous over a
//! per-org shard held in the JS object; the JS wrapper (MnemeVectorStore) adapts them to the
//! async `upsert`/`search` interface HIVEMIND expects.

use icarus_harness as harness;
use mneme_bm25::{bm25_search, Bm25Doc, Bm25Params};
use mseg::{Filter, MemoryInput, Shard};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

/// Extract the record id from a stored JSON payload without a full JSON parse: the agent always
/// serializes `{"id":"<uuid>",...}` (or with the id elsewhere in the object) — find `"id":"` and
/// read to the closing quote. Cheap enough to run over every slot at open().
fn extract_id(text: &str) -> Option<&str> {
    let start = text.find("\"id\":\"")? + 6;
    let rest = &text[start..];
    let end = rest.find('"')?;
    Some(&rest[..end])
}

fn hash_id(id: &str) -> u64 {
    let mut h = DefaultHasher::new();
    id.hash(&mut h);
    h.finish()
}

fn harness_json(value: serde_json::Value) -> Result<String> {
    serde_json::to_string(&value).map_err(|error| Error::from_reason(error.to_string()))
}

/// Rust-backed ICARUS Harness bridge. The JavaScript CLI/TUI layer transports these values but
/// never owns the persistent policy, task, lock, or event semantics.
#[napi]
pub fn harness_init(repo_root: String, agents: Vec<String>) -> Result<String> {
    let result = harness::init(
        std::path::Path::new(&repo_root),
        harness::InitOptions { agents },
    )
    .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(serde_json::json!({
        "created": result.created,
        "manifest": result.manifest,
        "graph_migrated": result.graph_migrated,
    }))
}

#[napi]
pub fn harness_migrate(repo_root: String, dry_run: bool, agents: Vec<String>) -> Result<String> {
    let report = harness::migrate(
        std::path::Path::new(&repo_root),
        dry_run,
        harness::InitOptions { agents },
    )
    .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(report).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

#[napi]
pub fn harness_doctor(repo_root: String) -> Result<String> {
    let report = harness::doctor(std::path::Path::new(&repo_root))
        .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(serde_json::json!({
        "healthy": report.healthy,
        "repo_id": report.repo_id,
        "checks": report.checks.into_iter().map(|check| serde_json::json!({"id": check.id, "status": check.status, "detail": check.detail})).collect::<Vec<_>>(),
        "issues": report.issues,
    }))
}

/// Read and validate the repository policy in the Rust authority. The Node CLI/MCP layer may
/// display the result, but cannot parse YAML or decide whether an invalid policy is acceptable.
#[napi]
pub fn harness_policy_check(repo_root: String) -> Result<String> {
    let policy = harness::load_repository_policy(std::path::Path::new(&repo_root))
        .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(policy).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

/// Rust-derived repository identity for an optional authority transport.  Node never derives a
/// repo id from a mutable path or remote URL itself.
#[napi]
pub fn harness_repository_identity(repo_root: String) -> Result<String> {
    let manifest = harness::repository_identity(std::path::Path::new(&repo_root))
        .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(manifest).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

/// Read a durable Rust-recorded policy denial by id. The Node layer does not recreate policy
/// reasons from current files, because current policy can differ from the decision-time state.
#[napi]
pub fn harness_policy_explain(repo_root: String, denial_id: String) -> Result<String> {
    let denial = harness::explain_policy_denial(std::path::Path::new(&repo_root), &denial_id)
        .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(denial).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

#[napi]
pub fn harness_start_task(
    repo_root: String,
    objective: String,
    contract_json: String,
) -> Result<String> {
    let contract = serde_json::from_str(&contract_json)
        .map_err(|error| Error::from_reason(format!("invalid task contract JSON: {error}")))?;
    let task = harness::start_task(std::path::Path::new(&repo_root), objective, contract)
        .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(serde_json::to_value(task).map_err(|error| Error::from_reason(error.to_string()))?)
}

#[napi]
pub fn harness_task_status(repo_root: String, task_id: String) -> Result<String> {
    let task = harness::task_status(std::path::Path::new(&repo_root), &task_id)
        .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(serde_json::to_value(task).map_err(|error| Error::from_reason(error.to_string()))?)
}

#[napi]
pub fn harness_start_release_candidate_dogfood(
    repo_root: String,
    release_id: String,
) -> Result<String> {
    let dogfood =
        harness::start_release_candidate_dogfood(std::path::Path::new(&repo_root), &release_id)
            .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(dogfood).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

#[napi]
pub fn harness_release_candidate_dogfood_report(repo_root: String) -> Result<String> {
    let report = harness::release_candidate_dogfood_report(std::path::Path::new(&repo_root))
        .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(report).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

#[napi]
pub fn harness_attest_release_candidate_dogfood(
    repo_root: String,
    approval_id: String,
    approver: String,
) -> Result<String> {
    let dogfood = harness::attest_release_candidate_dogfood(
        std::path::Path::new(&repo_root),
        &approval_id,
        &approver,
    )
    .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(dogfood).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

#[napi]
pub fn harness_transition_task(
    repo_root: String,
    task_id: String,
    target: String,
) -> Result<String> {
    let task = harness::transition_task(std::path::Path::new(&repo_root), &task_id, &target)
        .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(serde_json::to_value(task).map_err(|error| Error::from_reason(error.to_string()))?)
}

#[napi]
pub fn harness_resume_task(repo_root: String, task_id: String) -> Result<String> {
    let task = harness::resume_task(std::path::Path::new(&repo_root), &task_id)
        .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(serde_json::to_value(task).map_err(|error| Error::from_reason(error.to_string()))?)
}

#[napi]
pub fn harness_prepare_run(
    repo_root: String,
    task_id: String,
    agent: String,
    workspace_mode: String,
    acknowledge_dirty_current: bool,
) -> Result<String> {
    let preparation = harness::prepare_run(
        std::path::Path::new(&repo_root),
        &task_id,
        agent,
        workspace_mode,
        acknowledge_dirty_current,
    )
    .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(preparation).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

#[napi]
pub fn harness_reconcile_run(repo_root: String, task_id: String) -> Result<String> {
    let result = harness::reconcile_run(std::path::Path::new(&repo_root), &task_id)
        .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(result).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

#[napi]
pub fn harness_validate_agent_arguments(agent: String, arguments_json: String) -> Result<()> {
    let arguments: Vec<String> = serde_json::from_str(&arguments_json)
        .map_err(|error| Error::from_reason(format!("invalid agent argument list: {error}")))?;
    harness::validate_agent_arguments(&agent, &arguments)
        .map_err(|error| Error::from_reason(error.to_string()))
}

#[napi]
pub fn harness_verify_task_criterion(
    repo_root: String,
    task_id: String,
    criterion_id: String,
) -> Result<String> {
    let receipt =
        harness::verify_task_criterion(std::path::Path::new(&repo_root), &task_id, &criterion_id)
            .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(receipt).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

#[napi]
pub fn harness_attest_task_criterion(
    repo_root: String,
    task_id: String,
    criterion_id: String,
    approval_id: String,
    approver: String,
    expires_at: Option<String>,
) -> Result<String> {
    let receipt = harness::attest_task_criterion(
        std::path::Path::new(&repo_root),
        &task_id,
        &criterion_id,
        &approval_id,
        &approver,
        expires_at,
    )
    .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(receipt).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

#[napi]
pub fn harness_seal_task(repo_root: String, task_id: String) -> Result<String> {
    let result = harness::seal_task(std::path::Path::new(&repo_root), &task_id)
        .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(result).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

#[napi]
pub fn harness_export_task(repo_root: String, task_id: String, redacted: bool) -> Result<String> {
    let receipt = harness::export_task(std::path::Path::new(&repo_root), &task_id, redacted)
        .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(receipt).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

/// Install a transport-authenticated authority snapshot.  JavaScript only carries the opaque
/// JSON document; Rust validates repository identity, scope, expiry, and digest before caching.
#[napi]
pub fn harness_install_authority_snapshot(
    repo_root: String,
    snapshot_json: String,
) -> Result<String> {
    let snapshot =
        harness::install_authority_snapshot(std::path::Path::new(&repo_root), &snapshot_json)
            .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(snapshot).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

#[napi]
pub fn harness_install_authority_snapshot_with_replacement(
    repo_root: String,
    snapshot_json: String,
    accept_replacement: bool,
) -> Result<String> {
    let snapshot = harness::install_authority_snapshot_with_replacement(
        std::path::Path::new(&repo_root),
        &snapshot_json,
        accept_replacement,
    )
    .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(snapshot).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

#[napi]
pub fn harness_inspect_authority_sync(repo_root: String) -> Result<String> {
    let inspection = harness::inspect_authority_sync(std::path::Path::new(&repo_root))
        .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(inspection).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

/// Build a redacted outbound bundle.  This method deliberately cannot issue an HTTP request or
/// receive a credential: network transport remains an explicit opt-in adapter boundary.
#[napi]
pub fn harness_build_authority_sync_request(
    repo_root: String,
    task_id: String,
    scope_json: String,
) -> Result<String> {
    let scope: harness::AuthorityScope = serde_json::from_str(&scope_json)
        .map_err(|error| Error::from_reason(format!("invalid authority scope JSON: {error}")))?;
    let request =
        harness::build_authority_sync_request(std::path::Path::new(&repo_root), &task_id, scope)
            .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(request).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

#[napi]
pub fn harness_propose_skill(repo_root: String, skill_json: String) -> Result<String> {
    let skill = serde_json::from_str(&skill_json)
        .map_err(|error| Error::from_reason(format!("invalid harness skill JSON: {error}")))?;
    let result = harness::propose_skill(std::path::Path::new(&repo_root), skill)
        .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(result).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

#[napi]
pub fn harness_evaluate_skill(
    repo_root: String,
    skill_id: String,
    replay_task_id: String,
    baseline_task_id: Option<String>,
) -> Result<String> {
    let evaluation = harness::evaluate_skill(
        std::path::Path::new(&repo_root),
        &skill_id,
        &replay_task_id,
        baseline_task_id.as_deref(),
    )
    .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(evaluation).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

#[napi]
pub fn harness_record_active_skill_outcome(
    repo_root: String,
    skill_id: String,
    task_id: String,
) -> Result<String> {
    let outcome =
        harness::record_active_skill_outcome(std::path::Path::new(&repo_root), &skill_id, &task_id)
            .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(outcome).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

#[napi]
pub fn harness_review_active_skills(repo_root: String) -> Result<String> {
    let review = harness::review_active_skills(std::path::Path::new(&repo_root))
        .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(review).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

#[napi]
pub fn harness_promote_skill(
    repo_root: String,
    skill_id: String,
    owner_approval: Option<String>,
) -> Result<String> {
    let result =
        harness::promote_skill(std::path::Path::new(&repo_root), &skill_id, owner_approval)
            .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(result).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

#[napi]
pub fn harness_retire_skill(
    repo_root: String,
    skill_id: String,
    reason: String,
    owner_approval: Option<String>,
) -> Result<String> {
    let result = harness::retire_skill(
        std::path::Path::new(&repo_root),
        &skill_id,
        &reason,
        owner_approval,
    )
    .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(result).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

#[napi]
pub fn harness_amend_task_contract(
    repo_root: String,
    task_id: String,
    contract_json: String,
    reason: String,
    approval_id: Option<String>,
) -> Result<String> {
    let contract = serde_json::from_str(&contract_json)
        .map_err(|error| Error::from_reason(format!("invalid task contract JSON: {error}")))?;
    let task = harness::amend_task_contract(
        std::path::Path::new(&repo_root),
        &task_id,
        contract,
        reason,
        approval_id,
    )
    .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(serde_json::to_value(task).map_err(|error| Error::from_reason(error.to_string()))?)
}

#[napi]
pub fn harness_checkpoint_task(
    repo_root: String,
    task_id: String,
    phase: String,
    input_json: String,
) -> Result<String> {
    let input = serde_json::from_str(&input_json)
        .map_err(|error| Error::from_reason(format!("invalid checkpoint input JSON: {error}")))?;
    let checkpoint =
        harness::checkpoint_task(std::path::Path::new(&repo_root), &task_id, phase, input)
            .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(checkpoint).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

#[napi]
pub fn harness_build_context(
    repo_root: String,
    task_id: String,
    budget_tokens: u32,
) -> Result<String> {
    let pack = harness::build_context(
        std::path::Path::new(&repo_root),
        &task_id,
        budget_tokens as usize,
    )
    .map_err(|error| Error::from_reason(error.to_string()))?;
    let markdown = harness::render_context_markdown(&pack);
    harness_json(serde_json::json!({"pack": pack, "markdown": markdown}))
}

#[napi]
pub fn harness_build_context_delta(
    repo_root: String,
    task_id: String,
    checkpoint_sequence: u32,
    budget_tokens: u32,
) -> Result<String> {
    let pack = harness::build_context_delta(
        std::path::Path::new(&repo_root),
        &task_id,
        checkpoint_sequence as u64,
        budget_tokens as usize,
    )
    .map_err(|error| Error::from_reason(error.to_string()))?;
    let markdown = harness::render_context_markdown(&pack);
    harness_json(serde_json::json!({"pack": pack, "markdown": markdown}))
}

#[napi]
pub fn harness_record_graph_receipt(
    repo_root: String,
    source_fingerprint: String,
) -> Result<String> {
    let receipt =
        harness::record_graph_receipt(std::path::Path::new(&repo_root), source_fingerprint)
            .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(receipt).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

/// Return the authoritative graph-source fingerprint. The JavaScript graph adapter uses this
/// rather than maintaining a second hashing implementation, so the fingerprint it stores and
/// the one Rust verifies can never drift because of traversal or ordering differences.
#[napi]
pub fn harness_graph_source_fingerprint(repo_root: String) -> Result<String> {
    let fingerprint = harness::graph_source_fingerprint(std::path::Path::new(&repo_root))
        .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(serde_json::json!(fingerprint))
}

#[napi]
pub fn harness_skill_authoring_brief(repo_root: String, task_id: String) -> Result<String> {
    let brief = harness::skill_authoring_brief(std::path::Path::new(&repo_root), &task_id)
        .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(brief).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

#[napi]
pub fn harness_authorize_action(
    repo_root: String,
    task_id: String,
    kind: String,
    path: Option<String>,
) -> Result<String> {
    let authorization = harness::authorize_action(
        std::path::Path::new(&repo_root),
        &task_id,
        harness::Action { kind, path },
    )
    .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::json!({"allowed": authorization.allowed, "reason": authorization.reason}),
    )
}

/// Authorize and audit a documented Claude Edit/Write PreToolUse event. The JavaScript hook
/// adapter transports only normalized fields; Rust verifies the prepared execution and appends
/// the resulting allow/deny decision itself.
#[napi]
pub fn harness_authorize_adapter_write(
    repo_root: String,
    task_id: String,
    agent: String,
    tool_name: String,
    path: String,
) -> Result<String> {
    let receipt = harness::authorize_adapter_write(
        std::path::Path::new(&repo_root),
        &task_id,
        &agent,
        &tool_name,
        &path,
    )
    .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(receipt).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

/// Record a typed Claude Edit/Write PostToolUse observation in the Rust audit chain. This is a
/// tool-boundary record only; it cannot substitute for an ICARUS verification receipt.
#[napi]
pub fn harness_record_adapter_post_action(
    repo_root: String,
    task_id: String,
    agent: String,
    tool_name: String,
    path: String,
) -> Result<String> {
    let receipt = harness::record_adapter_post_action(
        std::path::Path::new(&repo_root),
        &task_id,
        &agent,
        &tool_name,
        &path,
    )
    .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(receipt).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

/// Bind the stable thread returned by Codex app-server to a prepared Codex execution. Node may
/// transport the response, but the native harness persists and validates the binding.
#[napi]
pub fn harness_bind_codex_app_server_thread(
    repo_root: String,
    task_id: String,
    thread_id: String,
) -> Result<String> {
    let session = harness::bind_codex_app_server_thread(
        std::path::Path::new(&repo_root),
        &task_id,
        &thread_id,
    )
    .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(session).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

/// Record a bounded structured Codex app-server notification. The native core rejects unknown
/// event vocabularies and mismatched threads rather than accepting arbitrary JSON-RPC payloads.
#[napi]
pub fn harness_record_codex_app_server_event(
    repo_root: String,
    task_id: String,
    method: String,
    params_json: String,
) -> Result<String> {
    let params = serde_json::from_str(&params_json).map_err(|error| {
        Error::from_reason(format!("invalid Codex app-server params JSON: {error}"))
    })?;
    let receipt = harness::record_codex_app_server_event(
        std::path::Path::new(&repo_root),
        &task_id,
        &method,
        &params,
    )
    .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(receipt).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

/// Decide a Codex app-server approval request in Rust. Current decisions intentionally fail
/// closed until the protocol exposes canonical per-file write paths and a native command policy.
#[napi]
pub fn harness_decide_codex_app_server_approval(
    repo_root: String,
    task_id: String,
    method: String,
    params_json: String,
) -> Result<String> {
    let params = serde_json::from_str(&params_json).map_err(|error| {
        Error::from_reason(format!("invalid Codex app-server params JSON: {error}"))
    })?;
    let decision = harness::decide_codex_app_server_approval(
        std::path::Path::new(&repo_root),
        &task_id,
        &method,
        &params,
    )
    .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(decision).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

/// Execute one governed Codex app-server turn inside the Rust native addon. This is synchronous
/// by design: JavaScript only invokes the native bridge and then performs its usual post-run
/// reconciliation; it never parses app-server events or decides an approval.
#[napi]
pub fn harness_run_codex_app_server(
    repo_root: String,
    task_id: String,
    prompt: Option<String>,
) -> Result<String> {
    harness::run_codex_app_server_bridge(
        std::path::Path::new(&repo_root),
        &task_id,
        prompt.as_deref(),
    )
    .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(serde_json::json!({"completed": true}))
}

/// Hand a prepared managed execution to ICARUS verification. This does not accept an agent
/// result or seal a task; it only records the durable execution-to-verification boundary.
#[napi]
pub fn harness_handoff_managed_task(repo_root: String, task_id: String) -> Result<String> {
    let receipt = harness::handoff_managed_task(std::path::Path::new(&repo_root), &task_id)
        .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(receipt).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

/// Record a typed adapter process boundary observed by the local managed launcher. This bridge
/// exposes no arbitrary event payload: only Rust's bounded lifecycle receipt can enter the audit
/// chain, so a presentation client cannot turn model prose into trusted execution evidence.
#[napi]
pub fn harness_record_adapter_lifecycle(
    repo_root: String,
    task_id: String,
    event_type: String,
    exit_code: Option<i32>,
) -> Result<String> {
    let receipt = harness::record_adapter_lifecycle(
        std::path::Path::new(&repo_root),
        &task_id,
        &event_type,
        exit_code,
    )
    .map_err(|error| Error::from_reason(error.to_string()))?;
    harness_json(
        serde_json::to_value(receipt).map_err(|error| Error::from_reason(error.to_string()))?,
    )
}

/// One recall hit returned to JS.
#[napi(object)]
pub struct MnemeHit {
    pub slot_id: u32,
    pub score: f64,
    pub text: String,
}

/// One stored record: slot id + its full-record text payload. Used by the Prisma adapter's loader
/// to hydrate every memory from `.amr` on open (Path B — `.amr` as the relational store).
#[napi(object)]
pub struct RecordRow {
    pub slot_id: u32,
    pub text: String,
}

/// One typed edge from a slot: target slot, edge type, weight. The relationship backend reads these
/// back to reconstruct relationship records from the `.amr` graph.
#[napi(object)]
pub struct EdgeRow {
    pub target: u32,
    pub edge_type: u8,
    pub weight: u8,
}

/// One page of a streaming record scan: the live records found plus the slot to resume from
/// (`next_slot` == u32::MAX when the scan is complete). Replaces all-at-once `all_records()`
/// for large shards — the caller never materializes the whole store in JS heap.
#[napi(object)]
pub struct RecordPage {
    pub rows: Vec<RecordRow>,
    pub next_slot: u32,
}

/// A per-org mneme store (wraps one `.amr` shard).
///
/// Holds a native id→slot index (u64 hash of the record's JSON `id` → candidate slots) so JS
/// never needs an in-heap Map of every record — the index costs ~24 bytes/record in Rust
/// (no GC pressure) vs ~1-2KB/record for parsed JS objects, which was the scale wall.
#[napi]
pub struct MnemeStore {
    shard: Shard,
    dim: usize,
    id_index: HashMap<u64, Vec<u32>>,
}

#[napi]
impl MnemeStore {
    /// Open (or create) the shard for `org_id` under `data_root` with embedding dimension `dim`.
    /// Builds the id→slot index with one mmap scan of live slots.
    #[napi(factory)]
    pub fn open(data_root: String, org_id: String, dim: u32) -> Result<Self> {
        let shard = Shard::open(&PathBuf::from(data_root), &org_id, dim as usize)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let mut store = MnemeStore {
            shard,
            dim: dim as usize,
            id_index: HashMap::new(),
        };
        store.rebuild_id_index()?;
        Ok(store)
    }

    fn rebuild_id_index(&mut self) -> Result<()> {
        self.id_index.clear();
        let seg = self.shard.segment();
        let n = seg.slot_count();
        for idx in 0..n {
            if let Ok(hit) = seg.get(idx) {
                if let Some(id) = extract_id(&hit.text) {
                    let h = hash_id(id);
                    self.id_index.entry(h).or_default().push(idx);
                }
            }
        }
        Ok(())
    }

    fn index_add(&mut self, text: &str, slot: u32) {
        if let Some(id) = extract_id(text) {
            let h = hash_id(id);
            let v = self.id_index.entry(h).or_default();
            if !v.contains(&slot) {
                v.push(slot);
            }
        }
    }

    fn index_remove_slot(&mut self, slot: u32) {
        // Read the slot's text to find its id (cheap single-slot read), then unlink.
        if let Ok(hit) = self.shard.segment().get(slot) {
            if let Some(id) = extract_id(&hit.text) {
                let h = hash_id(id);
                if let Some(v) = self.id_index.get_mut(&h) {
                    v.retain(|s| *s != slot);
                    if v.is_empty() {
                        self.id_index.remove(&h);
                    }
                }
            }
        }
    }

    /// Insert a memory (text + embedding). `valid_from` is nanoseconds (0 = unspecified).
    /// Returns the stable slot id.
    #[napi]
    pub fn insert(&mut self, text: String, vector: Float32Array, valid_from: i64) -> Result<u32> {
        let v: Vec<f32> = vector.to_vec();
        if v.len() != self.dim {
            return Err(Error::from_reason(format!(
                "vector dim {} != store dim {}",
                v.len(),
                self.dim
            )));
        }
        let mut m = MemoryInput::new(text.clone(), v);
        m.valid_from = valid_from;
        let slot = self
            .shard
            .segment()
            .insert(m)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        self.index_add(&text, slot);
        Ok(slot)
    }

    /// Insert tagged with a layer (0=memory, 1=evidence, 2=cognitive). Lets one shard hold all 3
    /// HIVEMIND layers, separated, for layer-filtered recall.
    #[napi]
    pub fn insert_layered(
        &mut self,
        text: String,
        vector: Float32Array,
        valid_from: i64,
        layer: u8,
    ) -> Result<u32> {
        let v: Vec<f32> = vector.to_vec();
        if v.len() != self.dim {
            return Err(Error::from_reason(format!(
                "vector dim {} != store dim {}",
                v.len(),
                self.dim
            )));
        }
        let mut m = MemoryInput::new(text.clone(), v);
        m.valid_from = valid_from;
        m.layer = layer;
        let slot = self
            .shard
            .segment()
            .insert(m)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        self.index_add(&text, slot);
        Ok(slot)
    }

    /// Build the HNSW overlay over all current vectors (call after a bulk load).
    #[napi]
    pub fn enable_hnsw(&mut self) -> Result<()> {
        self.shard
            .segment()
            .enable_hnsw()
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Train this shard's PQ (Product Quantization) codebook and encode every live vector into
    /// its compact `vector_pq` code, enabling `recall_pq()`. Deterministic given `seed` (same
    /// seed -> same codebook -> same recall_pq results, useful for reproducible tests). This is
    /// the ONLY way to make `pq_trained()` true / `recall_pq()` usable — there is no implicit
    /// auto-train, so a caller always knows exactly when the (real, one-time) training cost was
    /// paid. Blocks the event loop for its duration (k-means over every live vector) — like
    /// `enable_hnsw()`/`compact()`, call it after a bulk load or from a background job, not on a
    /// per-request path. Safe to call again later (e.g. after significant growth) to retrain.
    #[napi]
    pub fn train_pq(&mut self, seed: f64) -> Result<()> {
        self.shard
            .segment()
            .train_pq(seed as u64)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(())
    }

    /// True if `train_pq()` has run at least once for this shard.
    #[napi]
    pub fn pq_trained(&mut self) -> bool {
        self.shard.segment().pq_trained()
    }

    /// PQ/ADC-backed recall — an alternative to `recall()`'s HNSW/brute path with a different
    /// tradeoff: fast to build always, fast to QUERY only at small/medium shard sizes (measured
    /// on real bge-m3 data: at 10k vectors it beats HNSW on both build time and query latency at
    /// equal recall; at 100k it still builds ~6x faster but queries ~3x slower than HNSW at
    /// equal recall — PQ stays O(n) per query with a cheap per-item cost, HNSW's near-O(log n)
    /// traversal wins as the shard grows). Good fit: shards you rebuild often (dev/test, small
    /// orgs, frequently-retrained data) where build time matters more than the last few ms of
    /// query latency. NOT a drop-in replacement for `recall()` at real scale — measure your own
    /// shard size before choosing this over HNSW.
    ///
    /// FAILS CLOSED, not silently wrong: throws a clear error if `train_pq()` hasn't run yet,
    /// rather than falling back to some other path a caller didn't ask for — a correctness
    /// primitive should never guess which search the caller wanted.
    #[napi]
    pub fn recall_pq(&mut self, query: Float32Array, top_k: u32) -> Result<Vec<MnemeHit>> {
        if !self.shard.segment().pq_trained() {
            return Err(Error::from_reason(
                "recall_pq: no PQ codebook trained yet — call train_pq() first (see pq_trained())"
                    .to_string(),
            ));
        }
        let q: Vec<f32> = query.to_vec();
        let hits = self
            .shard
            .segment()
            .recall_pq(&q, &Filter::default(), top_k as usize)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(hits
            .into_iter()
            .map(|h| MnemeHit {
                slot_id: h.slot_id,
                score: h.score as f64,
                text: h.text,
            })
            .collect())
    }

    /// Recall the top-`top_k` memories for `query`.
    #[napi]
    pub fn recall(&mut self, query: Float32Array, top_k: u32) -> Result<Vec<MnemeHit>> {
        let q: Vec<f32> = query.to_vec();
        let hits = self
            .shard
            .segment()
            .recall(&q, &Filter::default(), top_k as usize)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(hits
            .into_iter()
            .map(|h| MnemeHit {
                slot_id: h.slot_id,
                score: h.score as f64,
                text: h.text,
            })
            .collect())
    }

    /// Layer-filtered recall: `layer` 0=memory, 1=evidence, 2=cognitive; pass -1 for all layers.
    /// This is how the 3 layers are queried separately from one shard (recall=memory,
    /// provenance=evidence, synthesis=cognitive), exactly like a Qdrant `layer` filter.
    #[napi]
    pub fn recall_layer(
        &mut self,
        query: Float32Array,
        top_k: u32,
        layer: i32,
    ) -> Result<Vec<MnemeHit>> {
        let q: Vec<f32> = query.to_vec();
        let filter = Filter {
            layer: if layer < 0 { None } else { Some(layer as u8) },
            ..Default::default()
        };
        let hits = self
            .shard
            .segment()
            .recall(&q, &filter, top_k as usize)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(hits
            .into_iter()
            .map(|h| MnemeHit {
                slot_id: h.slot_id,
                score: h.score as f64,
                text: h.text,
            })
            .collect())
    }

    /// Add a typed edge `slot_id` --(edge_type)--> `target` (unbounded; overflows to `.edg`).
    /// edge_type: 1=Mentions 2=Updates 3=Derives 4=Contradicts 5=PartOf 6=Extends.
    #[napi]
    pub fn add_edge(&mut self, slot_id: u32, target: u32, edge_type: u8, weight: u8) -> Result<()> {
        self.shard
            .segment()
            .add_edge(slot_id, target, edge_type, weight)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Typed graph traversal from `seed`, following ONLY `edge_type`, up to `max_hops`. Returns
    /// reachable slot ids (HIVEMIND `traverse_graph` parity, served from the one shard).
    #[napi]
    pub fn traverse_typed(&mut self, seed: u32, edge_type: u8, max_hops: u8) -> Result<Vec<u32>> {
        self.shard
            .segment()
            .traverse_typed(&[seed], edge_type, max_hops)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Bi-temporal point-in-time: the version of a memory current as of transaction time
    /// `txn_time` (ns), walking the Updates chain from `head_slot`. Returns the slot id, or -1 if
    /// not yet known (HIVEMIND `hivemind_at` / `timeline` parity).
    #[napi]
    pub fn as_of(&mut self, head_slot: u32, txn_time: i64) -> Result<i64> {
        let r = self
            .shard
            .segment()
            .as_of(head_slot, txn_time)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(r.map(|s| s as i64).unwrap_or(-1))
    }

    /// Insert with explicit bi-temporal stamps: `created_at` (transaction time — when learned)
    /// and `valid_from` (valid time — when true), both ns. `created_at` drives `as_of`.
    #[napi]
    pub fn insert_at(
        &mut self,
        text: String,
        vector: Float32Array,
        created_at: i64,
        valid_from: i64,
    ) -> Result<u32> {
        let mut m = MemoryInput::new(text.clone(), vector.to_vec());
        m.created_at = Some(created_at);
        m.valid_from = valid_from;
        let slot = self
            .shard
            .segment()
            .insert(m)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        self.index_add(&text, slot);
        Ok(slot)
    }

    /// Update memory `old_slot` with a new version: inserts, auto-links new--Updates-->old, marks
    /// old superseded. Recall then returns only the latest; `as_of` reaches the history. `created_at`
    /// is the transaction time of the new version (drives `as_of`). Returns the new slot id.
    #[napi]
    pub fn update(
        &mut self,
        old_slot: u32,
        text: String,
        vector: Float32Array,
        created_at: i64,
        valid_from: i64,
    ) -> Result<u32> {
        let mut m = MemoryInput::new(text.clone(), vector.to_vec());
        m.created_at = Some(created_at);
        m.valid_from = valid_from;
        // Same record id moves to the new slot — unlink the old mapping first.
        self.index_remove_slot(old_slot);
        let slot = self
            .shard
            .segment()
            .update(old_slot, m)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        self.index_add(&text, slot);
        Ok(slot)
    }

    /// Delete (tombstone) a memory by slot id.
    #[napi]
    pub fn delete(&mut self, slot_id: u32) -> Result<()> {
        self.index_remove_slot(slot_id);
        self.shard
            .segment()
            .delete(slot_id)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Rewrite a live slot's record TEXT in place (vector/layer/temporal/edges untouched) —
    /// the durability primitive for metadata-only mutations (tags, recall reinforcement,
    /// is_latest supersession flips). Old text bytes are reclaimed by `compact()`.
    #[napi]
    pub fn rewrite_text(&mut self, slot_id: u32, text: String) -> Result<()> {
        // The id may (rarely) change with the rewrite — remap defensively.
        self.index_remove_slot(slot_id);
        self.shard
            .segment()
            .rewrite_text(slot_id, &text)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        self.index_add(&text, slot_id);
        Ok(())
    }

    /// Resolve a record's JSON `id` to its live slot, or -1. Served from the native id index
    /// (hash → candidate slots, exact-verified against slot text) — O(1), no JS-side Map needed.
    #[napi]
    pub fn find_by_id(&mut self, id: String) -> Result<i64> {
        let h = hash_id(&id);
        let candidates = match self.id_index.get(&h) {
            Some(v) => v.clone(),
            None => return Ok(-1),
        };
        for slot in candidates {
            if let Ok(hit) = self.shard.segment().get(slot) {
                if extract_id(&hit.text) == Some(id.as_str()) {
                    return Ok(slot as i64);
                }
            }
        }
        Ok(-1)
    }

    /// Read one live slot's record text. `Err` for tombstoned/never-used slots.
    #[napi]
    pub fn slot_text(&mut self, slot_id: u32) -> Result<String> {
        self.shard
            .segment()
            .get(slot_id)
            .map(|h| h.text)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Streaming record scan: up to `limit` live records starting at slot `from_slot`, plus the
    /// slot to resume from (u32::MAX when done). O(page) JS heap instead of O(shard).
    #[napi]
    pub fn records_page(&mut self, from_slot: u32, limit: u32) -> Result<RecordPage> {
        let seg = self.shard.segment();
        let n = seg.slot_count();
        let mut rows = Vec::with_capacity(limit as usize);
        let mut idx = from_slot;
        while idx < n && rows.len() < limit as usize {
            if let Ok(hit) = seg.get(idx) {
                rows.push(RecordRow {
                    slot_id: idx,
                    text: hit.text,
                });
            }
            idx += 1;
        }
        let next_slot = if idx >= n { u32::MAX } else { idx };
        Ok(RecordPage { rows, next_slot })
    }

    /// Native BM25 lexical search over every live record's stored text. Full corpus-wide
    /// document-frequency/IDF statistics (see `bm25.rs`), not a substring or prefix heuristic --
    /// this is the engine's first lexical search of any kind. `MnemeStore` previously had vector
    /// recall, graph edges, and temporal operations, and nothing that scored on TEXT at all.
    ///
    /// KNOWN LIMITATION, STATED RATHER THAN HIDDEN: `Hit` does not currently surface a record's
    /// layer, so this scans every live slot regardless of the 0/1/2 layer used by
    /// `insert_layered`/`recall_layer`. A caller needing "evidence only" or "memory only" lexical
    /// search must filter the returned ids against a layer lookup of its own for now; adding a
    /// layer to `Hit` (or a native filtered variant) is the natural follow-up, not done here.
    ///
    /// O(shard) per call: two passes over every live record (corpus stats, then scoring), same
    /// cost shape as the JS-side scan-based lexical lanes this engine's callers already use in
    /// production. A persistent postings index for O(matching-docs) query cost at very large
    /// corpora is a further step, not this one.
    #[napi]
    pub fn bm25_search(&mut self, query: String, top_k: u32) -> Result<Vec<MnemeHit>> {
        let seg = self.shard.segment();
        let n = seg.slot_count();
        let mut rows: Vec<(u32, String)> = Vec::new();
        for idx in 0..n {
            if let Ok(hit) = seg.get(idx) {
                rows.push((idx, hit.text));
            }
        }
        let docs: Vec<Bm25Doc> = rows
            .iter()
            .map(|(id, text)| Bm25Doc { id: *id, text })
            .collect();
        let hits = bm25_search(&docs, &query, top_k as usize, Bm25Params::default());
        // Re-attach each hit's text for a result shape consistent with recall()/recall_layer().
        let text_by_id: HashMap<u32, &String> = rows.iter().map(|(id, text)| (*id, text)).collect();
        Ok(hits
            .into_iter()
            .map(|h| MnemeHit {
                slot_id: h.id,
                score: h.score,
                text: text_by_id
                    .get(&h.id)
                    .map(|t| (*t).clone())
                    .unwrap_or_default(),
            })
            .collect())
    }

    /// Number of live memories in the shard.
    #[napi]
    pub fn live_count(&mut self) -> u32 {
        self.shard.segment().live_count()
    }

    /// Read a slot's typed edges (target, type, weight) — for reconstructing relationship records.
    #[napi]
    pub fn slot_edges(&mut self, slot: u32) -> Result<Vec<EdgeRow>> {
        let edges = self
            .shard
            .segment()
            .slot_edges(slot)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(edges
            .into_iter()
            .map(|(target, edge_type, weight)| EdgeRow {
                target,
                edge_type,
                weight,
            })
            .collect())
    }

    /// Scan every live slot and return its (slot_id, full-record text). The Prisma adapter calls
    /// this once on open to hydrate all records from `.amr` — making `.amr` the relational store.
    #[napi]
    pub fn all_records(&mut self) -> Result<Vec<RecordRow>> {
        let seg = self.shard.segment();
        let n = seg.slot_count();
        let mut out = Vec::with_capacity(n as usize);
        for idx in 0..n {
            // get() returns Err for tombstoned/empty slots — skip those, keep the live ones.
            if let Ok(hit) = seg.get(idx) {
                out.push(RecordRow {
                    slot_id: idx,
                    text: hit.text,
                });
            }
        }
        Ok(out)
    }

    /// Compact the text region, reclaiming bytes of deleted memories. Returns bytes reclaimed.
    /// A maintenance op — run when the shard is idle.
    #[napi]
    pub fn compact(&mut self) -> Result<f64> {
        self.shard
            .segment()
            .compact()
            .map(|n| n as f64)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Flush to disk.
    #[napi]
    pub fn flush(&mut self) -> Result<()> {
        self.shard
            .segment()
            .flush()
            .map_err(|e| Error::from_reason(e.to_string()))
    }
}

// Post-quantum signing (ML-DSA-65 / FIPS 204, via RustCrypto's `ml-dsa`) — proved safe through
// `bun build --compile` before any of this was written (a real crash was hit earlier this
// session with a DIFFERENT native crate, better-sqlite3, whose own N-API bindings broke Bun's
// N-API compat shim; `ml-dsa` is pure Rust with no such surface, and a throwaway probe function
// confirmed it survives the identical compile+run before this real implementation replaced it).
//
// Deliberately NOT part of the frozen 202-byte slot format — signatures live in a side-table the
// Node layer manages (one JSONL file per org shard), the same "frozen slot, side-table for
// anything new" shape used in production (see the research page's own "memory_signatures" side-
// table). This module only does the cryptography; canonical-payload construction, key storage,
// and the append-only signature log all live in cli-lib.js.
mod sign {
    use ml_dsa::{Generate, Keypair, MlDsa65, Signature, SigningKey, VerifyingKey};
    use napi::bindgen_prelude::*;
    use napi_derive::napi;
    use signature::{SignatureEncoding, Signer, Verifier};

    /// A freshly generated ML-DSA-65 keypair, as raw bytes for the Node layer to persist.
    /// `signing_key` is the 32-byte SEED (`SigningKey::to_seed()`/`from_seed()` — the crate's own
    /// "preferred serialization... consistently 32-bytes" form), not the full expanded key —
    /// smaller to store, and re-expanding from seed on load is cheap.
    #[napi(object)]
    pub struct SigningKeypair {
        pub signing_key: Buffer,
        pub verifying_key: Buffer,
    }

    #[napi]
    pub fn generate_signing_keypair() -> Result<SigningKeypair> {
        let sk = SigningKey::<MlDsa65>::generate();
        let vk = sk.verifying_key();
        Ok(SigningKeypair {
            signing_key: sk.to_seed().as_slice().to_vec().into(),
            verifying_key: vk.encode().as_slice().to_vec().into(),
        })
    }

    /// Sign arbitrary bytes with a raw 32-byte signing-key seed (from
    /// `generate_signing_keypair`). The CALLER builds the canonical payload (slot id + text,
    /// etc.) — this function only does the cryptographic operation, so the exact bytes being
    /// signed are never ambiguous from reading this file alone.
    #[napi]
    pub fn sign_bytes(signing_key_seed: Buffer, payload: Buffer) -> Result<Buffer> {
        let seed = ml_dsa::B32::try_from(signing_key_seed.as_ref()).map_err(|_| {
            Error::from_reason(format!(
                "signing key must be exactly 32 bytes, got {}",
                signing_key_seed.len()
            ))
        })?;
        let sk = SigningKey::<MlDsa65>::from_seed(&seed);
        let sig = sk.sign(&payload);
        Ok(sig.to_bytes().to_vec().into())
    }

    /// Verify `signature` over `payload` against a raw verifying-key encoding. Returns `false`
    /// for a bad signature or tampered payload, NOT an error — only a malformed key/signature
    /// (wrong length, can't even be parsed) is an error. A caller checking "is this memory
    /// authentic" wants a clean boolean for the common tamper case, not exception-handling for it.
    #[napi]
    pub fn verify_bytes(
        verifying_key_bytes: Buffer,
        payload: Buffer,
        signature: Buffer,
    ) -> Result<bool> {
        let enc = ml_dsa::EncodedVerifyingKey::<MlDsa65>::try_from(verifying_key_bytes.as_ref())
            .map_err(|_| {
                Error::from_reason(format!(
                    "verifying key wrong length: got {}",
                    verifying_key_bytes.len()
                ))
            })?;
        let vk = VerifyingKey::<MlDsa65>::decode(&enc);
        let sig = Signature::<MlDsa65>::try_from(signature.as_ref())
            .map_err(|e| Error::from_reason(format!("invalid signature encoding: {e}")))?;
        Ok(vk.verify(&payload, &sig).is_ok())
    }
}
pub use sign::{generate_signing_keypair, sign_bytes, verify_bytes, SigningKeypair};

// SLH-DSA-SHA2-128s (FIPS 205 / SPHINCS+) — the audit-trail checkpoint signer. Deliberately a
// SEPARATE keypair and algorithm from `sign` module's ML-DSA-65: ML-DSA signs individual memories
// (many signatures, smaller ~3.3KB each); SLH-DSA here signs periodic CHECKPOINTS over an
// append-only hash chain of write events (few signatures, larger ~7.9KB each, but SLH-DSA's
// security rests on hash-function assumptions alone — a genuinely different, more conservative
// trust basis than ML-DSA's lattice assumptions, which is the actual point of using a second,
// different algorithm for the audit trail rather than reusing the same one). The hash chain
// itself, its storage, and checkpoint scheduling all live in cli-lib.js — this module is only
// the cryptographic primitive, same split as the `sign` module above.
mod audit_sign {
    use napi::bindgen_prelude::*;
    use napi_derive::napi;
    use rand_core::{TryCryptoRng, TryRng};
    use signature::{Keypair, Signer, Verifier};
    use slh_dsa::{Sha2_128s, SigningKey, VerifyingKey};
    use std::convert::Infallible;

    /// A minimal CryptoRng backed by the OS's own randomness (`getrandom`), written by hand
    /// instead of pulling in the `rand`/`rand_core` "os_rng" feature: rand_core 0.10's own
    /// feature-flag surface for this turned out fragmented across crate versions when actually
    /// tried (a real dead end hit building this — `rand_core::OsRng` wasn't resolvable through
    /// any combination of `signature`'s or `rand_core`'s own feature flags in this dependency
    /// graph), while implementing the trait directly over `getrandom::fill` is ~15 lines and has
    /// no such ambiguity.
    struct SysRng;
    impl TryRng for SysRng {
        type Error = Infallible;
        // Explicit `core::result::Result` here — the module-level `use napi::bindgen_prelude::*`
        // shadows the prelude `Result` with napi's own alias (`Result<T, napi::Error>`-shaped),
        // which doesn't accept `Infallible` as the error type. A real compile error hit writing
        // this, not a stylistic choice.
        fn try_next_u32(&mut self) -> core::result::Result<u32, Infallible> {
            let mut buf = [0u8; 4];
            getrandom::fill(&mut buf).expect("OS randomness source failed");
            Ok(u32::from_ne_bytes(buf))
        }
        fn try_next_u64(&mut self) -> core::result::Result<u64, Infallible> {
            let mut buf = [0u8; 8];
            getrandom::fill(&mut buf).expect("OS randomness source failed");
            Ok(u64::from_ne_bytes(buf))
        }
        fn try_fill_bytes(&mut self, dst: &mut [u8]) -> core::result::Result<(), Infallible> {
            getrandom::fill(dst).expect("OS randomness source failed");
            Ok(())
        }
    }
    impl TryCryptoRng for SysRng {}

    #[napi(object)]
    pub struct AuditKeypair {
        pub signing_key: Buffer,
        pub verifying_key: Buffer,
    }

    #[napi]
    pub fn generate_audit_keypair() -> Result<AuditKeypair> {
        let mut rng = SysRng;
        let sk = SigningKey::<Sha2_128s>::new(&mut rng);
        let vk = sk.verifying_key();
        Ok(AuditKeypair {
            signing_key: sk.to_bytes().to_vec().into(),
            verifying_key: vk.to_bytes().to_vec().into(),
        })
    }

    #[napi]
    pub fn audit_sign_bytes(signing_key_bytes: Buffer, payload: Buffer) -> Result<Buffer> {
        let sk = SigningKey::<Sha2_128s>::try_from(signing_key_bytes.as_ref())
            .map_err(|e| Error::from_reason(format!("invalid audit signing key: {e}")))?;
        let sig = sk.sign(&payload);
        Ok(sig.to_bytes().to_vec().into())
    }

    #[napi]
    pub fn audit_verify_bytes(
        verifying_key_bytes: Buffer,
        payload: Buffer,
        signature: Buffer,
    ) -> Result<bool> {
        let vk = VerifyingKey::<Sha2_128s>::try_from(verifying_key_bytes.as_ref())
            .map_err(|e| Error::from_reason(format!("invalid audit verifying key: {e}")))?;
        let sig = slh_dsa::Signature::<Sha2_128s>::try_from(signature.as_ref())
            .map_err(|e| Error::from_reason(format!("invalid audit signature encoding: {e}")))?;
        Ok(vk.verify(&payload, &sig).is_ok())
    }
}
pub use audit_sign::{audit_sign_bytes, audit_verify_bytes, generate_audit_keypair, AuditKeypair};
