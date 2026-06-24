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

        // 2. choose a slot: pop the free list, else append a fresh index. We DECIDE the index
        //    here but DO NOT publish it (slot_count / free_list_head) until the slot+vector
        //    bytes are written — see the commit step. Crash-safety: a memory becomes visible
        //    only after its bytes exist, so a torn write before the commit is simply ignored on
        //    reopen (no phantom slot with garbage). For strict per-insert durability call
        //    `flush()`; otherwise the commit ordering still prevents reading uninitialised slots.
        let free_head = self.free_list_head();
        let reuse = free_head != SENTINEL_U32;
        let idx: usize = if reuse {
            free_head as usize
        } else {
            let new_idx = self.slot_count() as usize;
            self.ensure_capacity(new_idx + 1)?;
            new_idx
        };
        // for a reused slot, capture the next free pointer before we overwrite the slot.
        let next_free = if reuse {
            self.slot(idx)?.adjacency(0)
        } else {
            SENTINEL_U32
        };

        // 3. build + write the slot header (bytes hit the file BEFORE the commit).
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

        // 4. raw vector -> parallel .vec entry (also before the commit).
        self.write_vector(idx, &mem.vector)?;

        // 5. COMMIT: publish the slot. The counter / free-list head is the single visibility
        //    point — until now the slot's bytes existed but it was not reachable by recall/get.
        self.with_header_mut(|h| {
            if reuse {
                h.set_free_list_head(next_free); // pop only now that the slot is fully written
            } else {
                h.set_slot_count(idx as u32 + 1); // count it only now
            }
            h.set_live_count(h.live_count() + 1);
        });
        Ok(idx as SlotId)
    }
}
