use mseg::{read_live_texts_read_only, MemoryInput, Segment};
use tempfile::tempdir;

#[test]
fn read_only_scan_reads_committed_live_text_without_a_writer_open() {
    let dir = tempdir().unwrap();
    {
        let mut segment = Segment::create(dir.path(), "shard", 4).unwrap();
        segment
            .insert(MemoryInput::new("durable evidence", vec![0.0; 4]))
            .unwrap();
        segment
            .insert(MemoryInput::new("another memory", vec![0.0; 4]))
            .unwrap();
        segment.flush().unwrap();
    }

    let records = read_live_texts_read_only(dir.path(), "shard").unwrap();
    assert_eq!(records.len(), 2);
    assert_eq!(records[0].slot_id, 0);
    assert_eq!(records[0].text, "durable evidence");
    assert_eq!(records[1].text, "another memory");
}
