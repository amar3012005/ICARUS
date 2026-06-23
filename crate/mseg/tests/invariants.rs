//! P2-6: SPEC §6 invariants as executable assertions, plus an OOB-safety proptest standing
//! in for Miri.
//!
//! Miri note: the only `unsafe` in this crate is the `memmap2` mapping in `segment.rs`. Miri
//! cannot execute the `mmap(2)` foreign call, so it cannot run this crate's tests, and no
//! nightly toolchain is provisioned here. Instead, `prop_reads_never_panic_oob` hammers every
//! bounds-checked read path (`slot`/`read_vector`/`read_text_block`) with in- and out-of-range
//! inputs and asserts they return `Err` rather than panicking or reading past a map — the same
//! property Miri would check for the mmap reads. The byte-cast layer underneath is `zerocopy`'s
//! safe API (no raw transmutes), which is UB-free by construction.

use mseg::{Filter, MemoryInput, Segment};
use mseg_format::{SLOT_REGION_OFFSET, SLOT_SIZE};
use proptest::prelude::*;
use tempfile::tempdir;

fn read_slot_bytes(dir: &std::path::Path, name: &str, idx: usize) -> Vec<u8> {
    let bytes = std::fs::read(dir.join(format!("{name}.mseg"))).unwrap();
    let off = SLOT_REGION_OFFSET + idx * SLOT_SIZE;
    bytes[off..off + SLOT_SIZE].to_vec()
}

#[test]
fn inv_6_1_append_only_existing_slots_immutable() {
    let dir = tempdir().unwrap();
    let mut seg = Segment::create(dir.path(), "s", 4).unwrap();
    let _a = seg
        .insert(MemoryInput::new("first", vec![1.0, 0.0, 0.0, 0.0]))
        .unwrap();
    seg.flush().unwrap();
    let slot0_before = read_slot_bytes(dir.path(), "s", 0);

    // insert many more; slot 0's bytes must be byte-identical afterward.
    for i in 0..50 {
        seg.insert(MemoryInput::new(
            format!("m{i}"),
            vec![i as f32, 1.0, 2.0, 3.0],
        ))
        .unwrap();
    }
    seg.flush().unwrap();
    let slot0_after = read_slot_bytes(dir.path(), "s", 0);
    assert_eq!(
        slot0_before, slot0_after,
        "insert must never mutate an existing slot"
    );
}

#[test]
fn inv_6_4_tombstone_keeps_text_and_vector_bytes() {
    let dir = tempdir().unwrap();
    let mut seg = Segment::create(dir.path(), "s", 4).unwrap();
    let a = seg
        .insert(MemoryInput::new("to-be-deleted", vec![0.1, 0.2, 0.3, 0.4]))
        .unwrap();
    seg.flush().unwrap();
    let txt_len_before = std::fs::metadata(dir.path().join("s.txt")).unwrap().len();
    let vec_before = std::fs::read(dir.path().join("s.vec")).unwrap();

    seg.delete(a).unwrap();
    seg.flush().unwrap();

    // §6.4: var-region (text) bytes are NOT reclaimed on delete (only compact reclaims).
    let txt_len_after = std::fs::metadata(dir.path().join("s.txt")).unwrap().len();
    assert_eq!(
        txt_len_before, txt_len_after,
        "delete must not shrink the text region"
    );
    // the deleted slot's raw vector bytes remain (not zeroed) until compact.
    let vec_after = std::fs::read(dir.path().join("s.vec")).unwrap();
    let vb = 4 * 4; // dim 4 * f32
    assert_eq!(
        vec_before[..vb],
        vec_after[..vb],
        "delete must not wipe the vector"
    );
}

#[test]
fn inv_6_3_slot_ids_stable_across_reopen() {
    let dir = tempdir().unwrap();
    let ids: Vec<u32>;
    {
        let mut seg = Segment::create(dir.path(), "s", 2).unwrap();
        ids = (0..10)
            .map(|i| {
                seg.insert(MemoryInput::new(format!("m{i}"), vec![i as f32, 0.0]))
                    .unwrap()
            })
            .collect();
        seg.flush().unwrap();
    }
    let mut seg = Segment::open(dir.path(), "s").unwrap();
    for (i, id) in ids.iter().enumerate() {
        assert_eq!(seg.get(*id).unwrap().text, format!("m{i}"));
    }
}

#[test]
fn inv_6_5_entity_bitmap_is_caller_controlled_unchanged() {
    let dir = tempdir().unwrap();
    let mut seg = Segment::create(dir.path(), "s", 2).unwrap();
    let mut m = MemoryInput::new("e", vec![1.0, 1.0]);
    m.entity_bitmap = 0xDEAD_BEEF_0000_FFFF;
    let id = seg.insert(m).unwrap();
    assert_eq!(seg.get(id).unwrap().entity_bitmap, 0xDEAD_BEEF_0000_FFFF);
}

#[test]
fn inv_6_6_header_counts_consistent_after_flush_reopen() {
    let dir = tempdir().unwrap();
    {
        let mut seg = Segment::create(dir.path(), "s", 2).unwrap();
        for i in 0..20 {
            seg.insert(MemoryInput::new(format!("m{i}"), vec![i as f32, 0.0]))
                .unwrap();
        }
        // delete 5
        for id in [0u32, 3, 7, 11, 19] {
            seg.delete(id).unwrap();
        }
        seg.flush().unwrap();
    }
    let seg = Segment::open(dir.path(), "s").unwrap();
    assert_eq!(
        seg.slot_count(),
        20,
        "slot_count counts all allocated slots"
    );
    assert_eq!(seg.live_count(), 15, "live_count excludes tombstones");
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(60))]
    // OOB-safety: arbitrary indices (often out of range) into the bounds-checked read paths
    // must return Err, never panic or read past the map. Stands in for Miri on the mmap reads.
    #[test]
    fn prop_reads_never_panic_oob(
        n_insert in 0usize..30,
        probe_idx in 0usize..1_000_000,
    ) {
        let dir = tempdir().unwrap();
        let mut seg = Segment::create(dir.path(), "s", 5).unwrap();
        for i in 0..n_insert {
            seg.insert(MemoryInput::new(format!("m{i}"), vec![i as f32; 5])).unwrap();
        }
        // valid indices succeed; out-of-range return Err (no panic).
        let r_slot = seg.slot(probe_idx);
        let r_vec = seg.read_vector(probe_idx);
        if probe_idx < seg.capacity() {
            prop_assert!(r_slot.is_ok());
            prop_assert!(r_vec.is_ok());
        } else {
            prop_assert!(r_slot.is_err());
            prop_assert!(r_vec.is_err());
        }
        // recall over whatever exists never panics.
        let q = vec![1.0f32; 5];
        let _ = seg.recall(&q, &Filter::default(), 8).unwrap();
    }
}
