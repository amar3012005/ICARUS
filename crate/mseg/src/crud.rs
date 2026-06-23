//! CRUD over a [`Segment`] (SPEC §5.3–§5.4, P2 scope).
//!
//! Write path is append-only (SPEC §6.1): `insert` appends a text block, a `.vec` entry, and
//! a slot — never moves an existing one. `delete` tombstones + pushes onto the free list
//! (SPEC §6.4: text/vector bytes are NOT reclaimed until `compact`). `recall` is an exact
//! brute-force f32 cosine scan over live slots (HNSW arrives in P3); it skips tombstones and
//! applies the entity-bitmap + bi-temporal `Filter` (SPEC §5.4 steps 1–4; `hops` is P5).

use std::time::{SystemTime, UNIX_EPOCH};

use mseg_format::{flags, MsegError, Result, SlotHeader, TextRef, SENTINEL_U32};

use crate::segment::{Segment, SlotId};
use crate::types::{Filter, Hit, MemoryInput};

fn now_nanos() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as i64)
        .unwrap_or(0)
}

impl Segment {
    /// Insert a memory, returning its stable [`SlotId`]. Append-only (SPEC §5.3, §6.1).
    pub fn insert(&mut self, mem: MemoryInput) -> Result<SlotId> {
        if mem.vector.len() != self.dim() {
            return Err(MsegError::DimMismatch {
                segment: self.dim(),
                got: mem.vector.len(),
            });
        }

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

    /// Fetch a memory by id. `Err(TombstonedSlot)` if deleted, `Err(NoSuchSlot)` if never used.
    pub fn get(&mut self, id: SlotId) -> Result<Hit> {
        let idx = id as usize;
        if idx >= self.slot_count() as usize {
            return Err(MsegError::NoSuchSlot(id));
        }
        let slot = self.slot(idx)?;
        if slot.is_tombstoned() {
            return Err(MsegError::TombstonedSlot(id));
        }
        self.hydrate(idx, &slot, f32::NAN)
    }

    /// Tombstone a memory and push its slot onto the free list (SPEC §6.4). Idempotent: a
    /// second delete of the same id is a no-op (already tombstoned).
    pub fn delete(&mut self, id: SlotId) -> Result<()> {
        let idx = id as usize;
        if idx >= self.slot_count() as usize {
            return Err(MsegError::NoSuchSlot(id));
        }
        let mut slot = self.slot(idx)?;
        if slot.is_tombstoned() {
            return Ok(());
        }
        // chain this slot into the free list via adjacency[0] (SPEC §1.6)
        let old_head = self.free_list_head();
        slot.set_flag(flags::TOMBSTONE);
        slot.set_adjacency(0, old_head);
        self.write_slot(idx, &slot)?;
        self.with_header_mut(|h| {
            h.set_free_list_head(idx as u32);
            h.set_live_count(h.live_count().saturating_sub(1));
        });
        Ok(())
    }

    /// Exact brute-force cosine recall over live slots (SPEC §5.4, P2: no HNSW, `hops` ignored).
    pub fn recall(&mut self, query: &[f32], filter: &Filter, top_k: usize) -> Result<Vec<Hit>> {
        if query.len() != self.dim() {
            return Err(MsegError::DimMismatch {
                segment: self.dim(),
                got: query.len(),
            });
        }
        if top_k == 0 {
            return Ok(Vec::new());
        }
        let q_norm = l2_norm(query);
        let n = self.slot_count() as usize;

        // collect (score, idx) for surviving slots, then take top_k
        let mut scored: Vec<(f32, usize)> = Vec::new();
        for idx in 0..n {
            let slot = self.slot(idx)?;
            if slot.is_tombstoned() {
                continue;
            }
            if !filter.matches(slot.entity_bitmap(), slot.created_at(), slot.valid_from()) {
                continue;
            }
            let v = self.read_vector(idx)?;
            let score = cosine(query, q_norm, &v);
            scored.push((score, idx));
        }
        scored.sort_unstable_by(|a, b| {
            b.0.partial_cmp(&a.0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.1.cmp(&b.1))
        });
        scored.truncate(top_k);

        let mut hits = Vec::with_capacity(scored.len());
        for (score, idx) in scored {
            let slot = self.slot(idx)?;
            hits.push(self.hydrate(idx, &slot, score)?);
        }
        Ok(hits)
    }

    /// Build a [`Hit`] from a slot, decompressing its text.
    fn hydrate(&mut self, _idx: usize, slot: &SlotHeader, score: f32) -> Result<Hit> {
        let tref = TextRef {
            text_ptr: slot.text_ptr(),
            text_len_lz4: slot.text_len_lz4(),
            text_len_raw: slot.text_len_raw(),
        };
        let text_bytes = self.read_text_block(tref)?;
        let text = String::from_utf8(text_bytes)
            .map_err(|e| MsegError::Corrupt(format!("slot text not utf8: {e}")))?;
        let mut adjacency = [SENTINEL_U32; mseg_format::ADJACENCY_LEN];
        for (i, a) in adjacency.iter_mut().enumerate() {
            *a = slot.adjacency(i);
        }
        Ok(Hit {
            slot_id: slot.id(),
            score,
            text,
            entity_bitmap: slot.entity_bitmap(),
            created_at: slot.created_at(),
            valid_from: slot.valid_from(),
            adjacency,
        })
    }
}

#[inline]
fn l2_norm(v: &[f32]) -> f32 {
    v.iter().map(|x| x * x).sum::<f32>().sqrt()
}

/// Cosine similarity using a precomputed query norm. Returns 0 for a zero vector.
#[inline]
fn cosine(q: &[f32], q_norm: f32, v: &[f32]) -> f32 {
    let dot: f32 = q.iter().zip(v).map(|(a, b)| a * b).sum();
    let vn = l2_norm(v);
    if q_norm == 0.0 || vn == 0.0 {
        0.0
    } else {
        dot / (q_norm * vn)
    }
}
