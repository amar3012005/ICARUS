//! Real pseudo-terminal coverage for the interactive Node TUI. Unit viewport tests cannot prove
//! raw-mode input, TTY gating, alternate-screen lifecycle, or an orderly interactive exit.

#[cfg(not(windows))]
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
#[cfg(not(windows))]
use std::io::{Read, Write};
#[cfg(not(windows))]
use std::path::PathBuf;
#[cfg(not(windows))]
use std::sync::mpsc;
#[cfg(not(windows))]
use std::thread;
#[cfg(not(windows))]
use std::time::{Duration, Instant};
#[cfg(not(windows))]
use tempfile::tempdir;

#[cfg(not(windows))]
fn receive_until(receiver: &mpsc::Receiver<Vec<u8>>, marker: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut output = Vec::new();
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match receiver.recv_timeout(remaining) {
            Ok(bytes) => {
                output.extend(bytes);
                if String::from_utf8_lossy(&output).contains(marker) {
                    return String::from_utf8_lossy(&output).into_owned();
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => break,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    panic!(
        "PTY output never contained `{marker}`:\n{}",
        String::from_utf8_lossy(&output)
    );
}

// ConPTY does not expose the ANSI interactive lifecycle used by this assertion; Windows has
// independent compiled-CLI, native-MCP, storage, and managed-adapter coverage in CI. Keep this
// test limited to the Unix PTY contract it is designed to verify.
#[cfg(not(windows))]
#[test]
fn interactive_tui_enters_a_real_pty_accepts_help_and_exits_cleanly() {
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .unwrap()
        .to_path_buf();
    let cli = repository.join("crate/mneme-node/mneme-cli.js");
    assert!(
        cli.is_file(),
        "missing interactive CLI at {}",
        cli.display()
    );

    let home = tempdir().unwrap();
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut command = CommandBuilder::new("node");
    command.arg(cli);
    command.cwd(&repository);
    command.env("ICARUS_HOME", home.path());
    command.env("NO_COLOR", "1");
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);

    let mut writer = pair.master.take_writer().unwrap();
    let mut reader = pair.master.try_clone_reader().unwrap();
    let (sender, receiver) = mpsc::channel();
    let reader_thread = thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        while let Ok(read) = reader.read(&mut buffer) {
            if read == 0 {
                break;
            }
            if sender.send(buffer[..read].to_vec()).is_err() {
                break;
            }
        }
    });

    let startup = receive_until(&receiver, "Type /help for the full command list.");
    assert!(
        startup.contains("\x1b[?1049h"),
        "TUI did not enter alternate screen"
    );
    writer.write_all(b"/help\r").unwrap();
    writer.flush().unwrap();
    let help = receive_until(&receiver, "/update");
    // The TUI intentionally keeps a viewport tail rather than every help row, so the heading
    // can be above the redraw window. `/update` is uniquely emitted by the help transcript.
    assert!(help.contains("/update"));

    writer.write_all(b"/quit\r").unwrap();
    writer.flush().unwrap();
    let status = child.wait().unwrap();
    assert!(status.success(), "TUI exited unsuccessfully: {status:?}");
    drop(writer);
    reader_thread.join().unwrap();
}
