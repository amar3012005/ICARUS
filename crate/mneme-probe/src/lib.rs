//! mneme P1 — proof-of-physics probe.
//!
//! Proves the core thesis of `GLOBAL_PLAN.md`: a brute-force int8 cosine scan over a
//! locally `mmap`'d segment beats a Qdrant REST call at N=10k — because eliminating the
//! network hop + serialization dominates, even against Qdrant's sublinear HNSW.
//!
//! This is a **probe**, not the production format. It implements a minimal precursor of
//! the frozen `.mseg` layout (SPEC §1): a file header + an array of records, each a
//! `{id, flags}` prefix followed by an inline int8-quantized vector. The full 202-byte
//! slot header, LZ4 text region, PQ codes, HNSW overlay, and graph adjacency arrive in
//! P2–P5. Here we store int8 *scalar-quantized full vectors* (not PQ codes) and scan
//! them exhaustively — no index. That is exactly what "P1: raw format + brute-force int8
//! cosine scan, no HNSW yet" means.
//!
//! Reuse spine (reference/OPENSOURCE_RECON.md): `memmap2` (wrapped), `zerocopy` (checked
//! header cast), `rayon` (parallel scan). Nothing here reinvents an indexed search.

use std::fs::{File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::Path;

use memmap2::Mmap;
use rayon::prelude::*;
use zerocopy::{FromBytes, Immutable, IntoBytes, KnownLayout};

/// Magic for the P1 probe segment. The production `.mseg` uses `b"MNEME\0"` (SPEC §1.2);
/// the probe is deliberately distinct so the two are never confused on disk.
pub const PROBE_MAGIC: [u8; 8] = *b"MSEGP1\0\0";
/// Probe format version. Independent of the frozen production `format_version = 0`.
pub const PROBE_VERSION: u32 = 1;
/// Sentinel id for an empty/invalid slot (matches SPEC adjacency sentinel `0xFFFF_FFFF`).
pub const EMPTY_ID: u32 = 0xFFFF_FFFF;

/// Fixed segment header. `#[repr(C)]` + zerocopy so it casts off the mmap with bounds and
/// alignment checks and zero copies. All fields little-endian on LE hosts (arm64/x86-64);
/// the probe asserts LE at open (the production format will carry explicit LE codecs).
#[repr(C)]
#[derive(Debug, Clone, Copy, FromBytes, IntoBytes, Immutable, KnownLayout)]
pub struct ProbeHeader {
    pub magic: [u8; 8],
    pub version: u32,
    pub dim: u32,
    pub count: u32,
    pub reserved: u32,
}

/// Header size, also the offset to record 0.
pub const HEADER_SIZE: usize = std::mem::size_of::<ProbeHeader>();

/// Per-record fixed prefix written before each inline int8 vector: `{id, flags}`.
/// Mirrors the start of the SPEC slot header so the layout reads as a precursor.
const REC_PREFIX: usize = 8; // id: u32 + flags: u32

/// Byte stride of one record = prefix + the int8 vector of length `dim`.
#[inline]
pub fn record_stride(dim: usize) -> usize {
    REC_PREFIX + dim
}

/// Total on-disk size for `count` records of dimension `dim`.
#[inline]
pub fn segment_len(count: usize, dim: usize) -> usize {
    HEADER_SIZE + count * record_stride(dim)
}

/// Errors surfaced by the probe. Small and explicit — no `unwrap` on the hot path,
/// no silent failure (global standard: never swallow errors).
#[derive(Debug)]
pub enum ProbeError {
    Io(io::Error),
    BadMagic,
    BadVersion(u32),
    /// File length does not match `header.count * stride + HEADER_SIZE`.
    TruncatedOrCorrupt {
        expected: usize,
        actual: usize,
    },
    /// Query vector dimension does not match the segment dimension.
    DimMismatch {
        segment: usize,
        query: usize,
    },
    /// The mmap region could not be reinterpreted (alignment/size) — should never
    /// happen for a well-formed file; surfaced rather than panicked.
    CastFailed,
    BigEndianUnsupported,
}

impl std::fmt::Display for ProbeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProbeError::Io(e) => write!(f, "io error: {e}"),
            ProbeError::BadMagic => write!(f, "bad magic (not a mneme P1 segment)"),
            ProbeError::BadVersion(v) => write!(f, "unsupported probe version {v}"),
            ProbeError::TruncatedOrCorrupt { expected, actual } => {
                write!(f, "segment length {actual} != expected {expected}")
            }
            ProbeError::DimMismatch { segment, query } => {
                write!(f, "dim mismatch: segment={segment} query={query}")
            }
            ProbeError::CastFailed => write!(f, "mmap header cast failed"),
            ProbeError::BigEndianUnsupported => {
                write!(f, "probe requires a little-endian host")
            }
        }
    }
}

impl std::error::Error for ProbeError {}

impl From<io::Error> for ProbeError {
    fn from(e: io::Error) -> Self {
        ProbeError::Io(e)
    }
}

pub type Result<T> = std::result::Result<T, ProbeError>;

/// One recall result: a stable slot id and its int8 dot-product score (higher = closer).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Hit {
    pub slot_id: u32,
    /// int8 dot product accumulated in i32. For unit vectors quantized with the same
    /// `Q` scale, this is a monotone proxy for cosine similarity (cos ≈ score / Q²).
    pub score: i32,
}

/// Scalar quantization scale. A unit-L2 float vector maps to int8 via `round(x * Q)`,
/// clamped to `[-127, 127]`. Chosen as 127 so the full int8 range is used and the dot
/// product of two unit vectors lands near `cos * 127²`.
pub const Q: f32 = 127.0;

/// Quantize one L2-normalized float32 vector to int8 (length preserved).
///
/// Input is expected unit-norm (the generator normalizes). We do not re-normalize here;
/// callers that pass un-normalized vectors get a proportional (still monotone) result.
pub fn quantize_i8(v: &[f32]) -> Vec<i8> {
    v.iter()
        .map(|&x| {
            let s = (x * Q).round();
            // clamp into int8 range; .clamp avoids the cast UB of out-of-range floats
            s.clamp(-127.0, 127.0) as i8
        })
        .collect()
}

/// Write a probe segment to `path` from parallel `ids` and int8 `vectors`.
///
/// `vectors[i]` must have length `dim`. Records are written in input order; record `i`
/// gets `ids[i]`. The file is created/truncated and flushed before return.
pub fn write_segment(path: &Path, dim: usize, ids: &[u32], vectors: &[Vec<i8>]) -> Result<()> {
    assert_eq!(ids.len(), vectors.len(), "ids/vectors length mismatch");
    let count = ids.len();
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)?;
    let mut w = BufWriter::new(file);

    let header = ProbeHeader {
        magic: PROBE_MAGIC,
        version: PROBE_VERSION,
        dim: dim as u32,
        count: count as u32,
        reserved: 0,
    };
    w.write_all(header.as_bytes())?;

    for (i, vec) in vectors.iter().enumerate() {
        assert_eq!(vec.len(), dim, "vector {i} has wrong dim");
        w.write_all(&ids[i].to_le_bytes())?;
        w.write_all(&0u32.to_le_bytes())?; // flags = 0
                                           // i8 slice -> u8 bytes: identical layout, safe reinterpret.
        let bytes: &[u8] = vec.as_bytes();
        w.write_all(bytes)?;
    }
    w.flush()?;
    w.into_inner()
        .map_err(|e| ProbeError::Io(e.into_error()))?
        .sync_all()?;
    Ok(())
}

/// A read-only, memory-mapped probe segment.
///
/// SAFETY: `Mmap` is unsafe because mutating the underlying file while mapped is UB. The
/// `Segment` owns both the `File` and the `Mmap` and exposes only read access; the file
/// is opened read-only and never written through this handle, upholding the invariant
/// (reference/OPENSOURCE_RECON.md: memmap2 is WRAP behind a lifecycle owner).
pub struct Segment {
    _file: File,
    mmap: Mmap,
    dim: usize,
    count: usize,
    stride: usize,
}

impl Segment {
    /// Open and validate a probe segment at `path`.
    pub fn open(path: &Path) -> Result<Segment> {
        if cfg!(target_endian = "big") {
            return Err(ProbeError::BigEndianUnsupported);
        }
        let file = File::open(path)?;
        // SAFETY: file opened read-only; Segment never writes it; we hold File + Mmap
        // together so the mapping cannot outlive the descriptor.
        let mmap = unsafe { Mmap::map(&file)? };
        if mmap.len() < HEADER_SIZE {
            return Err(ProbeError::TruncatedOrCorrupt {
                expected: HEADER_SIZE,
                actual: mmap.len(),
            });
        }
        let header = ProbeHeader::read_from_bytes(&mmap[..HEADER_SIZE])
            .map_err(|_| ProbeError::CastFailed)?;
        if header.magic != PROBE_MAGIC {
            return Err(ProbeError::BadMagic);
        }
        if header.version != PROBE_VERSION {
            return Err(ProbeError::BadVersion(header.version));
        }
        let dim = header.dim as usize;
        let count = header.count as usize;
        let stride = record_stride(dim);
        let expected = segment_len(count, dim);
        if mmap.len() != expected {
            return Err(ProbeError::TruncatedOrCorrupt {
                expected,
                actual: mmap.len(),
            });
        }
        Ok(Segment {
            _file: file,
            mmap,
            dim,
            count,
            stride,
        })
    }

    #[inline]
    pub fn dim(&self) -> usize {
        self.dim
    }
    #[inline]
    pub fn count(&self) -> usize {
        self.count
    }

    /// Byte slice of record `i`'s int8 vector, reinterpreted as `&[i8]` (checked).
    #[inline]
    fn vec_at(&self, i: usize) -> &[i8] {
        let base = HEADER_SIZE + i * self.stride + REC_PREFIX;
        let bytes = &self.mmap[base..base + self.dim];
        <[i8]>::ref_from_bytes(bytes).expect("record vector slice is exactly dim bytes")
    }

    /// Slot id of record `i`.
    #[inline]
    fn id_at(&self, i: usize) -> u32 {
        let base = HEADER_SIZE + i * self.stride;
        u32::from_le_bytes(self.mmap[base..base + 4].try_into().unwrap())
    }

    /// Brute-force top-`k` int8 cosine scan over the whole segment.
    ///
    /// `query_i8` must be the int8 quantization of the (unit-norm) query, length `dim`.
    /// Returns up to `k` hits sorted by descending score. Parallelized with rayon; each
    /// worker keeps a bounded top-`k` then results are merged — O(N·dim) work, O(N·log k)
    /// merge, no allocation per record.
    pub fn brute_scan(&self, query_i8: &[i8], k: usize) -> Result<Vec<Hit>> {
        if query_i8.len() != self.dim {
            return Err(ProbeError::DimMismatch {
                segment: self.dim,
                query: query_i8.len(),
            });
        }
        if self.count == 0 || k == 0 {
            return Ok(Vec::new());
        }
        let k = k.min(self.count);

        // Map-reduce: per chunk maintain a min-ordered top-k, then merge top-ks.
        let merged = (0..self.count)
            .into_par_iter()
            .fold(
                || TopK::new(k),
                |mut acc, i| {
                    let score = dot_i8(query_i8, self.vec_at(i));
                    acc.push(Hit {
                        slot_id: self.id_at(i),
                        score,
                    });
                    acc
                },
            )
            .reduce(
                || TopK::new(k),
                |mut a, b| {
                    for h in b.into_vec() {
                        a.push(h);
                    }
                    a
                },
            );

        Ok(merged.into_sorted_desc())
    }
}

/// int8 dot product accumulated in i32. Auto-vectorizes at opt-level 3; the i32 accumulator
/// cannot overflow for dim ≤ ~130k (127*127*dim well within i32).
#[inline]
pub fn dot_i8(a: &[i8], b: &[i8]) -> i32 {
    debug_assert_eq!(a.len(), b.len());
    let mut acc: i32 = 0;
    for k in 0..a.len() {
        acc += a[k] as i32 * b[k] as i32;
    }
    acc
}

/// A bounded top-k accumulator backed by a tiny binary min-heap (smallest score at root,
/// so the weakest survivor is evicted first). Keeps memory at O(k), not O(N).
struct TopK {
    k: usize,
    heap: std::collections::BinaryHeap<std::cmp::Reverse<HitOrd>>,
}

impl TopK {
    fn new(k: usize) -> Self {
        TopK {
            k,
            heap: std::collections::BinaryHeap::with_capacity(k + 1),
        }
    }
    #[inline]
    fn push(&mut self, h: Hit) {
        if self.heap.len() < self.k {
            self.heap.push(std::cmp::Reverse(HitOrd(h)));
        } else if let Some(std::cmp::Reverse(HitOrd(min))) = self.heap.peek() {
            if h.score > min.score {
                self.heap.pop();
                self.heap.push(std::cmp::Reverse(HitOrd(h)));
            }
        }
    }
    fn into_vec(self) -> Vec<Hit> {
        self.heap.into_iter().map(|r| r.0 .0).collect()
    }
    fn into_sorted_desc(self) -> Vec<Hit> {
        let mut v = self.into_vec();
        // descending by score, tie-break by slot_id for deterministic output
        v.sort_unstable_by(|a, b| b.score.cmp(&a.score).then(a.slot_id.cmp(&b.slot_id)));
        v
    }
}

/// Ordering wrapper for `Hit` by `(score, slot_id)` so the heap is total-ordered and
/// deterministic on ties.
#[derive(PartialEq, Eq)]
struct HitOrd(Hit);
impl PartialOrd for HitOrd {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for HitOrd {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0
            .score
            .cmp(&other.0.score)
            .then(self.0.slot_id.cmp(&other.0.slot_id))
    }
}
impl Eq for Hit {}

/// Read a row-major little-endian float32 matrix (`rows × dim`) from a `.bin` file.
/// Used by the bench to load the generator's `corpus_f32.bin` / `queries_f32.bin`.
pub fn load_f32_matrix(path: &Path, dim: usize) -> Result<Vec<Vec<f32>>> {
    let bytes = std::fs::read(path)?;
    let row_bytes = dim * 4;
    if bytes.len() % row_bytes != 0 {
        return Err(ProbeError::TruncatedOrCorrupt {
            expected: (bytes.len() / row_bytes + 1) * row_bytes,
            actual: bytes.len(),
        });
    }
    let rows = bytes.len() / row_bytes;
    let mut out = Vec::with_capacity(rows);
    for r in 0..rows {
        let mut v = Vec::with_capacity(dim);
        let base = r * row_bytes;
        for c in 0..dim {
            let o = base + c * 4;
            v.push(f32::from_le_bytes(bytes[o..o + 4].try_into().unwrap()));
        }
        out.push(v);
    }
    Ok(out)
}

/// Exact float32 cosine top-k oracle — the correctness reference the int8 scan is checked
/// against in tests. Not used on the hot path.
pub fn exact_topk_f32(corpus: &[Vec<f32>], query: &[f32], k: usize) -> Vec<u32> {
    let mut scored: Vec<(f32, u32)> = corpus
        .iter()
        .enumerate()
        .map(|(i, c)| (dot_f32(c, query), i as u32))
        .collect();
    scored.sort_unstable_by(|a, b| b.0.partial_cmp(&a.0).unwrap().then(a.1.cmp(&b.1)));
    scored.into_iter().take(k).map(|(_, id)| id).collect()
}

#[inline]
fn dot_f32(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}
