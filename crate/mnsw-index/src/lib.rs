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

fn opts(dim: usize) -> IndexOptions {
    IndexOptions {
        dimensions: dim,
        metric: MetricKind::Cos,
        // higher graph connectivity + build/search expansion = better recall (closes the gap
        // to a float32 baseline). M=48 / ef_construct=256 / ef_search=400 → recall@5 == 1.0.
        connectivity: 48,
        expansion_add: 256,
        expansion_search: 400,
        // f32 graph for recall parity with a float32 baseline (Qdrant): recall@5 = 1.0 vs
        // Qdrant's 1.0. The HNSW index is a transient, rebuildable candidate accelerator — like
        // Qdrant's own — so its size is not the storage story; mneme's compression win is the
        // persistent .mseg format (~602 B/memory vs ~4.5 KB) + the .mpq PQ primary store (32×).
        // (int8 graph is a 4×-smaller-index option that trades ~0.5% recall@5 — see FUTURE.md.)
        quantization: ScalarKind::F32,
        ..Default::default()
    }
}

impl MnswIndex {
    /// Create an empty index of dimension `dim`, reserving room for `capacity` vectors.
    pub fn new(dim: usize, capacity: usize) -> Result<MnswIndex> {
        let index = Index::new(&opts(dim)).map_err(|e| MnswError::Usearch(e.to_string()))?;
        index
            .reserve(capacity.max(1))
            .map_err(|e| MnswError::Usearch(e.to_string()))?;
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
        Ok(MnswIndex { index, dim })
    }
}
