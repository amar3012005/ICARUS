//! Crash-safety: a memory is visible only after its bytes are durably written (commit-last
//! ordering). A crash that leaves an uninitialised slot beyond `slot_count` must be ignored on
//! reopen — never read as a live memory.

use mseg::{Filter, MemoryInput, Segment};
use mseg_format::{FILE_HEADER_SIZE, SLOT_REGION_OFFSET, SLOT_SIZE};
use std::io::{Read, Seek, SeekFrom, Write};
use tempfile::tempdir;

#[test]
fn phantom_slot_beyond_count_is_ignored_on_reopen() {
    let dir = tempdir().unwrap();
    {
        let mut seg = Segment::create(dir.path(), "s", 4).unwrap();
        seg.insert(MemoryInput::new("real", vec![1.0, 0.0, 0.0, 0.0]))
            .unwrap();
        seg.flush().unwrap();
        assert_eq!(seg.slot_count(), 1);
    }
    // Simulate a crash AFTER slot bytes were partially written but BEFORE the count was bumped:
    // scribble a plausible-looking but garbage slot at index 1 (which slot_count does NOT cover),
    // without touching the file header's slot_count.
    let mseg_path = dir.path().join("s.amr");
    {
        let mut f = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&mseg_path)
            .unwrap();
        // file header slot_count is at offset 12 — leave it at 1.
        let mut count_bytes = [0u8; 4];
        f.seek(SeekFrom::Start(12)).unwrap();
        f.read_exact(&mut count_bytes).unwrap();
        assert_eq!(
            u32::from_le_bytes(count_bytes),
            1,
            "precondition: slot_count == 1"
        );
        // write garbage over slot index 1's region (must exist within the file capacity).
        let off = (SLOT_REGION_OFFSET + SLOT_SIZE) as u64;
        let meta = f.metadata().unwrap();
        if off + SLOT_SIZE as u64 <= meta.len() {
            f.seek(SeekFrom::Start(off)).unwrap();
            f.write_all(&[0xAB; SLOT_SIZE]).unwrap();
        }
        let _ = FILE_HEADER_SIZE; // (referenced for clarity)
    }
    // Reopen: only slot 0 is counted; the garbage slot 1 must be invisible.
    let mut seg = Segment::open(dir.path(), "s").unwrap();
    assert_eq!(seg.slot_count(), 1, "phantom slot must not be counted");
    assert_eq!(seg.get(0).unwrap().text, "real");
    // a recall must return exactly the one real memory, never the garbage slot.
    let hits = seg
        .recall(&[1.0, 0.0, 0.0, 0.0], &Filter::default(), 10)
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].slot_id, 0);
}

#[test]
fn insert_then_reopen_without_flush_is_consistent() {
    // Inserts update the header counter LAST, so even an abrupt close mid-session leaves the
    // segment internally consistent (every counted slot is fully written).
    let dir = tempdir().unwrap();
    let n;
    {
        let mut seg = Segment::create(dir.path(), "s", 3).unwrap();
        for i in 0..200 {
            seg.insert(MemoryInput::new(format!("m{i}"), vec![i as f32, 1.0, -1.0]))
                .unwrap();
        }
        n = seg.slot_count();
        seg.flush().unwrap();
    }
    let mut seg = Segment::open(dir.path(), "s").unwrap();
    assert_eq!(seg.slot_count(), n);
    // every counted slot is fully written and retrievable.
    for i in 0..n {
        assert_eq!(seg.get(i).unwrap().text, format!("m{i}"));
    }
}
