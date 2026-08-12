//! T1-7 acceptance: PQ/ADC-backed recall (`recall_pq`) agrees with the exact brute-force oracle,
//! respects filters, and refuses cleanly when no codebook has been trained yet.

use mseg::{Filter, MemoryInput, Segment};
use tempfile::tempdir;

/// Deterministic clustered unit vector — identical generator to hnsw_recall.rs's, so PQ and
/// HNSW acceptance tests are directly comparable.
fn clustered(dim: usize, cluster: u64, jitter: u64) -> Vec<f32> {
    let mut v = vec![0.0f32; dim];
    let base = (cluster as usize) % dim;
    v[base] = 1.0;
    let mut s = jitter.wrapping_mul(0x9E37_79B9_7F4A_7C15).wrapping_add(1);
    for x in v.iter_mut() {
        s ^= s >> 12;
        s ^= s << 25;
        s ^= s >> 27;
        *x += (((s >> 11) as f64 / (1u64 << 53) as f64) as f32 - 0.5) * 0.2;
    }
    let n: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    for x in &mut v {
        *x /= n;
    }
    v
}

fn overlap(a: &[u32], b: &[u32]) -> f64 {
    let sb: std::collections::HashSet<u32> = b.iter().copied().collect();
    a.iter().filter(|x| sb.contains(x)).count() as f64 / a.len().max(1) as f64
}

#[test]
fn recall_pq_overlaps_brute_synthetic() {
    let dim = 128; // must be divisible by pick_m's chosen M
    let n = 2000usize;
    let dir = tempdir().unwrap();
    let mut seg = Segment::create(dir.path(), "s", dim).unwrap();
    for i in 0..n {
        let v = clustered(dim, (i % 40) as u64, i as u64 + 1);
        seg.insert(MemoryInput::new(format!("m{i}"), v)).unwrap();
    }
    seg.train_pq(42).unwrap();
    assert!(seg.pq_trained());

    let k = 10;
    let mut total = 0.0;
    let nq = 40;
    for qi in 0..nq {
        let q = clustered(dim, qi % 40, 100_000 + qi);
        let exact: Vec<u32> = seg
            .recall_brute(&q, &Filter::default(), k)
            .unwrap()
            .iter()
            .map(|h| h.slot_id)
            .collect();
        let approx: Vec<u32> = seg
            .recall_pq(&q, &Filter::default(), k)
            .unwrap()
            .iter()
            .map(|h| h.slot_id)
            .collect();
        total += overlap(&exact, &approx);
    }
    let mean = total / nq as f64;
    assert!(mean >= 0.90, "PQ vs brute overlap {mean:.3} < 0.90 (synthetic)");
}

#[test]
fn recall_pq_with_entity_filter_matches_brute() {
    let dim = 128;
    let n = 1500usize;
    let dir = tempdir().unwrap();
    let mut seg = Segment::create(dir.path(), "s", dim).unwrap();
    for i in 0..n {
        let mut m = MemoryInput::new(format!("m{i}"), clustered(dim, (i % 30) as u64, i as u64 + 1));
        m.entity_bitmap = 1u64 << (i % 8);
        seg.insert(m).unwrap();
    }
    seg.train_pq(7).unwrap();

    let k = 10;
    let filter = Filter {
        entity_mask: Some(0b0000_0001),
        ..Default::default()
    };
    let mut total = 0.0;
    let nq = 30;
    for qi in 0..nq {
        let q = clustered(dim, qi % 30, 200_000 + qi);
        let exact: Vec<u32> = seg
            .recall_brute(&q, &filter, k)
            .unwrap()
            .iter()
            .map(|h| h.slot_id)
            .collect();
        let approx = seg.recall_pq(&q, &filter, k).unwrap();
        for h in &approx {
            assert_eq!(h.entity_bitmap & 0b1, 0b1, "filtered hit must match entity bit");
        }
        let approx_ids: Vec<u32> = approx.iter().map(|h| h.slot_id).collect();
        total += overlap(&exact, &approx_ids);
    }
    let mean = total / nq as f64;
    assert!(mean >= 0.90, "entity-filtered PQ vs brute overlap {mean:.3} < 0.90");
}

#[test]
fn recall_pq_errors_before_training() {
    let dim = 64;
    let dir = tempdir().unwrap();
    let mut seg = Segment::create(dir.path(), "s", dim).unwrap();
    seg.insert(MemoryInput::new("m0".to_string(), clustered(dim, 0, 1)))
        .unwrap();
    assert!(!seg.pq_trained());
    let q = clustered(dim, 0, 2);
    let err = seg.recall_pq(&q, &Filter::default(), 5);
    assert!(err.is_err(), "recall_pq must error before train_pq() has run");
}

#[test]
fn recall_pq_survives_flush_and_reload() {
    // The codebook cache is process-local; a reopened segment must reload `<name>.mpq` from
    // disk transparently (pq_codebook()'s lazy-load path), not silently lose PQ capability.
    let dim = 128;
    let n = 500usize;
    let dir = tempdir().unwrap();
    {
        let mut seg = Segment::create(dir.path(), "s", dim).unwrap();
        for i in 0..n {
            seg.insert(MemoryInput::new(format!("m{i}"), clustered(dim, (i % 20) as u64, i as u64 + 1)))
                .unwrap();
        }
        seg.train_pq(1).unwrap();
        seg.flush().unwrap();
    }
    let mut reopened = Segment::open(dir.path(), "s").unwrap();
    assert!(reopened.pq_trained(), "PQ_TRAINED flag must survive reopen");
    let q = clustered(dim, 0, 999);
    let hits = reopened.recall_pq(&q, &Filter::default(), 5).unwrap();
    assert!(!hits.is_empty(), "recall_pq must work on a freshly reopened segment");
}
