//! `.mseg` file header (64 B) and slot header (202 B) — the frozen SPEC §1 byte layout.
//!
//! On-disk fields are stored as **little-endian byte arrays**, not native-endian typed
//! fields (SPEC §1.1). Every field is align-1, so the structs are `#[repr(C)]` with zero
//! padding: `size_of` and every field offset match the spec exactly on every platform,
//! and `zerocopy` can cast them off an mmap with no alignment hazard. Typed access goes
//! through explicit `*_le_bytes` accessors, so the format is byte-identical on little- and
//! big-endian hosts.

use zerocopy::{FromBytes, FromZeros, Immutable, IntoBytes, KnownLayout};

/// File magic (SPEC §1.2): `b"AMR\0\0\0"`, 6 bytes.
pub const MAGIC: [u8; 6] = *b"AMR\0\0\0";
/// Format version. v1 adds the crash-safety `committed_count` checkpoint (reserves_0 → committed).
/// v0 shards predate it and are trusted as fully committed on open (back-compat).
pub const FORMAT_VERSION: u16 = 1;
/// File header size in bytes (SPEC §1.2).
pub const FILE_HEADER_SIZE: usize = 64;
/// Slot header size in bytes (SPEC §1.3) — the authoritative frozen value.
pub const SLOT_SIZE: usize = 202;
/// Sentinel for an empty free list / empty adjacency entry (SPEC §1.3, §1.6).
pub const SENTINEL_U32: u32 = 0xFFFF_FFFF;
/// Slot region starts at the first 4096-byte boundary after the file header (SPEC §1.1).
pub const SLOT_REGION_OFFSET: usize = 4096;
/// Length of the PQ code field in a slot (SPEC §1.3).
pub const VECTOR_PQ_LEN: usize = 128;
/// Number of inline graph neighbours per slot (SPEC §1.3).
pub const ADJACENCY_LEN: usize = 8;
/// Max raw text bytes per memory (SPEC §1.5).
pub const MAX_TEXT_BYTES: usize = 65_536;

/// Slot flag bits (SPEC §1.4).
pub mod flags {
    /// Slot is deleted; skipped in recall; eligible for compact.
    pub const TOMBSTONE: u16 = 0x0001;
    /// `vector_pq` is valid (0 = not yet quantized; raw vector lives in the `.vec` side-file).
    pub const PQ_TRAINED: u16 = 0x0002;
    /// Text fits inline in `text_ptr` (reserved optimization).
    pub const TEXT_INLINE: u16 = 0x0004;
    /// Adjacency list is stale; async rebuild pending.
    pub const GRAPH_DIRTY: u16 = 0x0008;
    /// Typed edges overflowed the inline slots: edge[0]'s 8 bytes are a `{ptr:u32, count:u32}`
    /// descriptor into the `.edg` side-file; all edges live there (the memory-engine layer).
    pub const EDGE_OVERFLOW: u16 = 0x0010;
    /// A non-latest version superseded by a newer one (linked via an `Updates` edge). Excluded
    /// from vector recall, retained for bi-temporal `as_of` queries.
    pub const SUPERSEDED: u16 = 0x0020;
    /// Layer tag occupies flag bits 8-9 (mask 0x0300): 0=memory (default), 1=evidence, 2=cognitive.
    /// Lets one .amr shard hold all 3 HIVEMIND layers, filtered per query exactly like Qdrant's
    /// `layer` payload field — memory for recall, evidence for provenance, cognitive for synthesis.
    pub const LAYER_MASK: u16 = 0x0300;
}

/// The 64-byte `.mseg` file header (SPEC §1.2). Offsets are exact; see the field table.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, FromBytes, IntoBytes, Immutable, KnownLayout)]
pub struct FileHeader {
    magic: [u8; 6],            // 0
    format_version: [u8; 2],   // 6
    dim: [u8; 4],              // 8
    slot_count: [u8; 4],       // 12
    live_count: [u8; 4],       // 16
    free_list_head: [u8; 4],   // 20
    var_region_off: [u8; 4],   // 24
    var_region_len: [u8; 4],   // 28
    pq_codebook_off: [u8; 4],  // 32
    committed_count: [u8; 4],  // 36 — v1 crash-safety checkpoint (durably-committed slot count)
    created_at_epoch: [u8; 8], // 40
    last_compact_at: [u8; 8],  // 48
    reserved_1: [u8; 8],       // 56
}

impl FileHeader {
    /// Build a fresh header for a new, empty segment of dimension `dim`.
    /// `created_at_epoch` is unix seconds; the slot region begins at `SLOT_REGION_OFFSET`
    /// and the variable region begins right after the (empty) slot array.
    pub fn new(dim: u32, created_at_epoch: i64) -> Self {
        let mut h = FileHeader::new_zeroed();
        h.magic = MAGIC;
        h.set_format_version(FORMAT_VERSION);
        h.set_dim(dim);
        h.set_slot_count(0);
        h.set_live_count(0);
        h.set_free_list_head(SENTINEL_U32);
        // var region starts at the slot-region offset until slots are appended; the
        // segment manager (P2-3) advances it as the slot array grows.
        h.set_var_region_off(SLOT_REGION_OFFSET as u32);
        h.set_var_region_len(0);
        h.set_pq_codebook_off(0);
        h.set_created_at_epoch(created_at_epoch);
        h.set_last_compact_at(0);
        h
    }

    /// True if the magic matches and the version is one this build can read (v0 legacy or v1).
    pub fn is_valid(&self) -> bool {
        self.magic == MAGIC && self.format_version() <= FORMAT_VERSION
    }

    pub fn magic(&self) -> [u8; 6] {
        self.magic
    }
    pub fn format_version(&self) -> u16 {
        u16::from_le_bytes(self.format_version)
    }
    pub fn set_format_version(&mut self, v: u16) {
        self.format_version = v.to_le_bytes();
    }
    pub fn dim(&self) -> u32 {
        u32::from_le_bytes(self.dim)
    }
    pub fn set_dim(&mut self, v: u32) {
        self.dim = v.to_le_bytes();
    }
    pub fn slot_count(&self) -> u32 {
        u32::from_le_bytes(self.slot_count)
    }
    pub fn set_slot_count(&mut self, v: u32) {
        self.slot_count = v.to_le_bytes();
    }
    /// Durably-committed slot count (v1 crash-safety checkpoint). Slots in `[committed_count,
    /// slot_count)` were appended but not yet flushed; `open()` discards them after a crash.
    pub fn committed_count(&self) -> u32 {
        u32::from_le_bytes(self.committed_count)
    }
    pub fn set_committed_count(&mut self, v: u32) {
        self.committed_count = v.to_le_bytes();
    }
    pub fn live_count(&self) -> u32 {
        u32::from_le_bytes(self.live_count)
    }
    pub fn set_live_count(&mut self, v: u32) {
        self.live_count = v.to_le_bytes();
    }
    pub fn free_list_head(&self) -> u32 {
        u32::from_le_bytes(self.free_list_head)
    }
    pub fn set_free_list_head(&mut self, v: u32) {
        self.free_list_head = v.to_le_bytes();
    }
    pub fn var_region_off(&self) -> u32 {
        u32::from_le_bytes(self.var_region_off)
    }
    pub fn set_var_region_off(&mut self, v: u32) {
        self.var_region_off = v.to_le_bytes();
    }
    pub fn var_region_len(&self) -> u32 {
        u32::from_le_bytes(self.var_region_len)
    }
    pub fn set_var_region_len(&mut self, v: u32) {
        self.var_region_len = v.to_le_bytes();
    }
    pub fn pq_codebook_off(&self) -> u32 {
        u32::from_le_bytes(self.pq_codebook_off)
    }
    pub fn set_pq_codebook_off(&mut self, v: u32) {
        self.pq_codebook_off = v.to_le_bytes();
    }
    pub fn created_at_epoch(&self) -> i64 {
        i64::from_le_bytes(self.created_at_epoch)
    }
    pub fn set_created_at_epoch(&mut self, v: i64) {
        self.created_at_epoch = v.to_le_bytes();
    }
    pub fn last_compact_at(&self) -> i64 {
        i64::from_le_bytes(self.last_compact_at)
    }
    pub fn set_last_compact_at(&mut self, v: i64) {
        self.last_compact_at = v.to_le_bytes();
    }
}

/// The 202-byte `.mseg` slot header (SPEC §1.3). Exact offsets; align-1; no padding.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, FromBytes, IntoBytes, Immutable, KnownLayout)]
pub struct SlotHeader {
    id: [u8; 4],                        // 0
    flags: [u8; 2],                     // 4
    created_at: [u8; 8],                // 6   (nanoseconds)
    valid_from: [u8; 8],                // 14  (nanoseconds)
    text_ptr: [u8; 4],                  // 22
    text_len_lz4: [u8; 4],              // 26
    text_len_raw: [u8; 4],              // 30
    vector_pq: [u8; VECTOR_PQ_LEN],     // 34
    entity_bitmap: [u8; 8],             // 162
    adjacency: [u8; ADJACENCY_LEN * 4], // 170 (8 × u32)
}

impl SlotHeader {
    /// A zeroed slot with all adjacency entries set to the empty sentinel and no flags.
    pub fn empty() -> Self {
        let mut s = SlotHeader::new_zeroed();
        for i in 0..ADJACENCY_LEN {
            s.set_adjacency(i, SENTINEL_U32);
        }
        s
    }

    pub fn id(&self) -> u32 {
        u32::from_le_bytes(self.id)
    }
    pub fn set_id(&mut self, v: u32) {
        self.id = v.to_le_bytes();
    }
    pub fn flags(&self) -> u16 {
        u16::from_le_bytes(self.flags)
    }
    pub fn set_flags(&mut self, v: u16) {
        self.flags = v.to_le_bytes();
    }
    /// True if any bit of `mask` is set in this slot's flags.
    pub fn has_flag(&self, mask: u16) -> bool {
        self.flags() & mask != 0
    }
    pub fn set_flag(&mut self, mask: u16) {
        let v = self.flags() | mask;
        self.set_flags(v);
    }
    /// The slot's layer (0=memory, 1=evidence, 2=cognitive), stored in flag bits 8-9.
    pub fn layer(&self) -> u8 {
        ((self.flags() & flags::LAYER_MASK) >> 8) as u8
    }
    pub fn set_layer(&mut self, layer: u8) {
        let v = (self.flags() & !flags::LAYER_MASK) | (((layer as u16) << 8) & flags::LAYER_MASK);
        self.set_flags(v);
    }
    pub fn clear_flag(&mut self, mask: u16) {
        let v = self.flags() & !mask;
        self.set_flags(v);
    }
    pub fn is_tombstoned(&self) -> bool {
        self.has_flag(flags::TOMBSTONE)
    }
    /// A superseded (non-latest) version: kept for bi-temporal `as_of` queries, but excluded from
    /// vector recall (which returns only the latest version — HIVEMIND `is_latest=true` parity).
    pub fn is_superseded(&self) -> bool {
        self.has_flag(flags::SUPERSEDED)
    }

    pub fn created_at(&self) -> i64 {
        i64::from_le_bytes(self.created_at)
    }
    pub fn set_created_at(&mut self, v: i64) {
        self.created_at = v.to_le_bytes();
    }
    pub fn valid_from(&self) -> i64 {
        i64::from_le_bytes(self.valid_from)
    }
    pub fn set_valid_from(&mut self, v: i64) {
        self.valid_from = v.to_le_bytes();
    }
    pub fn text_ptr(&self) -> u32 {
        u32::from_le_bytes(self.text_ptr)
    }
    pub fn set_text_ptr(&mut self, v: u32) {
        self.text_ptr = v.to_le_bytes();
    }
    pub fn text_len_lz4(&self) -> u32 {
        u32::from_le_bytes(self.text_len_lz4)
    }
    pub fn set_text_len_lz4(&mut self, v: u32) {
        self.text_len_lz4 = v.to_le_bytes();
    }
    pub fn text_len_raw(&self) -> u32 {
        u32::from_le_bytes(self.text_len_raw)
    }
    pub fn set_text_len_raw(&mut self, v: u32) {
        self.text_len_raw = v.to_le_bytes();
    }

    pub fn vector_pq(&self) -> &[u8; VECTOR_PQ_LEN] {
        &self.vector_pq
    }
    pub fn set_vector_pq(&mut self, v: &[u8; VECTOR_PQ_LEN]) {
        self.vector_pq = *v;
    }

    pub fn entity_bitmap(&self) -> u64 {
        u64::from_le_bytes(self.entity_bitmap)
    }
    pub fn set_entity_bitmap(&mut self, v: u64) {
        self.entity_bitmap = v.to_le_bytes();
    }

    /// Read adjacency entry `i` (0..ADJACENCY_LEN). `SENTINEL_U32` means empty.
    pub fn adjacency(&self, i: usize) -> u32 {
        let o = i * 4;
        u32::from_le_bytes(self.adjacency[o..o + 4].try_into().unwrap())
    }
    pub fn set_adjacency(&mut self, i: usize, v: u32) {
        let o = i * 4;
        self.adjacency[o..o + 4].copy_from_slice(&v.to_le_bytes());
    }

    // --- Typed edges (memory-engine layer) --------------------------------------------------
    // The 32-byte adjacency region is reinterpreted as `EDGE_SLOTS` typed edges of 8 bytes each:
    //   target: u32 (bytes 0..4) · edge_type: u8 (4) · weight: u8 (5) · reserved: u16 (6..8).
    // `adjacency[0]` (== edge 0's target) still doubles as the free-list next-pointer on
    // tombstoned slots (SPEC §1.6), which is compatible (type/weight bytes are unused there).

    /// Read typed edge `i` (0..EDGE_SLOTS) as `(target_slot, edge_type, weight)`.
    /// `target == SENTINEL_U32` or `edge_type == EDGE_NONE` means empty.
    pub fn edge(&self, i: usize) -> (u32, u8, u8) {
        let o = i * 8;
        let target = u32::from_le_bytes(self.adjacency[o..o + 4].try_into().unwrap());
        (target, self.adjacency[o + 4], self.adjacency[o + 5])
    }
    /// Write typed edge `i`: `target` slot id, `edge_type` (EDGE_*), `weight` (0..=255).
    pub fn set_edge(&mut self, i: usize, target: u32, edge_type: u8, weight: u8) {
        let o = i * 8;
        self.adjacency[o..o + 4].copy_from_slice(&target.to_le_bytes());
        self.adjacency[o + 4] = edge_type;
        self.adjacency[o + 5] = weight;
    }

    /// When the `EDGE_OVERFLOW` flag is set, edge[0]'s 8 bytes are a `.edg` descriptor:
    /// byte offset (u32) + edge count (u32). Read it.
    pub fn edge_overflow(&self) -> (u32, u32) {
        let ptr = u32::from_le_bytes(self.adjacency[0..4].try_into().unwrap());
        let count = u32::from_le_bytes(self.adjacency[4..8].try_into().unwrap());
        (ptr, count)
    }
    /// Set the overflow descriptor (`.edg` byte offset + edge count) into edge[0]'s 8 bytes.
    pub fn set_edge_overflow(&mut self, ptr: u32, count: u32) {
        self.adjacency[0..4].copy_from_slice(&ptr.to_le_bytes());
        self.adjacency[4..8].copy_from_slice(&count.to_le_bytes());
    }
}

/// Number of typed-edge slots inline per memory (32-byte region / 8 bytes per edge).
pub const EDGE_SLOTS: usize = 4;
/// Bytes per serialized edge in the `.edg` overflow region: target u32 · type u8 · weight u8 · pad.
pub const EDGE_WIRE_BYTES: usize = 8;

// HIVEMIND's 3 cognitive layers, stored per-slot in flag bits 8-9 (see flags::LAYER_MASK).
// memory = recalled facts (default); evidence = raw segments (recall-excluded provenance);
// cognitive = synthesized/dream memories.
pub const LAYER_MEMORY: u8 = 0;
pub const LAYER_EVIDENCE: u8 = 1;
pub const LAYER_COGNITIVE: u8 = 2;

// Typed edge kinds (mirror HIVEMIND's memory-graph relationships). EDGE_UPDATES encodes a
// version-supersession link: v_new --Updates--> v_old, which drives bi-temporal "as of date X".
pub const EDGE_NONE: u8 = 0;
pub const EDGE_MENTIONS: u8 = 1;
pub const EDGE_UPDATES: u8 = 2;
pub const EDGE_DERIVES: u8 = 3;
pub const EDGE_CONTRADICTS: u8 = 4;
pub const EDGE_PARTOF: u8 = 5;
pub const EDGE_EXTENDS: u8 = 6;

#[cfg(test)]
mod spec_lock {
    //! Byte-for-byte lock against the FROZEN SPEC §1.2/§1.3. If any of these fail, the
    //! on-disk format has drifted from the spec — a frozen-scope violation, not a free edit.
    use super::*;
    use core::mem::{align_of, offset_of, size_of};

    #[test]
    fn file_header_is_64_bytes_align_1() {
        assert_eq!(size_of::<FileHeader>(), FILE_HEADER_SIZE);
        assert_eq!(size_of::<FileHeader>(), 64);
        assert_eq!(
            align_of::<FileHeader>(),
            1,
            "must be align-1 (byte-array fields)"
        );
    }

    #[test]
    fn file_header_offsets_match_spec_1_2() {
        assert_eq!(offset_of!(FileHeader, magic), 0);
        assert_eq!(offset_of!(FileHeader, format_version), 6);
        assert_eq!(offset_of!(FileHeader, dim), 8);
        assert_eq!(offset_of!(FileHeader, slot_count), 12);
        assert_eq!(offset_of!(FileHeader, live_count), 16);
        assert_eq!(offset_of!(FileHeader, free_list_head), 20);
        assert_eq!(offset_of!(FileHeader, var_region_off), 24);
        assert_eq!(offset_of!(FileHeader, var_region_len), 28);
        assert_eq!(offset_of!(FileHeader, pq_codebook_off), 32);
        assert_eq!(offset_of!(FileHeader, committed_count), 36);
        assert_eq!(offset_of!(FileHeader, created_at_epoch), 40);
        assert_eq!(offset_of!(FileHeader, last_compact_at), 48);
        assert_eq!(offset_of!(FileHeader, reserved_1), 56);
    }

    #[test]
    fn slot_header_is_202_bytes_align_1() {
        assert_eq!(size_of::<SlotHeader>(), SLOT_SIZE);
        assert_eq!(size_of::<SlotHeader>(), 202);
        assert_eq!(
            align_of::<SlotHeader>(),
            1,
            "must be align-1 (byte-array fields)"
        );
    }

    #[test]
    fn slot_header_offsets_match_spec_1_3() {
        assert_eq!(offset_of!(SlotHeader, id), 0);
        assert_eq!(offset_of!(SlotHeader, flags), 4);
        assert_eq!(offset_of!(SlotHeader, created_at), 6);
        assert_eq!(offset_of!(SlotHeader, valid_from), 14);
        assert_eq!(offset_of!(SlotHeader, text_ptr), 22);
        assert_eq!(offset_of!(SlotHeader, text_len_lz4), 26);
        assert_eq!(offset_of!(SlotHeader, text_len_raw), 30);
        assert_eq!(offset_of!(SlotHeader, vector_pq), 34);
        assert_eq!(offset_of!(SlotHeader, entity_bitmap), 162);
        assert_eq!(offset_of!(SlotHeader, adjacency), 170);
    }

    #[test]
    fn magic_and_version_are_frozen() {
        assert_eq!(MAGIC, *b"AMR\0\0\0");
        assert_eq!(FORMAT_VERSION, 1); // v1: crash-safety committed_count checkpoint
        assert_eq!(SLOT_REGION_OFFSET, 4096);
        assert_eq!(VECTOR_PQ_LEN, 128);
        assert_eq!(ADJACENCY_LEN, 8);
    }
}
