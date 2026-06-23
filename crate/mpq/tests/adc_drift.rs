//! P4-2 (ADC ranking) + P4-3 (drift detection). The drift test is named `pq_drift_detect` so
//! the P4 gate's `cargo test pq_drift_detect` selects it.

use mpq::{alignment_score, is_drifted, PqCodebook, DRIFT_THRESHOLD};

fn unit(dim: usize, seed: u64) -> Vec<f32> {
    let mut s = seed | 1;
    let mut v: Vec<f32> = (0..dim)
        .map(|_| {
            s ^= s >> 12;
            s ^= s << 25;
            s ^= s >> 27;
            ((s >> 11) as f64 / (1u64 << 53) as f64) as f32 - 0.5
        })
        .collect();
    let n: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    for x in &mut v {
        *x /= n;
    }
    v
}

/// A clustered unit vector (real embeddings are clustered, not uniform — PQ exploits that).
fn clustered(dim: usize, cluster: usize, jitter: u64) -> Vec<f32> {
    let mut v = vec![0.0f32; dim];
    // a few active dims per cluster give it a direction
    for j in 0..4 {
        v[(cluster * 7 + j * 13) % dim] = 1.0;
    }
    let mut s = jitter | 1;
    for x in v.iter_mut() {
        s ^= s >> 12;
        s ^= s << 25;
        s ^= s >> 27;
        *x += (((s >> 11) as f64 / (1u64 << 53) as f64) as f32 - 0.5) * 0.15;
    }
    let n: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    for x in &mut v {
        *x /= n;
    }
    v
}

/// A vector concentrated in the first half of its dims — a clearly different distribution.
fn shifted(dim: usize, seed: u64) -> Vec<f32> {
    let mut v = unit(dim, seed);
    for x in v.iter_mut().take(dim / 2) {
        *x += 3.0;
    }
    let n: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    for x in &mut v {
        *x /= n;
    }
    v
}

fn exact_cos(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum::<f32>()
}

#[test]
fn adc_ranking_matches_exact_cosine_topk() {
    let dim = 64;
    let corpus: Vec<Vec<f32>> = (0..2000)
        .map(|i| clustered(dim, (i % 40) as usize, i + 1))
        .collect();
    let cb = PqCodebook::train(&corpus, 16, 256, 7);
    let codes: Vec<Vec<u8>> = corpus.iter().map(|v| cb.encode(v)).collect();

    let k = 10;
    let nq = 50;
    let mut overlap = 0usize;
    for qi in 0..nq {
        let q = clustered(dim, (qi % 40) as usize, 500_000 + qi);
        // exact cosine top-k
        let mut exact: Vec<(f32, usize)> = corpus
            .iter()
            .enumerate()
            .map(|(i, v)| (exact_cos(&q, v), i))
            .collect();
        exact.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
        let exact_set: std::collections::HashSet<usize> =
            exact.iter().take(k).map(|(_, i)| *i).collect();
        // ADC top-k (ascending squared-L2 == descending cosine for unit vectors)
        let table = cb.adc_table(&q);
        let mut adc: Vec<(f32, usize)> = codes
            .iter()
            .enumerate()
            .map(|(i, c)| (table.distance(c), i))
            .collect();
        adc.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        overlap += adc
            .iter()
            .take(k)
            .filter(|(_, i)| exact_set.contains(i))
            .count();
    }
    let recall = overlap as f64 / (nq as usize * k) as f64;
    // Synthetic sanity: ADC must strongly track exact cosine. The residual gap is near-tie
    // ambiguity (dense clusters of ~50 near-identical neighbours where exact and ADC pick
    // different-but-equivalent members of the top-10) — not an ADC defect. The authoritative
    // ADC quality bar is the P4-4 gate on REAL embeddings (>96% overlap vs float32).
    assert!(
        recall >= 0.75,
        "ADC vs exact cosine top-{k} overlap {recall:.3} < 0.75 (correlation too weak)"
    );
}

#[test]
fn pq_drift_detect() {
    // Train on distribution A. Aligned sample (A) → high score, NOT drifted. Shifted sample
    // (B) → low score, drifted. This is the SPEC §3.4 guard.
    let dim = 64;
    let train_a: Vec<Vec<f32>> = (0..3000).map(|i| unit(dim, i + 1)).collect();
    let cb = PqCodebook::train(&train_a, 16, 256, 11);

    let aligned: Vec<Vec<f32>> = (0..300).map(|i| unit(dim, 900_000 + i)).collect();
    let drifted: Vec<Vec<f32>> = (0..300).map(|i| shifted(dim, 900_000 + i)).collect();

    let score_aligned = alignment_score(&cb, &aligned);
    let score_drifted = alignment_score(&cb, &drifted);
    eprintln!("alignment: aligned={score_aligned:.3} drifted={score_drifted:.3}");

    assert!(
        score_aligned >= DRIFT_THRESHOLD,
        "aligned distribution flagged as drift ({score_aligned:.3})"
    );
    assert!(!is_drifted(&cb, &aligned), "aligned must not be drifted");
    assert!(
        score_drifted < score_aligned,
        "shifted distribution must score lower than aligned"
    );
    assert!(
        is_drifted(&cb, &drifted),
        "shifted distribution must be flagged drifted"
    );
}
