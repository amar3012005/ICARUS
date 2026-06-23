//! The append-only durable write path (SPEC §6.1) — deliberately a dedicated module so the
//! `writepath_isolation` gate can prove, statically, that the write path never reaches the
//! index-rebuild or codebook-retrain functions (kill-condition #1: HNSW rebuild-on-write).
//! Those functions are named in `loop/gates/writepath_isolation.sh`; this module must never
//! call them. The async HNSW indexer lives in `index.rs`; `insert` (crud.rs) calls
//! `append_memory` here for the durable write, then enqueues an async index add — it never
//! rebuilds inline.

use std::time::{SystemTime, UNIX_EPOCH};

use mseg_format::{Result, SlotHeader, TextRef, SENTINEL_U32};

use crate::segment::{Segment, SlotId};
use crate::types::MemoryInput;

/// Wall-clock nanoseconds, or 0 if the clock is before the epoch.
pub(crate) fn now_nanos() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as i64)
        .unwrap_or(0)
}

impl Segment {
    /// Durably append one memory and return its stable [`SlotId`]. This is the WHOLE write
    /// path: an LZ4 text block (`.txt`), a raw-vector entry (`.vec`), and a slot header
    /// (`.mseg`) — each appended, never moved (SPEC §6.1). It pops the free list when a
    /// tombstoned slot is available, else grows the slot array. It does NOT touch any index.
    pub(crate) fn append_memory(&mut self, mem: &MemoryInput) -> Result<SlotId> {
        // 1. text -> append-only .txt block
        let tref: TextRef = self.append_text_block(mem.text.as_bytes())?;

        // 2. choose a slot: pop the free list, else append a fresh index
        let free_head = self.free_list_head();
        let idx: usize = if free_head != SENTINEL_U32 {
            let reused = free_head as usize;
            // next free = the tombstoned slot's adjacency[0] (SPEC §1.6 chaining)
            let next_free = self.slot(reused)?.adjacency(0);
            self.with_header_mut(|h| h.set_free_list_head(next_free));
            reused
        } else {
            let new_idx = self.slot_count() as usize;
            self.ensure_capacity(new_idx + 1)?;
            self.with_header_mut(|h| h.set_slot_count(new_idx as u32 + 1));
            new_idx
        };

        // 3. build + write the slot header
        let created_at = mem.created_at.unwrap_or_else(now_nanos);
        let mut slot = SlotHeader::empty();
        slot.set_id(idx as u32);
        slot.set_flags(0); // live, PQ not trained (raw vector in .vec)
        slot.set_created_at(created_at);
        slot.set_valid_from(mem.valid_from);
        slot.set_text_ptr(tref.text_ptr);
        slot.set_text_len_lz4(tref.text_len_lz4);
        slot.set_text_len_raw(tref.text_len_raw);
        slot.set_entity_bitmap(mem.entity_bitmap);
        for (i, &adj) in mem.adjacency.iter().enumerate() {
            slot.set_adjacency(i, adj);
        }
        self.write_slot(idx, &slot)?;

        // 4. raw vector -> parallel .vec entry
        self.write_vector(idx, &mem.vector)?;

        // 5. live count++
        self.with_header_mut(|h| h.set_live_count(h.live_count() + 1));
        Ok(idx as SlotId)
    }
}
