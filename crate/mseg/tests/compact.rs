//! compact() (SPEC §5.5): reclaim tombstoned text bytes, keep live memories + stable ids.

use mseg::{Filter, MemoryInput, Segment};
use tempfile::tempdir;

fn big_text(i: usize) -> String {
    format!("memory-{i}-").repeat(200) // ~2.6 KB raw so the .txt growth is measurable
}

#[test]
fn compact_reclaims_tombstoned_text_and_keeps_live() {
    let dir = tempdir().unwrap();
    let mut seg = Segment::create(dir.path(), "s", 4).unwrap();

    // insert 100 big-text memories, then delete every other one.
    let mut ids = Vec::new();
    for i in 0..100 {
        ids.push(
            seg.insert(MemoryInput::new(big_text(i), vec![i as f32, 1.0, 0.0, 0.0]))
                .unwrap(),
        );
    }
    seg.flush().unwrap();
    let txt_path = dir.path().join("s.txt");
    let before = std::fs::metadata(&txt_path).unwrap().len();

    for (i, &id) in ids.iter().enumerate() {
        if i % 2 == 1 {
            seg.delete(id).unwrap();
        }
    }
    // delete must NOT shrink the text region (SPEC §6.4) — only compact does.
    seg.flush().unwrap();
    assert_eq!(
        std::fs::metadata(&txt_path).unwrap().len(),
        before,
        "delete shrank text early"
    );

    let reclaimed = seg.compact().unwrap();
    let after = std::fs::metadata(&txt_path).unwrap().len();
    assert!(
        after < before,
        "compact must shrink the text region ({after} !< {before})"
    );
    assert!(reclaimed > 0, "compact reported zero reclaimed");

    // every LIVE memory is still retrievable with correct text + stable id, after compact.
    for (i, &id) in ids.iter().enumerate() {
        if i % 2 == 0 {
            let hit = seg.get(id).unwrap();
            assert_eq!(hit.slot_id, id, "ids must be stable across compact");
            assert_eq!(hit.text, big_text(i), "live text corrupted by compact");
        } else {
            assert!(seg.get(id).is_err(), "deleted memory resurfaced");
        }
    }
}

#[test]
fn compact_survives_reopen() {
    let dir = tempdir().unwrap();
    {
        let mut seg = Segment::create(dir.path(), "s", 3).unwrap();
        for i in 0..50 {
            seg.insert(MemoryInput::new(big_text(i), vec![i as f32, 0.0, 1.0]))
                .unwrap();
        }
        for id in [1u32, 5, 9, 20, 33] {
            seg.delete(id).unwrap();
        }
        seg.compact().unwrap();
    }
    // reopen after compact: live memories intact, text decompresses correctly from the new file.
    let mut seg = Segment::open(dir.path(), "s").unwrap();
    assert_eq!(seg.get(0).unwrap().text, big_text(0));
    assert_eq!(seg.get(2).unwrap().text, big_text(2));
    assert!(seg.get(5).is_err());
    let hits = seg.recall(&[0.0, 0.0, 1.0], &Filter::default(), 5).unwrap();
    assert!(!hits.is_empty());
    for h in &hits {
        assert!(
            !h.text.is_empty(),
            "recall returned empty/corrupt text after compact"
        );
    }
}
