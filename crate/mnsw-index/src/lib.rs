//! `.mnsw` HNSW index — a thin wrapper over `usearch` (reference/OPENSOURCE_RECON.md).
//!
//! mneme does NOT implement HNSW (recon denylist). This crate only owns the mapping
//! `usearch label == mneme slot id` and a save/load lifecycle for the `.mnsw` file. The
//! append-only `.mseg` write path stays physically separate (SPEC §6.1/§6.2): callers add
//! to this index from a *background* indexer, never inline on insert.

use std::path::Path;

use usearch::{Index, IndexOptions, MetricKind, ScalarKind};

/// Errors from the HNSW overlay. usearch errors are stringified (it returns its own type).
#[derive(Debug)]
pub enum MnswError {
    Usearch(String),
    DimMismatch { index: usize, got: usize },
}

impl std::fmt::Display for MnswError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MnswError::Usearch(m) => write!(f, "usearch: {m}"),
            MnswError::DimMismatch { index, got } => {
                write!(f, "dim mismatch: index={index} got={got}")
            }
        }
    }
}
impl std::error::Error for MnswError {}

pub type Result<T> = std::result::Result<T, MnswError>;

/// One HNSW search hit: a mneme slot id and its distance (lower = closer for Cos).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Candidate {
    pub slot_id: u32,
    pub distance: f32,
}

/// HNSW index over mneme slot vectors. `label == slot_id` (u64-widened).
pub struct MnswIndex {
    index: Index,
    dim: usize,
}

fn envn(key: &str, default: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn opts(dim: usize) -> IndexOptions {
    IndexOptions {
        dimensions: dim,
        metric: MetricKind::Cos,
        // Graph connectivity + build/search expansion. Defaults (M=48/efc=256/efs=400) maximize
        // recall (== float32 baseline) for small/medium orgs. At millions of vectors the high M
        // makes the build expensive, so MNEME_HNSW_M / _EFC / _EFS tune it down (e.g. M=16) for a
        // fast build + lower RAM, trading a little recall — the standard scale knob.
        connectivity: envn("MNEME_HNSW_M", 48),
        expansion_add: envn("MNEME_HNSW_EFC", 256),
        expansion_search: envn("MNEME_HNSW_EFS", 400),
        // HNSW graph quantization. Default f32 for recall parity with a float32 baseline (small/
        // medium orgs). At scale the f32 graph is the RAM bottleneck (~dim*4 B/vec); set
        // MNEME_HNSW_QUANT=i8 for a 4×-smaller index (~0.5% recall@5 cost) so millions of vectors
        // fit in RAM. The exact-rerank over the raw .vec keeps final recall high either way.
        quantization: match std::env::var("MNEME_HNSW_QUANT").as_deref() {
            Ok("i8") | Ok("int8") => ScalarKind::I8,
            _ => ScalarKind::F32,
        },
        ..Default::default()
    }
}

/// T1-5 (ICARUS ROADMAP.md) — usearch's own `expansion_search` (query-time HNSW graph
/// traversal width) was a flat 400 regardless of corpus size. That default was tuned and
/// gate-proven at 1M scale (P3: recall@10=99.25%, 1.33ms p50) but never re-validated smaller.
/// Measured directly (`examples/ef_sweep.rs`, real bge-m3 corpus, ground-truth recall@10 vs
/// brute force): at 10k vectors, EFS=16 already holds recall@10=1.0000 and EFS=40 cuts p50
/// from ~3.6ms to ~2.5ms (~30%) with zero recall loss down to EFS=16. `scaled_efs` uses 64 for
/// that tier — 4x the measured-lossless floor, since only one corpus/dim was swept and a size
/// tier this small warrants margin, not the exact minimum. The 100k/500k breakpoints are a
/// reasoned interpolation, NOT independently measured — re-run the sweep at those scales before
/// trusting them as tightly as the 10k tier. Above 500k, EFS stays at the original 400: that is
/// the exact value the 1M-scale gate validated, deliberately untouched, zero regression risk.
/// `MNEME_HNSW_EFS` still overrides unconditionally when set (manual tuning / this sweep tool).
fn scaled_efs(n: usize) -> usize {
    if n <= 20_000 {
        64
    } else if n <= 100_000 {
        128
    } else if n <= 500_000 {
        256
    } else {
        400
    }
}

impl MnswIndex {
    /// Create an empty index of dimension `dim`, reserving room for `capacity` vectors.
    pub fn new(dim: usize, capacity: usize) -> Result<MnswIndex> {
        let index = Index::new(&opts(dim)).map_err(|e| MnswError::Usearch(e.to_string()))?;
        index
            .reserve(capacity.max(1))
            .map_err(|e| MnswError::Usearch(e.to_string()))?;
        if std::env::var("MNEME_HNSW_EFS").is_err() {
            index.change_expansion_search(scaled_efs(capacity));
        }
        Ok(MnswIndex { index, dim })
    }

    pub fn dim(&self) -> usize {
        self.dim
    }

    /// Number of vectors currently in the index.
    pub fn len(&self) -> usize {
        self.index.size()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Add (or replace) the vector for `slot_id`. Does NOT auto-grow — the caller must ensure
    /// capacity via [`MnswIndex::reserve`] first (usearch `reserve` reallocates the graph and is
    /// NOT safe concurrent with `search`, so growth must be coordinated by the caller, not
    /// hidden here). Concurrent `add`/`search` ARE safe.
    pub fn add(&self, slot_id: u32, vector: &[f32]) -> Result<()> {
        if vector.len() != self.dim {
            return Err(MnswError::DimMismatch {
                index: self.dim,
                got: vector.len(),
            });
        }
        self.index
            .add(slot_id as u64, vector)
            .map_err(|e| MnswError::Usearch(e.to_string()))
    }

    /// Current reserved capacity.
    pub fn capacity(&self) -> usize {
        self.index.capacity()
    }

    /// Reserve capacity for at least `capacity` vectors. NOT safe concurrent with `search` or
    /// `add` (reallocates) — the caller must hold exclusive access.
    pub fn reserve(&self, capacity: usize) -> Result<()> {
        self.index
            .reserve(capacity)
            .map_err(|e| MnswError::Usearch(e.to_string()))
    }

    /// Top-`k` approximate nearest neighbours as `(slot_id, distance)`.
    pub fn search(&self, query: &[f32], k: usize) -> Result<Vec<Candidate>> {
        if query.len() != self.dim {
            return Err(MnswError::DimMismatch {
                index: self.dim,
                got: query.len(),
            });
        }
        let m = self
            .index
            .search(query, k)
            .map_err(|e| MnswError::Usearch(e.to_string()))?;
        Ok(m.keys
            .iter()
            .zip(m.distances.iter())
            .map(|(&key, &distance)| Candidate {
                slot_id: key as u32,
                distance,
            })
            .collect())
    }

    /// True if `slot_id` is present.
    pub fn contains(&self, slot_id: u32) -> bool {
        self.index.contains(slot_id as u64)
    }

    /// Persist the index to `path` (the `.mnsw` file).
    pub fn save(&self, path: &Path) -> Result<()> {
        self.index
            .save(
                path.to_str()
                    .ok_or_else(|| MnswError::Usearch("non-utf8 path".into()))?,
            )
            .map_err(|e| MnswError::Usearch(e.to_string()))
    }

    /// Load an index of dimension `dim` from a `.mnsw` file written by [`MnswIndex::save`].
    pub fn load(path: &Path, dim: usize) -> Result<MnswIndex> {
        let index = Index::new(&opts(dim)).map_err(|e| MnswError::Usearch(e.to_string()))?;
        index
            .load(
                path.to_str()
                    .ok_or_else(|| MnswError::Usearch("non-utf8 path".into()))?,
            )
            .map_err(|e| MnswError::Usearch(e.to_string()))?;
        // Same T1-5 size-scaled EFS as MnswIndex::new — capacity isn't known until after load(),
        // so it's applied here via the runtime setter instead of at construction.
        if std::env::var("MNEME_HNSW_EFS").is_err() {
            index.change_expansion_search(scaled_efs(index.size()));
        }
        Ok(MnswIndex { index, dim })
    }
}
