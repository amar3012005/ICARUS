//! mneme Node.js binding (napi-rs). Exposes the `.amr` engine as a drop-in vector store so
//! HIVEMIND's `indexer.js` can call it in place of Qdrant. Methods are synchronous over a
//! per-org shard held in the JS object; the JS wrapper (MnemeVectorStore) adapts them to the
//! async `upsert`/`search` interface HIVEMIND expects.

use mseg::{Filter, MemoryInput, Shard};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::path::PathBuf;

/// One recall hit returned to JS.
#[napi(object)]
pub struct MnemeHit {
    pub slot_id: u32,
    pub score: f64,
    pub text: String,
}

/// A per-org mneme store (wraps one `.amr` shard).
#[napi]
pub struct MnemeStore {
    shard: Shard,
    dim: usize,
}

#[napi]
impl MnemeStore {
    /// Open (or create) the shard for `org_id` under `data_root` with embedding dimension `dim`.
    #[napi(factory)]
    pub fn open(data_root: String, org_id: String, dim: u32) -> Result<Self> {
        let shard = Shard::open(&PathBuf::from(data_root), &org_id, dim as usize)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(MnemeStore {
            shard,
            dim: dim as usize,
        })
    }

    /// Insert a memory (text + embedding). `valid_from` is nanoseconds (0 = unspecified).
    /// Returns the stable slot id.
    #[napi]
    pub fn insert(&mut self, text: String, vector: Float32Array, valid_from: i64) -> Result<u32> {
        let v: Vec<f32> = vector.to_vec();
        if v.len() != self.dim {
            return Err(Error::from_reason(format!(
                "vector dim {} != store dim {}",
                v.len(),
                self.dim
            )));
        }
        let mut m = MemoryInput::new(text, v);
        m.valid_from = valid_from;
        self.shard
            .segment()
            .insert(m)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Build the HNSW overlay over all current vectors (call after a bulk load).
    #[napi]
    pub fn enable_hnsw(&mut self) -> Result<()> {
        self.shard
            .segment()
            .enable_hnsw()
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Recall the top-`top_k` memories for `query`.
    #[napi]
    pub fn recall(&mut self, query: Float32Array, top_k: u32) -> Result<Vec<MnemeHit>> {
        let q: Vec<f32> = query.to_vec();
        let hits = self
            .shard
            .segment()
            .recall(&q, &Filter::default(), top_k as usize)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(hits
            .into_iter()
            .map(|h| MnemeHit {
                slot_id: h.slot_id,
                score: h.score as f64,
                text: h.text,
            })
            .collect())
    }

    /// Delete (tombstone) a memory by slot id.
    #[napi]
    pub fn delete(&mut self, slot_id: u32) -> Result<()> {
        self.shard
            .segment()
            .delete(slot_id)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Number of live memories in the shard.
    #[napi]
    pub fn live_count(&mut self) -> u32 {
        self.shard.segment().live_count()
    }

    /// Compact the text region, reclaiming bytes of deleted memories. Returns bytes reclaimed.
    /// A maintenance op — run when the shard is idle.
    #[napi]
    pub fn compact(&mut self) -> Result<f64> {
        self.shard
            .segment()
            .compact()
            .map(|n| n as f64)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Flush to disk.
    #[napi]
    pub fn flush(&mut self) -> Result<()> {
        self.shard
            .segment()
            .flush()
            .map_err(|e| Error::from_reason(e.to_string()))
    }
}
