//! P4-4: per-org PQ training integrated into the segment.

use mseg::{MemoryInput, Segment};
use tempfile::tempdir;

fn clustered(dim: usize, cluster: usize, jitter: u64) -> Vec<f32> {
    let mut v = vec![0.0f32; dim];
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

#[test]
fn train_pq_populates_codes_flag_and_codebook_file() {
    let dim = 128; // M=128 → 1 dim/subspace here; exercises the full code width
    let dir = tempdir().unwrap();
    let mut seg = Segment::create(dir.path(), "s", dim).unwrap();
    for i in 0..1500 {
        seg.insert(MemoryInput::new(
            format!("m{i}"),
            clustered(dim, i % 30, i as u64 + 1),
        ))
        .unwrap();
    }
    assert!(!seg.pq_trained());
    let _cb = seg.train_pq(2026).unwrap();
    assert!(
        seg.pq_trained(),
        "pq_codebook_off must be set after training"
    );

    // .mpq persisted next to the segment
    assert!(
        dir.path().join("s.mpq").exists(),
        "<name>.mpq must be written"
    );

    // every live slot now carries the PQ_TRAINED flag (vector_pq populated)
    use mseg::flags;
    for i in 0..seg.slot_count() as usize {
        let slot = seg.slot(i).unwrap();
        assert!(
            slot.has_flag(flags::PQ_TRAINED),
            "slot {i} missing PQ_TRAINED"
        );
    }

    // survives reopen (flag + codebook file persisted)
    drop(seg);
    let seg2 = Segment::open(dir.path(), "s").unwrap();
    assert!(seg2.pq_trained());
}
