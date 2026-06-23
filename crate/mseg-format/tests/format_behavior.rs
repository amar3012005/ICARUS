//! Public-API behavior tests for the `.mseg` format: header validity, accessor
//! round-trips, flag ops, and zerocopy byte-round-trip (write struct -> bytes -> read).

use mseg_format::{flags, FileHeader, SlotHeader, FILE_HEADER_SIZE, SLOT_SIZE};
use zerocopy::{FromBytes, IntoBytes};

#[test]
fn file_header_new_is_valid_and_roundtrips() {
    let h = FileHeader::new(1024, 1_700_000_000);
    assert!(h.is_valid());
    assert_eq!(h.dim(), 1024);
    assert_eq!(h.slot_count(), 0);
    assert_eq!(h.live_count(), 0);
    assert_eq!(h.free_list_head(), mseg_format::SENTINEL_U32);
    assert_eq!(h.var_region_off(), mseg_format::SLOT_REGION_OFFSET as u32);
    assert_eq!(h.created_at_epoch(), 1_700_000_000);

    // zerocopy round-trip: struct -> bytes -> struct must be identical.
    let bytes = h.as_bytes();
    assert_eq!(bytes.len(), FILE_HEADER_SIZE);
    let h2 = FileHeader::read_from_bytes(bytes).unwrap();
    assert_eq!(h, h2);
}

#[test]
fn file_header_rejects_bad_magic() {
    let mut bytes = FileHeader::new(8, 0).as_bytes().to_vec();
    bytes[0] = b'X';
    let h = FileHeader::read_from_bytes(&bytes[..]).unwrap();
    assert!(!h.is_valid());
}

#[test]
fn slot_accessors_roundtrip() {
    let mut s = SlotHeader::empty();
    s.set_id(42);
    s.set_created_at(111);
    s.set_valid_from(222);
    s.set_text_ptr(1000);
    s.set_text_len_lz4(50);
    s.set_text_len_raw(80);
    s.set_entity_bitmap(0b1011);
    let pq = [7u8; 128];
    s.set_vector_pq(&pq);
    for i in 0..8 {
        s.set_adjacency(i, (i as u32) * 100);
    }

    assert_eq!(s.id(), 42);
    assert_eq!(s.created_at(), 111);
    assert_eq!(s.valid_from(), 222);
    assert_eq!(s.text_ptr(), 1000);
    assert_eq!(s.text_len_lz4(), 50);
    assert_eq!(s.text_len_raw(), 80);
    assert_eq!(s.entity_bitmap(), 0b1011);
    assert_eq!(s.vector_pq(), &pq);
    for i in 0..8 {
        assert_eq!(s.adjacency(i), (i as u32) * 100);
    }

    // zerocopy round-trip
    let bytes = s.as_bytes();
    assert_eq!(bytes.len(), SLOT_SIZE);
    let s2 = SlotHeader::read_from_bytes(bytes).unwrap();
    assert_eq!(s, s2);
}

#[test]
fn empty_slot_has_sentinel_adjacency_and_no_flags() {
    let s = SlotHeader::empty();
    assert_eq!(s.flags(), 0);
    assert!(!s.is_tombstoned());
    for i in 0..8 {
        assert_eq!(s.adjacency(i), mseg_format::SENTINEL_U32);
    }
}

#[test]
fn flag_set_clear_is_independent() {
    let mut s = SlotHeader::empty();
    s.set_flag(flags::TOMBSTONE);
    assert!(s.is_tombstoned());
    s.set_flag(flags::PQ_TRAINED);
    assert!(s.has_flag(flags::PQ_TRAINED));
    assert!(s.is_tombstoned()); // independent bits
    s.clear_flag(flags::TOMBSTONE);
    assert!(!s.is_tombstoned());
    assert!(s.has_flag(flags::PQ_TRAINED));
}
