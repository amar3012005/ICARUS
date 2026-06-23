//! P3-2 acceptance: HNSW-backed recall agrees with the exact brute-force oracle, and recall
//! is non-blocking while async index adds are still pending (SPEC §6.2).

use mseg::{Filter, MemoryInput, Segment};
use std::path::PathBuf;
use tempfile::tempdir;

/// Deterministic clustered unit vector: `cluster` picks a base direction, `jitter` perturbs.
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
fn hnsw_recall_overlaps_brute_synthetic() {
    let dim = 64;
    let n = 2000usize;
    let dir = tempdir().unwrap();
    let mut seg = Segment::create(dir.path(), "s", dim).unwrap();
    for i in 0..n {
        let v = clustered(dim, (i % 40) as u64, i as u64 + 1);
        seg.insert(MemoryInput::new(format!("m{i}"), v)).unwrap();
    }
    seg.enable_hnsw().unwrap();
    seg.index_drain();
    assert_eq!(seg.hnsw_len(), n, "all vectors indexed");

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
            .recall(&q, &Filter::default(), k)
            .unwrap()
            .iter()
            .map(|h| h.slot_id)
            .collect();
        total += overlap(&exact, &approx);
    }
    let mean = total / nq as f64;
    assert!(
        mean >= 0.90,
        "HNSW vs brute overlap {mean:.3} < 0.90 (synthetic)"
    );
}

#[test]
fn hnsw_recall_with_entity_filter_matches_brute() {
    // P3-3: entity-bitmap O(1) filter over HNSW candidates must match brute-force-with-filter.
    let dim = 48;
    let n = 1500usize;
    let dir = tempdir().unwrap();
    let mut seg = Segment::create(dir.path(), "s", dim).unwrap();
    for i in 0..n {
        let mut m = MemoryInput::new(
            format!("m{i}"),
            clustered(dim, (i % 30) as u64, i as u64 + 1),
        );
        // assign one of 8 entity bits by i — a selective filter target.
        m.entity_bitmap = 1u64 << (i % 8);
        seg.insert(m).unwrap();
    }
    seg.enable_hnsw().unwrap();
    seg.index_drain();

    let k = 10;
    let filter = Filter {
        entity_mask: Some(0b0000_0001), // only slots with bit 0 (i % 8 == 0)
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
        let approx = seg.recall(&q, &filter, k).unwrap();
        // every returned hit must satisfy the entity filter
        for h in &approx {
            assert_eq!(
                h.entity_bitmap & 0b1,
                0b1,
                "filtered hit must match entity bit"
            );
        }
        let approx_ids: Vec<u32> = approx.iter().map(|h| h.slot_id).collect();
        total += overlap(&exact, &approx_ids);
    }
    let mean = total / nq as f64;
    assert!(
        mean >= 0.90,
        "entity-filtered HNSW vs brute overlap {mean:.3} < 0.90"
    );
}

#[test]
fn recall_is_nonblocking_with_pending_adds() {
    // Enable HNSW on an empty segment, then insert a burst WITHOUT draining; recall must
    // return promptly (it may miss the newest adds — that is allowed by SPEC §6.2).
    let dim = 16;
    let dir = tempdir().unwrap();
    let mut seg = Segment::create(dir.path(), "s", dim).unwrap();
    seg.enable_hnsw().unwrap();
    for i in 0..500 {
        seg.insert(MemoryInput::new(
            format!("m{i}"),
            clustered(dim, i % 8, i + 1),
        ))
        .unwrap();
    }
    // no drain: adds are in-flight. recall must not hang or panic.
    let q = clustered(dim, 0, 9999);
    let hits = seg.recall(&q, &Filter::default(), 5).unwrap();
    assert!(hits.len() <= 5);
}

#[test]
fn hnsw_recall_overlaps_brute_on_real_corpus() {
    // Runs only where the P1 real bge-m3 corpus exists (it is gitignored). Validates the
    // ≥0.97 overlap acceptance on production-like data.
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../bench/data");
    let corpus_p = base.join("corpus_f32.bin");
    let queries_p = base.join("queries_f32.bin");
    if !corpus_p.exists() || !queries_p.exists() {
        eprintln!("skip: real corpus not present at {base:?}");
        return;
    }
    let dim = 1024;
    let corpus = load_f32(&corpus_p, dim);
    let queries = load_f32(&queries_p, dim);

    let dir = tempdir().unwrap();
    let mut seg = Segment::create(dir.path(), "s", dim).unwrap();
    for (i, v) in corpus.iter().enumerate() {
        seg.insert(MemoryInput::new(format!("m{i}"), v.clone()))
            .unwrap();
    }
    seg.enable_hnsw().unwrap();
    seg.index_drain();

    let k = 10;
    let mut total = 0.0;
    for q in &queries {
        let exact: Vec<u32> = seg
            .recall_brute(q, &Filter::default(), k)
            .unwrap()
            .iter()
            .map(|h| h.slot_id)
            .collect();
        let approx: Vec<u32> = seg
            .recall(q, &Filter::default(), k)
            .unwrap()
            .iter()
            .map(|h| h.slot_id)
            .collect();
        total += overlap(&exact, &approx);
    }
    let mean = total / queries.len() as f64;
    eprintln!("real-corpus HNSW vs brute overlap = {mean:.4}");
    assert!(
        mean >= 0.97,
        "HNSW vs brute overlap {mean:.4} < 0.97 on real corpus"
    );
}

fn load_f32(path: &std::path::Path, dim: usize) -> Vec<Vec<f32>> {
    let bytes = std::fs::read(path).unwrap();
    bytes
        .chunks_exact(dim * 4)
        .map(|r| {
            r.chunks_exact(4)
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .collect()
        })
        .collect()
}
