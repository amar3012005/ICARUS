//! Standalone developer wrapper around the Rust-owned Codex app-server bridge.

use icarus_harness::run_codex_app_server_bridge_with_command;
use std::env;
use std::io::{self, Write};
use std::path::PathBuf;

struct Options {
    repo: PathBuf,
    task_id: String,
    prompt: Option<String>,
    app_server: String,
}

fn usage() -> &'static str {
    "usage: icarus-codex-bridge --repo <path> --task <TASK-ID> [--prompt <text>] [--app-server <command>]"
}

fn parse_options() -> std::result::Result<Options, String> {
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

fn main() {
    let result = parse_options().and_then(|options| {
        run_codex_app_server_bridge_with_command(
            &options.repo,
            &options.task_id,
            options.prompt.as_deref(),
            &options.app_server,
        )
        .map_err(|error| error.to_string())
    });
    if let Err(error) = result {
        let _ = writeln!(io::stderr(), "icarus-codex-bridge: {error}");
        std::process::exit(1);
    }
}
