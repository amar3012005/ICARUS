//! Per-org Product Quantization integration (P4). Trains a codebook from the segment's raw
//! vectors, encodes each live slot's vector into its 128-byte `vector_pq` field, sets the
//! `PQ_TRAINED` flag, and persists `<name>.mpq`. The raw `.vec` side-file is KEPT for the
//! exact rescore pass (the production pattern that achieves >96% recall@10 — see P4 gate).
//!
//! Training is an explicit, offline-ish operation (called at the SPEC §3.1 trigger of ~10k
//! inserts, or on a drift-triggered retrain). It is NOT on the append path — `append.rs` has
//! no edge to it, so the write-path-isolation kill-condition holds. Drift retrain is likewise
//! *enqueued* by the caller, never run inline on insert.

use mpq::PqCodebook;
use mseg_format::{flags, MsegError, Result};

use crate::segment::Segment;

/// Default PQ subspace count for the 1024-dim production vectors (8 dims/subspace → 128-byte
/// code = the frozen `vector_pq` size). For other dims we fall back to the largest M ≤ 128 that
/// divides `dim` (still ≤ 128-byte code).
fn pick_m(dim: usize) -> usize {
    if dim % 128 == 0 {
        128
    } else {
        (1..=128).rev().find(|m| dim % m == 0).unwrap_or(1)
    }
}

impl Segment {
    /// Train this segment's PQ codebook on its live vectors, encode every live slot's
    /// `vector_pq`, set `PQ_TRAINED`, and save `<name>.mpq`. Deterministic given `seed`.
    /// Returns the trained codebook. Keeps the `.vec` side-file for exact rescore.
    pub fn train_pq(&mut self, seed: u64) -> Result<PqCodebook> {
        let n = self.slot_count() as usize;
        let dim = self.dim();
        // gather live vectors (and their slot indices).
        let mut idxs = Vec::new();
        let mut vecs: Vec<Vec<f32>> = Vec::new();
        for i in 0..n {
            if self.slot(i)?.is_tombstoned() {
                continue;
            }
            idxs.push(i);
            vecs.push(self.read_vector(i)?);
        }
        if vecs.is_empty() {
            return Err(MsegError::Corrupt(
                "cannot train PQ on an empty segment".into(),
            ));
        }
        let m = pick_m(dim);
        let cb = PqCodebook::train(&vecs, m, 256, seed);

        // encode each live slot into its vector_pq field (padded to the 128-byte field) + flag.
        for (k, &i) in idxs.iter().enumerate() {
            let code = cb.encode(&vecs[k]); // length m (== 128 for dim 1024)
            let mut field = [0u8; mseg_format::VECTOR_PQ_LEN];
            let len = code.len().min(field.len());
            field[..len].copy_from_slice(&code[..len]);
            let mut slot = self.slot(i)?;
            slot.set_vector_pq(&field);
            slot.set_flag(flags::PQ_TRAINED);
            self.write_slot(i, &slot)?;
        }

        // persist the codebook next to the segment as <name>.mpq, and record its offset != 0.
        let path = self.dir().join(format!("{}.mpq", self.name()));
        mpq::save(&cb, &path, 0).map_err(|e| MsegError::Index(e.to_string()))?;
        self.with_header_mut(|h| h.set_pq_codebook_off(1)); // non-zero = "PQ trained" (SPEC §3.3)
        self.flush()?;
        Ok(cb)
    }

    /// True if this segment has a trained PQ codebook (header `pq_codebook_off != 0`).
    pub fn pq_trained(&self) -> bool {
        self.header().pq_codebook_off() != 0
    }
}
