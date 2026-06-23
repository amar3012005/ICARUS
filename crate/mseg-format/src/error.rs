//! Crate-wide error type for `.mseg` format operations. Small and explicit — every failure
//! mode is named (global standard: never swallow errors, no silent failure). Grows across
//! P2 units (var region, segment, CRUD) but stays one enum so callers match exhaustively.

use std::fmt;

/// All errors the `.mseg` format/segment layer can produce.
#[derive(Debug)]
pub enum MsegError {
    /// Underlying I/O failure (file create/open/mmap/flush).
    Io(std::io::Error),
    /// Raw text exceeds `MAX_TEXT_BYTES` (SPEC §1.5).
    TextTooLarge { len: usize, max: usize },
    /// A `text_ptr`/`text_len_lz4` range fell outside the variable region.
    OutOfBounds {
        start: usize,
        end: usize,
        len: usize,
    },
    /// LZ4 decompression failed (corrupt block or wrong `text_len_raw`).
    Decompress(String),
    /// File magic/version did not identify a SPEC-v0 `.mseg`.
    BadHeader,
    /// Query/insert vector dimension did not match the segment dimension.
    DimMismatch { segment: usize, got: usize },
    /// A `SlotId` was out of range or refers to a tombstoned slot.
    TombstonedSlot(u32),
    /// `SlotId` does not exist in this segment.
    NoSuchSlot(u32),
    /// `org_id` failed validation (SPEC §4.2) — bad chars or path traversal.
    InvalidOrgId(String),
    /// Another process holds the shard lock (SPEC §4.3).
    ShardLocked,
    /// The host is big-endian but a native-endian fast path was requested (none in prod).
    Corrupt(String),
}

impl fmt::Display for MsegError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MsegError::Io(e) => write!(f, "io error: {e}"),
            MsegError::TextTooLarge { len, max } => {
                write!(f, "text too large: {len} bytes (max {max})")
            }
            MsegError::OutOfBounds { start, end, len } => {
                write!(
                    f,
                    "var-region range {start}..{end} out of bounds (len {len})"
                )
            }
            MsegError::Decompress(m) => write!(f, "lz4 decompress failed: {m}"),
            MsegError::BadHeader => write!(f, "not a SPEC-v0 .mseg file (bad magic/version)"),
            MsegError::DimMismatch { segment, got } => {
                write!(f, "dim mismatch: segment={segment} got={got}")
            }
            MsegError::TombstonedSlot(id) => write!(f, "slot {id} is tombstoned"),
            MsegError::NoSuchSlot(id) => write!(f, "no such slot {id}"),
            MsegError::InvalidOrgId(s) => write!(f, "invalid org_id: {s:?}"),
            MsegError::ShardLocked => write!(f, "shard is locked by another process"),
            MsegError::Corrupt(m) => write!(f, "corrupt segment: {m}"),
        }
    }
}

impl std::error::Error for MsegError {}

impl From<std::io::Error> for MsegError {
    fn from(e: std::io::Error) -> Self {
        MsegError::Io(e)
    }
}

pub type Result<T> = std::result::Result<T, MsegError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_variant_has_a_nonempty_display() {
        let variants: Vec<MsegError> = vec![
            MsegError::Io(std::io::Error::other("x")),
            MsegError::TextTooLarge { len: 1, max: 0 },
            MsegError::OutOfBounds {
                start: 5,
                end: 9,
                len: 3,
            },
            MsegError::Decompress("bad".into()),
            MsegError::BadHeader,
            MsegError::DimMismatch { segment: 8, got: 4 },
            MsegError::TombstonedSlot(7),
            MsegError::NoSuchSlot(9),
            MsegError::InvalidOrgId("../x".into()),
            MsegError::ShardLocked,
            MsegError::Corrupt("oops".into()),
        ];
        for v in &variants {
            let s = format!("{v}");
            assert!(!s.is_empty(), "Display for {v:?} was empty");
            // Error trait is wired
            let _: &dyn std::error::Error = v;
        }
    }

    #[test]
    fn io_error_converts() {
        let io = std::io::Error::new(std::io::ErrorKind::NotFound, "missing");
        let e: MsegError = io.into();
        assert!(matches!(e, MsegError::Io(_)));
    }
}
