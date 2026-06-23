//! P3-1 acceptance: usearch HNSW wrapper — add/search, slot-id mapping, save/load round-trip.

use mnsw_index::MnswIndex;
use tempfile::tempdir;

fn unit(dim: usize, seed: u64) -> Vec<f32> {
    let mut s = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15).wrapping_add(1);
    let mut v: Vec<f32> = (0..dim)
        .map(|_| {
            s ^= s >> 12;
            s ^= s << 25;
            s ^= s >> 27;
            ((s >> 11) as f64 / (1u64 << 53) as f64) as f32 - 0.5
        })
        .collect();
    let n: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 0.0 {
        for x in &mut v {
            *x /= n;
        }
    }
    v
}

#[test]
fn add_then_self_search_returns_own_slot_id() {
    let dim = 32;
    let idx = MnswIndex::new(dim, 100).unwrap();
    let vecs: Vec<Vec<f32>> = (0..50).map(|i| unit(dim, i + 1)).collect();
    for (i, v) in vecs.iter().enumerate() {
        idx.add(i as u32, v).unwrap();
    }
    assert_eq!(idx.len(), 50);
    for (i, v) in vecs.iter().enumerate() {
        let hits = idx.search(v, 1).unwrap();
        assert_eq!(
            hits[0].slot_id, i as u32,
            "self-search must return own slot id"
        );
    }
}

#[test]
fn search_returns_k_sorted_candidates() {
    let dim = 16;
    let idx = MnswIndex::new(dim, 200).unwrap();
    for i in 0..120 {
        idx.add(i as u32, &unit(dim, i + 7)).unwrap();
    }
    let q = unit(dim, 9999);
    let hits = idx.search(&q, 10).unwrap();
    assert_eq!(hits.len(), 10);
    // distances are non-decreasing (closest first)
    for w in hits.windows(2) {
        assert!(w[0].distance <= w[1].distance + 1e-6);
    }
}

#[test]
fn save_load_roundtrip_preserves_results() {
    let dim = 24;
    let idx = MnswIndex::new(dim, 100).unwrap();
    let vecs: Vec<Vec<f32>> = (0..40).map(|i| unit(dim, i + 3)).collect();
    for (i, v) in vecs.iter().enumerate() {
        idx.add(i as u32, v).unwrap();
    }
    let dir = tempdir().unwrap();
    let path = dir.path().join("shard.mnsw");
    idx.save(&path).unwrap();

    let loaded = MnswIndex::load(&path, dim).unwrap();
    assert_eq!(loaded.len(), 40);
    for (i, v) in vecs.iter().enumerate() {
        assert!(loaded.contains(i as u32));
        let hits = loaded.search(v, 1).unwrap();
        assert_eq!(hits[0].slot_id, i as u32);
    }
}

#[test]
fn dim_mismatch_is_err() {
    let idx = MnswIndex::new(8, 10).unwrap();
    assert!(idx.add(0, &[0.0; 4]).is_err());
    assert!(idx.search(&[0.0; 16], 1).is_err());
}
