//! `.mpq` on-disk codebook format (SPEC §3.2). 32-byte header (LE byte arrays, portable) +
//! `[M][K][dim/M]` f32 centroids, row-major little-endian.

use std::path::Path;

use zerocopy::{FromBytes, FromZeros, Immutable, IntoBytes, KnownLayout};

use crate::codebook::{PqCodebook, PqParams};

/// File magic (SPEC §3.2).
pub const MPQ_MAGIC: [u8; 4] = *b"MPQC";
/// Format version.
pub const MPQ_VERSION: u16 = 0;
/// Header size in bytes.
pub const MPQ_HEADER_SIZE: usize = 32;

/// Errors from `.mpq` IO.
#[derive(Debug)]
pub enum MpqError {
    Io(std::io::Error),
    BadMagic,
    BadVersion(u16),
    Corrupt(String),
}

impl std::fmt::Display for MpqError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MpqError::Io(e) => write!(f, "io: {e}"),
            MpqError::BadMagic => write!(f, "not a .mpq file (bad magic)"),
            MpqError::BadVersion(v) => write!(f, "unsupported .mpq version {v}"),
            MpqError::Corrupt(m) => write!(f, "corrupt .mpq: {m}"),
        }
    }
}
impl std::error::Error for MpqError {}
impl From<std::io::Error> for MpqError {
    fn from(e: std::io::Error) -> Self {
        MpqError::Io(e)
    }
}
pub type Result<T> = std::result::Result<T, MpqError>;

/// 32-byte `.mpq` header (SPEC §3.2), portable little-endian byte arrays.
#[repr(C)]
#[derive(Clone, Copy, Debug, FromBytes, IntoBytes, Immutable, KnownLayout)]
struct MpqHeader {
    magic: [u8; 4],      // 0
    version: [u8; 2],    // 4
    m: [u8; 2],          // 6
    k: [u8; 2],          // 8
    dim: [u8; 4],        // 10
    trained_on: [u8; 4], // 14
    trained_at: [u8; 8], // 18
    reserved: [u8; 6],   // 26
}

/// Serialize `cb` to `path`. `trained_at` is unix nanoseconds (provenance; 0 if unknown).
pub fn save(cb: &PqCodebook, path: &Path, trained_at: i64) -> Result<()> {
    let p = cb.params();
    let mut hdr = MpqHeader::new_zeroed();
    hdr.magic = MPQ_MAGIC;
    hdr.version = MPQ_VERSION.to_le_bytes();
    hdr.m = (p.m as u16).to_le_bytes();
    hdr.k = (p.k as u16).to_le_bytes();
    hdr.dim = (p.dim as u32).to_le_bytes();
    hdr.trained_on = cb.trained_on.to_le_bytes();
    hdr.trained_at = trained_at.to_le_bytes();

    let mut buf = Vec::with_capacity(MPQ_HEADER_SIZE + cb.centroids().len() * 4);
    buf.extend_from_slice(hdr.as_bytes());
    for &c in cb.centroids() {
        buf.extend_from_slice(&c.to_le_bytes());
    }
    std::fs::write(path, &buf)?;
    Ok(())
}

/// Load a codebook from `path`, validating magic/version and centroid length.
pub fn load(path: &Path) -> Result<PqCodebook> {
    let bytes = std::fs::read(path)?;
    if bytes.len() < MPQ_HEADER_SIZE {
        return Err(MpqError::Corrupt("shorter than header".into()));
    }
    let hdr = MpqHeader::ref_from_bytes(&bytes[..MPQ_HEADER_SIZE])
        .map_err(|_| MpqError::Corrupt("header cast failed".into()))?;
    if hdr.magic != MPQ_MAGIC {
        return Err(MpqError::BadMagic);
    }
    let version = u16::from_le_bytes(hdr.version);
    if version != MPQ_VERSION {
        return Err(MpqError::BadVersion(version));
    }
    let m = u16::from_le_bytes(hdr.m) as usize;
    let k = u16::from_le_bytes(hdr.k) as usize;
    let dim = u32::from_le_bytes(hdr.dim) as usize;
    let trained_on = u32::from_le_bytes(hdr.trained_on);
    if m == 0 || dim == 0 || dim % m != 0 {
        return Err(MpqError::Corrupt("bad m/dim".into()));
    }
    let n_cent = m * k * (dim / m);
    let want = MPQ_HEADER_SIZE + n_cent * 4;
    if bytes.len() != want {
        return Err(MpqError::Corrupt(format!(
            "centroid length: have {} want {want}",
            bytes.len()
        )));
    }
    let mut centroids = Vec::with_capacity(n_cent);
    for i in 0..n_cent {
        let o = MPQ_HEADER_SIZE + i * 4;
        centroids.push(f32::from_le_bytes(bytes[o..o + 4].try_into().unwrap()));
    }
    Ok(PqCodebook::from_parts(
        PqParams { m, k, dim },
        centroids,
        trained_on,
    ))
}
