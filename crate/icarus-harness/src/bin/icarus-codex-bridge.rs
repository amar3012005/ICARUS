//! Rust-owned bridge for Codex's experimental app-server protocol.
//!
//! This binary deliberately has no model client and does not interpret model text. It owns the
//! stdio protocol boundary so JavaScript is not an approval or lifecycle authority. The current
//! policy is intentionally fail-closed: every command, file-change, and permission request is
//! answered by `icarus_harness::decide_codex_app_server_approval`.

use icarus_harness::{
    bind_codex_app_server_thread, codex_app_server_run, decide_codex_app_server_approval,
    record_adapter_lifecycle, record_codex_app_server_event, task_status,
};
use serde_json::{json, Value};
use std::env;
use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};

type Result<T> = std::result::Result<T, String>;

struct Options {
    repo: PathBuf,
    task_id: String,
    prompt: Option<String>,
    app_server: String,
}

fn usage() -> &'static str {
    "usage: icarus-codex-bridge --repo <path> --task <TASK-ID> [--prompt <text>] [--app-server <command>]"
}

fn parse_options() -> Result<Options> {
    let mut repo = None;
    let mut task_id = None;
    let mut prompt = None;
    let mut app_server = env::var("ICARUS_CODEX_APP_SERVER").unwrap_or_else(|_| "codex".into());
    let mut args = env::args().skip(1);
    while let Some(argument) = args.next() {
        let value = match argument.as_str() {
            "--repo" => &mut repo,
            "--task" => &mut task_id,
            "--prompt" => &mut prompt,
            "--app-server" => {
                app_server = args.next().ok_or_else(|| usage().to_owned())?;
                continue;
            }
            "--help" | "-h" => return Err(usage().into()),
            _ => return Err(format!("unknown argument `{argument}`\n{}", usage())),
        };
        *value = Some(args.next().ok_or_else(|| usage().to_owned())?);
    }
    Ok(Options {
        repo: PathBuf::from(repo.ok_or_else(|| usage().to_owned())?),
        task_id: task_id.ok_or_else(|| usage().to_owned())?,
        prompt,
        app_server,
    })
}

fn write_message(writer: &mut ChildStdin, message: &Value) -> Result<()> {
    serde_json::to_writer(&mut *writer, message).map_err(|error| error.to_string())?;
    writer.write_all(b"\n").map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())
}

fn read_message(reader: &mut impl BufRead) -> Result<Value> {
    let mut line = String::new();
    let bytes = reader
        .read_line(&mut line)
        .map_err(|error| error.to_string())?;
    if bytes == 0 {
        return Err("Codex app-server closed stdout before the managed turn completed".into());
    }
    serde_json::from_str(&line)
        .map_err(|error| format!("invalid Codex app-server JSON-RPC line: {error}"))
}

fn request_id_matches(message: &Value, expected: i64) -> bool {
    message.get("id").and_then(Value::as_i64) == Some(expected)
}

fn thread_id_from_start(result: &Value) -> Result<&str> {
    result
        .get("thread")
        .and_then(|thread| thread.get("id"))
        .and_then(Value::as_str)
        .or_else(|| result.get("threadId").and_then(Value::as_str))
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| "Codex thread/start response did not include a thread id".into())
}

fn dispatch_server_message(
    writer: &mut ChildStdin,
    repo: &std::path::Path,
    task_id: &str,
    message: &Value,
    thread_bound: bool,
) -> Result<bool> {
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return Ok(false);
    };
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
    match method {
        "item/commandExecution/requestApproval"
        | "item/fileChange/requestApproval"
        | "item/permissions/requestApproval" => {
            let request_id = message
                .get("id")
                .ok_or_else(|| "Codex approval request has no id".to_owned())?;
            let decision = decide_codex_app_server_approval(repo, task_id, method, &params)
                .map_err(|error| error.to_string())?;
            write_message(
                writer,
                &json!({"jsonrpc": "2.0", "id": request_id, "result": {"decision": decision.decision}}),
            )?;
        }
        "thread/started" | "turn/started" | "item/started" | "item/completed"
        | "turn/completed" => {
            // `thread/started` may legitimately arrive before the response that gives us its
            // stable id. We do not record an unbound event; the subsequent native bind is the
            // durable start receipt. All later event failures are fatal rather than silently
            // weakening capture.
            if thread_bound {
                record_codex_app_server_event(repo, task_id, method, &params)
                    .map_err(|error| error.to_string())?;
            }
            return Ok(method == "turn/completed");
        }
        _ => {}
    }
    Ok(false)
}

fn wait_for_response(
    reader: &mut impl BufRead,
    writer: &mut ChildStdin,
    repo: &std::path::Path,
    task_id: &str,
    expected_id: i64,
    thread_bound: bool,
) -> Result<Value> {
    loop {
        let message = read_message(reader)?;
        if request_id_matches(&message, expected_id) {
            if let Some(error) = message.get("error") {
                return Err(format!(
                    "Codex app-server request {expected_id} failed: {error}"
                ));
            }
            return message.get("result").cloned().ok_or_else(|| {
                format!("Codex app-server request {expected_id} returned no result")
            });
        }
        let _ = dispatch_server_message(writer, repo, task_id, &message, thread_bound)?;
    }
}

fn spawn_app_server(command: &str) -> Result<Child> {
    Command::new(command)
        .args(["app-server", "--listen", "stdio://"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("failed to launch Codex app-server `{command}`: {error}"))
}

fn run(options: Options) -> Result<()> {
    let task = task_status(&options.repo, &options.task_id).map_err(|error| error.to_string())?;
    let prepared =
        codex_app_server_run(&options.repo, &options.task_id).map_err(|error| error.to_string())?;
    let workspace = prepared.workspace_path;
    let prompt = options.prompt.unwrap_or_else(|| task.objective.clone());
    let mut child = spawn_app_server(&options.app_server)?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Codex app-server stdin was unavailable".to_owned())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex app-server stdout was unavailable".to_owned())?;
    let mut stdout = BufReader::new(stdout);

    record_adapter_lifecycle(
        &options.repo,
        &options.task_id,
        "adapter_session_started",
        None,
    )
    .map_err(|error| error.to_string())?;
    let result = (|| {
        write_message(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"clientInfo": {"name": "icarus-harness", "version": "0.1"}, "capabilities": {"experimentalApi": true}},
            }),
        )?;
        wait_for_response(
            &mut stdout,
            &mut stdin,
            &options.repo,
            &options.task_id,
            1,
            false,
        )?;
        write_message(
            &mut stdin,
            &json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}),
        )?;
        write_message(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "thread/start",
                "params": {
                    "cwd": workspace,
                    "approvalPolicy": "on-request",
                    "approvalsReviewer": "user",
                    "sandbox": "workspace-write",
                    "developerInstructions": "This is a governed ICARUS task. The Rust harness controls authorization, verification, and sealing.",
                },
            }),
        )?;
        let started = wait_for_response(
            &mut stdout,
            &mut stdin,
            &options.repo,
            &options.task_id,
            2,
            false,
        )?;
        let thread_id = thread_id_from_start(&started)?.to_owned();
        bind_codex_app_server_thread(&options.repo, &options.task_id, &thread_id)
            .map_err(|error| error.to_string())?;
        write_message(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "turn/start",
                "params": {
                    "threadId": thread_id,
                    "approvalPolicy": "on-request",
                    "approvalsReviewer": "user",
                    "cwd": workspace,
                    "input": [{"type": "text", "text": prompt}],
                },
            }),
        )?;
        wait_for_response(
            &mut stdout,
            &mut stdin,
            &options.repo,
            &options.task_id,
            3,
            true,
        )?;
        loop {
            let message = read_message(&mut stdout)?;
            if dispatch_server_message(&mut stdin, &options.repo, &options.task_id, &message, true)?
            {
                break;
            }
        }
        Ok(())
    })();
    // App-server is a daemon-like process. After the managed turn has reached the observable
    // completion boundary, terminate this owned child; it never outlives the governed run.
    let _ = child.kill();
    let exit_code = child.wait().ok().and_then(|status| status.code());
    let lifecycle = record_adapter_lifecycle(
        &options.repo,
        &options.task_id,
        "adapter_session_ended",
        exit_code,
    );
    if let Err(error) = lifecycle {
        return Err(error.to_string());
    }
    result
}

fn main() {
    let result = parse_options().and_then(run);
    if let Err(error) = result {
        let _ = writeln!(io::stderr(), "icarus-codex-bridge: {error}");
        std::process::exit(1);
    }
}
