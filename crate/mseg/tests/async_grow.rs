//! Regression: the async indexer must grow its HNSW capacity without deadlocking. The bg add
//! thread reserves (write lock) when the index outgrows its initial capacity; an earlier bug
//! held a read guard across that write on the same thread (std RwLock is not reentrant) and
//! wedged at 0% CPU. This test enables HNSW on a small segment, then inserts far past the
//! initial capacity through the async path, drains, and searches — if the deadlock returns the
//! test hangs (caught by the harness timeout).

use mseg::{Filter, MemoryInput, Segment};
use tempfile::tempdir;

#[test]
fn async_index_growth_does_not_deadlock() {
    let dir = tempdir().unwrap();
    let mut seg = Segment::create(dir.path(), "g", 8).unwrap();

    // small seed, then enable HNSW so subsequent inserts go through the async add path.
    for i in 0..16 {
        seg.insert(MemoryInput::new(format!("seed{i}"), unit(i, 8)))
            .unwrap();
    }
    seg.enable_hnsw().unwrap();

    // insert well past the initial capacity → forces the bg thread to reserve (write lock).
    for i in 16..4000 {
        seg.insert(MemoryInput::new(format!("m{i}"), unit(i, 8)))
            .unwrap();
    }
    // block until the bg indexer has applied every enqueued add (would never return if wedged).
    seg.index_drain();

    assert!(
        seg.hnsw_len() >= 3000,
        "bg indexer dropped adds: {}",
        seg.hnsw_len()
    );
    let hits = seg.recall(&unit(100, 8), &Filter::default(), 5).unwrap();
    assert_eq!(hits.len(), 5);
}

/// a deterministic unit vector seeded by `i`.
fn unit(i: usize, dim: usize) -> Vec<f32> {
    let mut v = vec![0.0f32; dim];
    for (j, x) in v.iter_mut().enumerate() {
        *x = (((i * 31 + j * 7) % 17) as f32) + 1.0;
    }
    let n: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    for x in &mut v {
        *x /= n;
    }
    v
}
