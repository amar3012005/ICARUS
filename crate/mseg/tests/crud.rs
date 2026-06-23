//! P2-3 + P2-4 acceptance: segment lifecycle + CRUD + invariants.

use mseg::{Filter, MemoryInput, Segment};
use mseg_format::SENTINEL_U32;
use proptest::prelude::*;
use tempfile::tempdir;

#[test]
fn create_open_roundtrip_header_consistent() {
    let dir = tempdir().unwrap();
    {
        let seg = Segment::create(dir.path(), "shard", 8).unwrap();
        assert_eq!(seg.dim(), 8);
        assert_eq!(seg.slot_count(), 0);
        assert_eq!(seg.live_count(), 0);
        assert_eq!(seg.free_list_head(), SENTINEL_U32);
    }
    let seg = Segment::open(dir.path(), "shard").unwrap();
    assert_eq!(seg.dim(), 8);
    assert!(seg.header().is_valid());
}

#[test]
fn insert_get_roundtrip_persists_across_reopen() {
    let dir = tempdir().unwrap();
    let id;
    {
        let mut seg = Segment::create(dir.path(), "s", 4).unwrap();
        let mut m = MemoryInput::new("hello memory", vec![0.1, 0.2, 0.3, 0.4]);
        m.entity_bitmap = 0b101;
        m.valid_from = 12345;
        id = seg.insert(m).unwrap();
        seg.flush().unwrap();
        assert_eq!(seg.live_count(), 1);
        assert_eq!(seg.slot_count(), 1);
    }
    let mut seg = Segment::open(dir.path(), "s").unwrap();
    let hit = seg.get(id).unwrap();
    assert_eq!(hit.text, "hello memory");
    assert_eq!(hit.entity_bitmap, 0b101);
    assert_eq!(hit.valid_from, 12345);
}

#[test]
fn delete_tombstones_and_frees_slot_for_reuse() {
    let dir = tempdir().unwrap();
    let mut seg = Segment::create(dir.path(), "s", 4).unwrap();
    let a = seg
        .insert(MemoryInput::new("first", vec![1.0, 0.0, 0.0, 0.0]))
        .unwrap();
    let _b = seg
        .insert(MemoryInput::new("second", vec![0.0, 1.0, 0.0, 0.0]))
        .unwrap();
    assert_eq!(seg.slot_count(), 2);

    seg.delete(a).unwrap();
    assert_eq!(seg.live_count(), 1);
    assert!(matches!(
        seg.get(a),
        Err(mseg::MsegError::TombstonedSlot(_))
    ));
    // idempotent
    seg.delete(a).unwrap();

    // next insert reuses the freed slot index (no slot_count growth)
    let c = seg
        .insert(MemoryInput::new("reused", vec![0.0, 0.0, 1.0, 0.0]))
        .unwrap();
    assert_eq!(c, a, "freed slot id should be reused");
    assert_eq!(seg.slot_count(), 2, "reuse must not grow the slot array");
    assert_eq!(seg.get(c).unwrap().text, "reused");
}

#[test]
fn recall_ranks_by_cosine_and_skips_tombstones() {
    let dir = tempdir().unwrap();
    let mut seg = Segment::create(dir.path(), "s", 4).unwrap();
    let near = seg
        .insert(MemoryInput::new("near", vec![1.0, 0.0, 0.0, 0.0]))
        .unwrap();
    let mid = seg
        .insert(MemoryInput::new("mid", vec![0.7, 0.7, 0.0, 0.0]))
        .unwrap();
    let far = seg
        .insert(MemoryInput::new("far", vec![0.0, 0.0, 0.0, 1.0]))
        .unwrap();

    let q = vec![1.0, 0.0, 0.0, 0.0];
    let hits = seg.recall(&q, &Filter::default(), 3).unwrap();
    assert_eq!(hits[0].slot_id, near);
    assert_eq!(hits[1].slot_id, mid);
    assert_eq!(hits[2].slot_id, far);
    assert!(hits[0].score > hits[1].score && hits[1].score > hits[2].score);

    seg.delete(near).unwrap();
    let hits = seg.recall(&q, &Filter::default(), 3).unwrap();
    assert!(
        !hits.iter().any(|h| h.slot_id == near),
        "tombstoned slot must not recall"
    );
    assert_eq!(hits.len(), 2);
    let _ = mid;
    let _ = far;
}

#[test]
fn recall_entity_and_temporal_filter() {
    let dir = tempdir().unwrap();
    let mut seg = Segment::create(dir.path(), "s", 4).unwrap();
    let mut m0 = MemoryInput::new("entity-A t100", vec![1.0, 0.0, 0.0, 0.0]);
    m0.entity_bitmap = 0b001;
    m0.created_at = Some(100);
    let mut m1 = MemoryInput::new("entity-B t200", vec![1.0, 0.0, 0.0, 0.0]);
    m1.entity_bitmap = 0b010;
    m1.created_at = Some(200);
    let id_a = seg.insert(m0).unwrap();
    let id_b = seg.insert(m1).unwrap();

    let q = vec![1.0, 0.0, 0.0, 0.0];
    // entity filter: only entity B (bit 1)
    let f = Filter {
        entity_mask: Some(0b010),
        ..Default::default()
    };
    let hits = seg.recall(&q, &f, 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].slot_id, id_b);

    // temporal filter: created_at in [150, 300] -> only B
    let f = Filter {
        created_at_range: Some((150, 300)),
        ..Default::default()
    };
    let hits = seg.recall(&q, &f, 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].slot_id, id_b);

    // created_at in [50, 150] -> only A
    let f = Filter {
        created_at_range: Some((50, 150)),
        ..Default::default()
    };
    let hits = seg.recall(&q, &f, 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].slot_id, id_a);
}

#[test]
fn growth_past_initial_capacity_preserves_all() {
    // INITIAL_SLOTS is 1024; insert > that to force a grow+remap and verify nothing is lost.
    let dir = tempdir().unwrap();
    let mut seg = Segment::create(dir.path(), "s", 2).unwrap();
    let n = 1100usize;
    for i in 0..n {
        let id = seg
            .insert(MemoryInput::new(
                format!("m{i}"),
                vec![i as f32, (i * 2) as f32],
            ))
            .unwrap();
        assert_eq!(id as usize, i);
    }
    assert_eq!(seg.slot_count() as usize, n);
    // spot-check the first, a middle, and the last survived the remap
    assert_eq!(seg.get(0).unwrap().text, "m0");
    assert_eq!(seg.get(500).unwrap().text, "m500");
    assert_eq!(seg.get((n - 1) as u32).unwrap().text, format!("m{}", n - 1));
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(30))]
    // Append-only invariant (SPEC §6.1): the .mseg file length is monotonically
    // non-decreasing across inserts, and every inserted id is retrievable.
    #[test]
    fn prop_append_only_and_all_retrievable(texts in proptest::collection::vec("[a-z ]{1,40}", 1..50)) {
        let dir = tempdir().unwrap();
        let mut seg = Segment::create(dir.path(), "s", 3).unwrap();
        let mseg_path = dir.path().join("s.mseg");
        let mut last_len = std::fs::metadata(&mseg_path).unwrap().len();
        let mut ids = Vec::new();
        for (i, t) in texts.iter().enumerate() {
            let id = seg.insert(MemoryInput::new(t.clone(), vec![i as f32, 1.0, -1.0])).unwrap();
            ids.push((id, t.clone()));
            let len = std::fs::metadata(&mseg_path).unwrap().len();
            prop_assert!(len >= last_len, "mseg file must never shrink on insert");
            last_len = len;
        }
        for (id, t) in ids {
            prop_assert_eq!(seg.get(id).unwrap().text, t);
        }
    }
}
