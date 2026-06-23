//! Multi-tenant shard (SPEC §4): one `.mseg`/`.vec`/`.txt` triple per org, under
//! `data_root/<org_id>/`, guarded by an advisory lock so two handles never write the same
//! files concurrently.
//!
//! Locking note (SPEC §4.3 specifies `fcntl F_SETLK`): POSIX `fcntl` record locks are owned
//! by the *process*, so a second open of the same shard within one process would not
//! conflict — defeating the guard for the common same-process double-open bug. We use
//! `flock(LOCK_EX|LOCK_NB)` instead, which gives the same cross-process exclusion **and**
//! detects a second open file description in the same process. This is a strictly stronger
//! guarantee; the on-disk format is unchanged.

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

use mseg_format::{MsegError, Result};

use crate::segment::Segment;

/// Fixed segment name within a shard directory.
const SEGMENT_NAME: &str = "shard";
/// Lock file name within a shard directory.
const LOCK_NAME: &str = "shard.lock";
/// Max org_id length (SPEC §4.2).
const MAX_ORG_ID: usize = 64;

/// Validate `org_id` against SPEC §4.2: `[a-zA-Z0-9_-]{1,64}`. The charset alone rejects
/// path traversal (`.`, `/`, `\`, `..` all contain disallowed bytes).
fn validate_org_id(org_id: &str) -> Result<()> {
    if org_id.is_empty() || org_id.len() > MAX_ORG_ID {
        return Err(MsegError::InvalidOrgId(org_id.to_string()));
    }
    if !org_id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(MsegError::InvalidOrgId(org_id.to_string()));
    }
    Ok(())
}

/// Acquire an exclusive, non-blocking advisory lock on `file`. Returns `Err(ShardLocked)`
/// if another file description (this or another process) already holds it.
#[cfg(unix)]
fn try_lock_exclusive(file: &File) -> Result<()> {
    use std::os::unix::io::AsRawFd;
    // SAFETY: `fd` is a valid open descriptor owned by `file` for the call's duration.
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc == 0 {
        Ok(())
    } else {
        let err = std::io::Error::last_os_error();
        match err.raw_os_error() {
            Some(code) if code == libc::EWOULDBLOCK || code == libc::EAGAIN => {
                Err(MsegError::ShardLocked)
            }
            _ => Err(MsegError::Io(err)),
        }
    }
}

#[cfg(unix)]
fn unlock(file: &File) {
    use std::os::unix::io::AsRawFd;
    // SAFETY: valid fd; LOCK_UN cannot fail meaningfully and we ignore the result on drop.
    unsafe {
        libc::flock(file.as_raw_fd(), libc::LOCK_UN);
    }
}

#[cfg(not(unix))]
fn try_lock_exclusive(_file: &File) -> Result<()> {
    // Non-unix hosts are out of scope for P2 (HIVEMIND prod is Linux). Fail loudly rather
    // than silently run without a lock.
    Err(MsegError::Corrupt(
        "shard lock unsupported on this platform".into(),
    ))
}

#[cfg(not(unix))]
fn unlock(_file: &File) {}

/// One org's shard: an exclusive lock plus its [`Segment`]. CRUD is delegated to the
/// segment; the lock is held for the shard's lifetime and released on drop (SPEC §4.3).
pub struct Shard {
    org_id: String,
    dir: PathBuf,
    lock_file: File,
    segment: Segment,
}

impl Shard {
    /// Open the shard for `org_id` under `data_root`, creating an empty segment of dimension
    /// `dim` if none exists yet. `dim` is used only on first creation; for an existing shard
    /// the dimension comes from its file header.
    pub fn open(data_root: &Path, org_id: &str, dim: usize) -> Result<Shard> {
        validate_org_id(org_id)?;
        let dir = data_root.join(org_id);
        std::fs::create_dir_all(&dir)?;

        // acquire the lock BEFORE touching the segment files.
        let lock_file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false) // lock file content is irrelevant; never truncate
            .open(dir.join(LOCK_NAME))?;
        try_lock_exclusive(&lock_file)?;

        let segment = if dir.join(format!("{SEGMENT_NAME}.mseg")).exists() {
            Segment::open(&dir, SEGMENT_NAME)?
        } else {
            Segment::create(&dir, SEGMENT_NAME, dim)?
        };

        Ok(Shard {
            org_id: org_id.to_string(),
            dir,
            lock_file,
            segment,
        })
    }

    pub fn org_id(&self) -> &str {
        &self.org_id
    }
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Mutable access to the underlying segment for CRUD (`insert`/`get`/`delete`/`recall`).
    pub fn segment(&mut self) -> &mut Segment {
        &mut self.segment
    }
}

impl Drop for Shard {
    fn drop(&mut self) {
        // flush data, then release the advisory lock (SPEC §4.3 Shard::drop).
        let _ = self.segment.flush();
        unlock(&self.lock_file);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bad_org_ids() {
        for bad in ["", "../etc", "a/b", "a.b", "with space", &"x".repeat(65)] {
            assert!(validate_org_id(bad).is_err(), "should reject {bad:?}");
        }
        for ok in ["org1", "ACME-Corp_42", "a", &"y".repeat(64)] {
            assert!(validate_org_id(ok).is_ok(), "should accept {ok:?}");
        }
    }
}
