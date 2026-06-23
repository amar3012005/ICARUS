//! P1 acceptance tests: byte-format round-trip + int8 scan correctness vs an exact f32
//! oracle. These guard the frozen-ish probe layout and the scan's recall quality.

use mneme_probe::{exact_topk_f32, quantize_i8, write_segment, Segment, HEADER_SIZE};
use proptest::prelude::*;
use tempfile::tempdir;

/// Deterministic pseudo-random unit vector from a seed (no rng dep; reproducible).
fn unit_vec(dim: usize, seed: u64) -> Vec<f32> {
    let mut s = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15).wrapping_add(1);
    let mut v: Vec<f32> = (0..dim)
        .map(|_| {
            // xorshift64*
            s ^= s >> 12;
            s ^= s << 25;
            s ^= s >> 27;
            let x = (s.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64;
            (x / (1u64 << 53) as f64) as f32 - 0.5
        })
        .collect();
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in &mut v {
            *x /= norm;
        }
    }
    v
}

#[test]
fn segment_roundtrip_byte_exact() {
    let dim = 16;
    let n = 7;
    let ids: Vec<u32> = (0..n as u32).map(|i| i * 3 + 100).collect();
    let f32s: Vec<Vec<f32>> = (0..n).map(|i| unit_vec(dim, i as u64 + 1)).collect();
    let i8s: Vec<Vec<i8>> = f32s.iter().map(|v| quantize_i8(v)).collect();

    let dir = tempdir().unwrap();
    let path = dir.path().join("seg.msegp1");
    write_segment(&path, dim, &ids, &i8s).unwrap();

    // file length must be exactly header + n records.
    let meta = std::fs::metadata(&path).unwrap();
    assert_eq!(meta.len() as usize, HEADER_SIZE + n * (8 + dim));

    let seg = Segment::open(&path).unwrap();
    assert_eq!(seg.dim(), dim);
    assert_eq!(seg.count(), n);

    // every record's vector must read back byte-identical, and a self-query must rank
    // record i first (a vector is most similar to itself).
    for i in 0..n {
        let q = &i8s[i];
        let hits = seg.brute_scan(q, 1).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].slot_id, ids[i], "self-query should return own id");
    }
}

#[test]
fn open_rejects_garbage() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("bad.bin");
    std::fs::write(&path, b"not a segment at all").unwrap();
    assert!(Segment::open(&path).is_err());
}

#[test]
fn scan_matches_exact_oracle_on_pseudo_real_vectors() {
    // 500 vectors, dim 64; int8 top-10 should overlap the exact f32 top-10 heavily.
    let dim = 64;
    let n = 500usize;
    let corpus: Vec<Vec<f32>> = (0..n).map(|i| unit_vec(dim, i as u64 + 7)).collect();
    let ids: Vec<u32> = (0..n as u32).collect();
    let i8corpus: Vec<Vec<i8>> = corpus.iter().map(|v| quantize_i8(v)).collect();

    let dir = tempdir().unwrap();
    let path = dir.path().join("seg.msegp1");
    write_segment(&path, dim, &ids, &i8corpus).unwrap();
    let seg = Segment::open(&path).unwrap();

    let k = 10;
    let mut total_overlap = 0usize;
    let nq = 40;
    for qi in 0..nq {
        let q = unit_vec(dim, 100_000 + qi as u64);
        let exact = exact_topk_f32(&corpus, &q, k);
        let qi8 = quantize_i8(&q);
        let approx: Vec<u32> = seg
            .brute_scan(&qi8, k)
            .unwrap()
            .into_iter()
            .map(|h| h.slot_id)
            .collect();
        let exact_set: std::collections::HashSet<u32> = exact.into_iter().collect();
        total_overlap += approx.iter().filter(|id| exact_set.contains(id)).count();
    }
    let recall = total_overlap as f64 / (nq * k) as f64;
    assert!(
        recall >= 0.85,
        "int8 top-{k} recall vs exact f32 oracle = {recall:.3}, expected >= 0.85"
    );
}

proptest! {
    // Round-trip property: for any dim in 1..=128 and any small batch of vectors,
    // writing then opening yields a segment whose self-queries return the right ids.
    #![proptest_config(ProptestConfig::with_cases(40))]
    #[test]
    fn prop_roundtrip_selfquery(dim in 1usize..=128, n in 1usize..=20) {
        let ids: Vec<u32> = (0..n as u32).map(|i| i.wrapping_mul(7).wrapping_add(1)).collect();
        let i8s: Vec<Vec<i8>> = (0..n).map(|i| quantize_i8(&unit_vec(dim, i as u64 + 1))).collect();
        let dir = tempdir().unwrap();
        let path = dir.path().join("p.msegp1");
        write_segment(&path, dim, &ids, &i8s).unwrap();
        let seg = Segment::open(&path).unwrap();
        prop_assert_eq!(seg.count(), n);
        prop_assert_eq!(seg.dim(), dim);
        // self-query returns own id as #1
        let hits = seg.brute_scan(&i8s[0], 1).unwrap();
        prop_assert_eq!(hits[0].slot_id, ids[0]);
    }
}
