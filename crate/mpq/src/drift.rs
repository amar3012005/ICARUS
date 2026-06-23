//! Centroid drift detection (SPEC §3.4). As an org's vector distribution shifts away from the
//! one the codebook was trained on, PQ reconstruction quality degrades. We measure that with an
//! **alignment score** = mean cosine between each sampled vector and its PQ reconstruction. When
//! the score falls below [`DRIFT_THRESHOLD`], a retrain should be *enqueued* (never run inline —
//! that is enforced by the segment, and the `writepath_isolation` gate forbids `retrain_codebook`
//! on the append path).

use crate::codebook::PqCodebook;

/// Below this alignment score, the codebook is considered drifted (SPEC §3.4).
pub const DRIFT_THRESHOLD: f32 = 0.85;

/// Mean cosine similarity between each vector in `sample` and its PQ reconstruction.
/// 1.0 = perfect; lower = more reconstruction loss / drift.
pub fn alignment_score(cb: &PqCodebook, sample: &[Vec<f32>]) -> f32 {
    if sample.is_empty() {
        return 1.0;
    }
    let mut total = 0.0f32;
    for v in sample {
        let recon = cb.decode(&cb.encode(v));
        total += cosine(v, &recon);
    }
    total / sample.len() as f32
}

/// True if the codebook has drifted on `sample` (alignment below the threshold).
pub fn is_drifted(cb: &PqCodebook, sample: &[Vec<f32>]) -> bool {
    alignment_score(cb, sample) < DRIFT_THRESHOLD
}

#[inline]
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let na: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na * nb)
    }
}
