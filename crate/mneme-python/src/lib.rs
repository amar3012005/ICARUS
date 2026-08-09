//! mneme Python binding (pyo3). Same engine and on-disk format the Node binding wraps ("Path B —
//! `.amr` as the relational store" per that crate's docs) — one Rust core, two language bindings,
//! identical behavior. This is not a reimplementation of the engine.
//!
//! SCOPE, STATED HONESTLY: this is a v0.1 covering the operations most useful for evaluating and
//! integrating the engine from Python -- open, insert (plain and layered), vector recall (plain
//! and layer-filtered), BM25 lexical search, edges/graph traversal, and lifecycle (delete, flush,
//! live_count). It is not full parity with every method the Node binding exposes (temporal
//! snapshot/rewrite operations are not yet here); nothing below claims otherwise.

// `#[pymethods]`'s macro-generated glue for every `PyResult<T>`-returning method performs its own
// error conversion on top of what the method body already does, which clippy sees as converting
// `PyErr` to `PyErr` and flags as useless_conversion. Confirmed macro-generated, not a real issue
// in this crate's own code: every PyResult-returning method is flagged identically regardless of
// its body, while `live_count` (returns a bare `u32`, no PyResult) is not flagged at all. An
// impl-level `#[allow]` did not reach it -- the macro emits additional code outside that impl
// block's span -- so this is crate-level, which is the standard mitigation for this known pyo3+
// clippy interaction.
#![allow(clippy::useless_conversion)]

use mneme_bm25::{bm25_search, Bm25Doc, Bm25Params};
use mseg::{Filter as MsegFilter, MemoryInput, Shard};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::PyModule;

/// Map the engine's error type to a Python exception with the real message, not a generic one --
/// a caller debugging "why did my insert fail" needs the engine's own words (dimension mismatch,
/// corrupt shard, tombstoned slot), not "an error occurred".
fn to_py_err<E: std::fmt::Display>(e: E) -> PyErr {
    PyValueError::new_err(e.to_string())
}

/// One recall or BM25 hit.
#[pyclass]
#[derive(Clone)]
pub struct MnemeHit {
    #[pyo3(get)]
    pub slot_id: u32,
    #[pyo3(get)]
    pub score: f64,
    #[pyo3(get)]
    pub text: String,
}

#[pymethods]
impl MnemeHit {
    fn __repr__(&self) -> String {
        format!(
            "MnemeHit(slot_id={}, score={:.4}, text={:?})",
            self.slot_id,
            self.score,
            if self.text.len() > 40 {
                format!("{}…", &self.text[..40])
            } else {
                self.text.clone()
            }
        )
    }
}

/// A per-org mneme store (wraps one `.amr` shard). Not thread-safe by construction (matches the
/// Node binding: one shard, one owner) -- share across threads only behind your own lock, the
/// same rule that applies there.
#[pyclass]
pub struct MnemeStore {
    shard: Shard,
    dim: usize,
}

#[pymethods]
impl MnemeStore {
    /// Open (or create) the shard for `org_id` under `data_root` with embedding dimension `dim`.
    #[new]
    fn open(data_root: String, org_id: String, dim: usize) -> PyResult<Self> {
        let shard =
            Shard::open(std::path::Path::new(&data_root), &org_id, dim).map_err(to_py_err)?;
        Ok(MnemeStore { shard, dim })
    }

    /// Insert a memory (text + embedding). `valid_from` is nanoseconds since epoch (0 =
    /// unspecified). Returns the stable slot id.
    fn insert(&mut self, text: String, vector: Vec<f32>, valid_from: i64) -> PyResult<u32> {
        if vector.len() != self.dim {
            return Err(PyValueError::new_err(format!(
                "vector dim {} != store dim {}",
                vector.len(),
                self.dim
            )));
        }
        let mut m = MemoryInput::new(text, vector);
        m.valid_from = valid_from;
        self.shard.segment().insert(m).map_err(to_py_err)
    }

    /// Insert tagged with a layer (0=memory, 1=evidence, 2=cognitive). Lets one shard hold all
    /// three layers, separated, for layer-filtered recall.
    fn insert_layered(
        &mut self,
        text: String,
        vector: Vec<f32>,
        valid_from: i64,
        layer: u8,
    ) -> PyResult<u32> {
        if vector.len() != self.dim {
            return Err(PyValueError::new_err(format!(
                "vector dim {} != store dim {}",
                vector.len(),
                self.dim
            )));
        }
        let mut m = MemoryInput::new(text, vector);
        m.valid_from = valid_from;
        m.layer = layer;
        self.shard.segment().insert(m).map_err(to_py_err)
    }

    /// Build the HNSW overlay over current vectors (call after a bulk load). Below the overlay,
    /// recall is exact brute force.
    fn enable_hnsw(&mut self) -> PyResult<()> {
        self.shard.segment().enable_hnsw().map_err(to_py_err)
    }

    /// Recall the top-`top_k` memories for `query` (a raw embedding vector).
    fn recall(&mut self, query: Vec<f32>, top_k: usize) -> PyResult<Vec<MnemeHit>> {
        let hits = self
            .shard
            .segment()
            .recall(&query, &MsegFilter::default(), top_k)
            .map_err(to_py_err)?;
        Ok(hits
            .into_iter()
            .map(|h| MnemeHit {
                slot_id: h.slot_id,
                score: h.score as f64,
                text: h.text,
            })
            .collect())
    }

    /// Layer-filtered recall: `layer` 0=memory, 1=evidence, 2=cognitive; pass -1 for all layers.
    fn recall_layer(
        &mut self,
        query: Vec<f32>,
        top_k: usize,
        layer: i32,
    ) -> PyResult<Vec<MnemeHit>> {
        let filter = MsegFilter {
            layer: if layer < 0 { None } else { Some(layer as u8) },
            ..Default::default()
        };
        let hits = self
            .shard
            .segment()
            .recall(&query, &filter, top_k)
            .map_err(to_py_err)?;
        Ok(hits
            .into_iter()
            .map(|h| MnemeHit {
                slot_id: h.slot_id,
                score: h.score as f64,
                text: h.text,
            })
            .collect())
    }

    /// Native BM25 lexical search over every live record's stored text -- real document-
    /// frequency/IDF statistics, not a substring heuristic. See `mneme-bm25` for the algorithm;
    /// identical scoring to the Node binding's `bm25_search`, same shared crate.
    ///
    /// Known limitation stated rather than hidden: does not currently filter by layer (the
    /// underlying `Hit` type does not surface one) -- filter the returned `slot_id`s yourself if
    /// you need layer-scoped lexical search.
    fn bm25_search(&mut self, query: String, top_k: usize) -> PyResult<Vec<MnemeHit>> {
        let seg = self.shard.segment();
        let n = seg.slot_count();
        let mut rows: Vec<(u32, String)> = Vec::new();
        for idx in 0..n {
            if let Ok(hit) = seg.get(idx) {
                rows.push((idx, hit.text));
            }
        }
        let docs: Vec<Bm25Doc> = rows
            .iter()
            .map(|(id, text)| Bm25Doc { id: *id, text })
            .collect();
        let hits = bm25_search(&docs, &query, top_k, Bm25Params::default());
        let text_by_id: std::collections::HashMap<u32, &String> =
            rows.iter().map(|(id, text)| (*id, text)).collect();
        Ok(hits
            .into_iter()
            .map(|h| MnemeHit {
                slot_id: h.id,
                score: h.score,
                text: text_by_id
                    .get(&h.id)
                    .map(|t| (*t).clone())
                    .unwrap_or_default(),
            })
            .collect())
    }

    /// Add a typed edge slot_id -> target (type + weight, 0-255 each).
    fn add_edge(&mut self, slot_id: u32, target: u32, edge_type: u8, weight: u8) -> PyResult<()> {
        self.shard
            .segment()
            .add_edge(slot_id, target, edge_type, weight)
            .map_err(to_py_err)
    }

    /// Typed graph traversal from a single seed slot, up to `max_hops` of `edge_type` edges.
    fn traverse_typed(&mut self, seed: u32, edge_type: u8, max_hops: u8) -> PyResult<Vec<u32>> {
        self.shard
            .segment()
            .traverse_typed(&[seed], edge_type, max_hops)
            .map_err(to_py_err)
    }

    /// Number of live memories in the shard.
    fn live_count(&mut self) -> u32 {
        self.shard.segment().live_count()
    }

    /// Delete a memory by slot id (tombstone; text/vector bytes reclaimed on the next compact()).
    fn delete(&mut self, slot_id: u32) -> PyResult<()> {
        self.shard.segment().delete(slot_id).map_err(to_py_err)
    }

    /// Flush pending writes to disk. The engine flushes on write already; call explicitly only
    /// when you need a durability point before an external event (e.g. before a backup snapshot).
    fn flush(&mut self) -> PyResult<()> {
        self.shard.segment().flush().map_err(to_py_err)
    }
}

#[pymodule]
fn mneme_python(_py: Python<'_>, m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<MnemeStore>()?;
    m.add_class::<MnemeHit>()?;
    Ok(())
}
