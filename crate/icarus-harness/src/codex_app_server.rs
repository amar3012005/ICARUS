//! Rust-owned Codex app-server process transport.
//!
//! The protocol is newline-delimited JSON-RPC. This module does not interpret model prose; it
//! only establishes the configured session, delegates every approval decision to the native
//! authority, and persists bounded lifecycle facts.

use super::*;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};

fn write_message(writer: &mut ChildStdin, message: &Value) -> Result<()> {
    serde_json::to_writer(&mut *writer, message)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

fn read_message(reader: &mut impl BufRead) -> Result<Value> {
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Err(HarnessError::invalid(
            "Codex app-server closed stdout before the managed turn completed",
        ));
    }
    serde_json::from_str(&line).map_err(HarnessError::from)
}

fn response_matches(message: &Value, expected: i64) -> bool {
    message.get("id").and_then(Value::as_i64) == Some(expected)
}

fn thread_id_from_start(result: &Value) -> Result<&str> {
    result
        .get("thread")
        .and_then(|thread| thread.get("id"))
        .and_then(Value::as_str)
        .or_else(|| result.get("threadId").and_then(Value::as_str))
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| {
            HarnessError::invalid("Codex thread/start response did not include a thread id")
        })
}

fn dispatch(
    writer: &mut ChildStdin,
    repo_root: &Path,
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
                .ok_or_else(|| HarnessError::invalid("Codex approval request has no id"))?;
            let decision = decide_codex_app_server_approval(repo_root, task_id, method, &params)?;
            write_message(
                writer,
                &json!({"jsonrpc": "2.0", "id": request_id, "result": {"decision": decision.decision}}),
            )?;
        }
        "thread/started" | "turn/started" | "item/started" | "item/completed"
        | "turn/completed" => {
            // The server can emit thread/started before its thread/start response. The bind is
            // the durable start receipt, so never record an event before it is bound.
            if thread_bound {
                record_codex_app_server_event(repo_root, task_id, method, &params)?;
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
    repo_root: &Path,
    task_id: &str,
    expected_id: i64,
    thread_bound: bool,
) -> Result<Value> {
    loop {
        let message = read_message(reader)?;
        if response_matches(&message, expected_id) {
            if let Some(error) = message.get("error") {
                return Err(HarnessError::invalid(format!(
                    "Codex app-server request {expected_id} failed: {error}"
                )));
            }
            return message.get("result").cloned().ok_or_else(|| {
                HarnessError::invalid(format!(
                    "Codex app-server request {expected_id} returned no result"
                ))
            });
        }
        let _ = dispatch(writer, repo_root, task_id, &message, thread_bound)?;
    }
}

fn spawn(command: &str) -> Result<Child> {
    let executable = resolve_executable(command)?;
    Command::new(executable)
        .args(["app-server", "--listen", "stdio://"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(HarnessError::from)
}

/// `CreateProcess` does not apply PATHEXT to a bare program name as consistently as the
/// interactive Windows shell does. Resolve through the platform's standard `where` utility
/// before spawning so managed Codex can use a normal `codex.cmd` installation. On Unix the
/// bare command remains deliberate: `Command` performs the normal PATH lookup.
fn resolve_executable(command: &str) -> Result<String> {
    #[cfg(windows)]
    {
        let output = Command::new("where")
            .arg(command)
            .output()
            .map_err(HarnessError::from)?;
        if !output.status.success() {
            return Err(HarnessError::invalid(format!(
                "Codex app-server program `{command}` is not available on PATH"
            )));
        }
        let candidates = String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        candidates
            .into_iter()
            .find(|value| {
                let lower = value.to_ascii_lowercase();
                lower.ends_with(".exe")
                    || lower.ends_with(".cmd")
                    || lower.ends_with(".bat")
                    || lower.ends_with(".com")
            })
            .ok_or_else(|| {
                HarnessError::invalid(format!(
                    "Codex app-server program `{command}` was not returned by where as a Windows executable"
                ))
            })
    }
    #[cfg(not(windows))]
    {
        Ok(command.to_owned())
    }
}

/// Run exactly one governed app-server turn. `app_server_command` exists for the standalone
/// binary and test fixture; the N-API production entry point always passes `codex`.
pub fn run(
    repo_root: &Path,
    task_id: &str,
    prompt: Option<&str>,
    app_server_command: &str,
) -> Result<()> {
    let task = task_status(repo_root, task_id)?;
    let prepared = codex_app_server_run(repo_root, task_id)?;
    let workspace = prepared.workspace_path;
    let prompt = prompt.unwrap_or(&task.objective);
    let mut child = spawn(app_server_command)?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| HarnessError::invalid("Codex app-server stdin was unavailable"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| HarnessError::invalid("Codex app-server stdout was unavailable"))?;
    let mut stdout = BufReader::new(stdout);

    record_adapter_lifecycle(repo_root, task_id, "adapter_session_started", None)?;
    let result = (|| {
        write_message(
            &mut stdin,
            &json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"clientInfo": {"name": "icarus-harness", "version": "0.1"}, "capabilities": {"experimentalApi": true}}}),
        )?;
        wait_for_response(&mut stdout, &mut stdin, repo_root, task_id, 1, false)?;
        write_message(
            &mut stdin,
            &json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}),
        )?;
        write_message(
            &mut stdin,
            &json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {"cwd": workspace, "approvalPolicy": "on-request", "approvalsReviewer": "user", "sandbox": "workspace-write", "developerInstructions": "This is a governed ICARUS task. The Rust harness controls authorization, verification, and sealing."}}),
        )?;
        let started = wait_for_response(&mut stdout, &mut stdin, repo_root, task_id, 2, false)?;
        let thread_id = thread_id_from_start(&started)?.to_owned();
        bind_codex_app_server_thread(repo_root, task_id, &thread_id)?;
        write_message(
            &mut stdin,
            &json!({"jsonrpc": "2.0", "id": 3, "method": "turn/start", "params": {"threadId": thread_id, "approvalPolicy": "on-request", "approvalsReviewer": "user", "cwd": workspace, "input": [{"type": "text", "text": prompt}]}}),
        )?;
        wait_for_response(&mut stdout, &mut stdin, repo_root, task_id, 3, true)?;
        loop {
            let message = read_message(&mut stdout)?;
            if dispatch(&mut stdin, repo_root, task_id, &message, true)? {
                break;
            }
        }
        Ok(())
    })();
    // App-server remains process-like after a turn; this child belongs solely to this governed
    // execution and must never leak into subsequent tasks.
    let _ = child.kill();
    let exit_code = child.wait().ok().and_then(|status| status.code());
    record_adapter_lifecycle(repo_root, task_id, "adapter_session_ended", exit_code)?;
    result
}
