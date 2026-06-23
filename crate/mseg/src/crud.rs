//! CRUD over a [`Segment`] (SPEC §5.3–§5.4, P2 scope).
//!
//! Write path is append-only (SPEC §6.1): `insert` appends a text block, a `.vec` entry, and
//! a slot — never moves an existing one. `delete` tombstones + pushes onto the free list
//! (SPEC §6.4: text/vector bytes are NOT reclaimed until `compact`). `recall` is an exact
//! brute-force f32 cosine scan over live slots (HNSW arrives in P3); it skips tombstones and
//! applies the entity-bitmap + bi-temporal `Filter` (SPEC §5.4 steps 1–4; `hops` is P5).

use mseg_format::{flags, MsegError, Result, SlotHeader, TextRef, SENTINEL_U32};

use crate::segment::{Segment, SlotId};
use crate::types::{Filter, Hit, MemoryInput};

impl Segment {
    /// Insert a memory, returning its stable [`SlotId`]. The durable write is the append-only
    /// path in `append.rs`; if an HNSW overlay is enabled, the new vector is enqueued for
    /// asynchronous indexing here — never rebuilt inline (SPEC §5.3, §6.1, §6.2).
    pub fn insert(&mut self, mem: MemoryInput) -> Result<SlotId> {
        if mem.vector.len() != self.dim() {
            return Err(MsegError::DimMismatch {
                segment: self.dim(),
                got: mem.vector.len(),
            });
        }
        let id = self.append_memory(&mem)?;
        // async index add (no-op if HNSW not enabled); never blocks, never rebuilds.
        self.enqueue_index_add(id, &mem.vector);
        Ok(id)
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

    /// Recall the top-`k` memories for `query` under `filter` (SPEC §5.4). Uses the HNSW
    /// overlay when enabled (sublinear, recall never blocks on pending async adds — SPEC §6.2),
    /// otherwise an exact brute-force scan. `hops` is deferred to P5.
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
        if self.hnsw_enabled() {
            self.recall_hnsw(query, filter, top_k)
        } else {
            self.recall_brute(query, filter, top_k)
        }
    }

    /// HNSW-backed recall: take an over-fetch of candidates from usearch, post-filter
    /// tombstones + the `Filter`, then exact-rerank by f32 cosine over the surviving
    /// candidates' raw vectors (SPEC §5.4 steps 2–4; ADC arrives with PQ in P4).
    fn recall_hnsw(&mut self, query: &[f32], filter: &Filter, top_k: usize) -> Result<Vec<Hit>> {
        // Over-fetch candidates so post-filtering still returns top_k. A selective entity /
        // temporal filter needs a wider net, so widen ef when any filter condition is set
        // (post-filter is SPEC-§5.4-allowed; widening keeps recall high without a usearch
        // predicate callback). Capped at the live slot count.
        let base = (top_k * 4).max(64);
        let widened = if filter.is_active() { base * 8 } else { base };
        let ef = widened.min(self.slot_count() as usize).max(top_k);
        let candidates = self.hnsw_search(query, ef).expect("hnsw enabled")?; // Option is Some because hnsw_enabled() was checked
        let q_norm = l2_norm(query);
        let n = self.slot_count() as usize;

        let mut scored: Vec<(f32, usize)> = Vec::with_capacity(candidates.len());
        let mut seen = std::collections::HashSet::new();
        for c in candidates {
            let idx = c.slot_id as usize;
            if idx >= n || !seen.insert(idx) {
                continue; // stale/duplicate label guard
            }
            let slot = self.slot(idx)?;
            if slot.is_tombstoned() {
                continue;
            }
            if !filter.matches(slot.entity_bitmap(), slot.created_at(), slot.valid_from()) {
                continue;
            }
            let v = self.read_vector(idx)?;
            scored.push((cosine(query, q_norm, &v), idx));
        }
        sort_take(&mut scored, top_k);
        self.hydrate_all(scored)
    }

    /// Exact brute-force cosine recall over every live slot — the correctness oracle and the
    /// fallback when no HNSW overlay is enabled.
    pub fn recall_brute(
        &mut self,
        query: &[f32],
        filter: &Filter,
        top_k: usize,
    ) -> Result<Vec<Hit>> {
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
            scored.push((cosine(query, q_norm, &v), idx));
        }
        sort_take(&mut scored, top_k);
        self.hydrate_all(scored)
    }

    /// Recall with `hops` levels of graph expansion (SPEC §5.4 step 5). Seeds from the normal
    /// recall, then BFS over each slot's `adjacency[8]` up to `hops` levels — all from the same
    /// mmap (a neighbour read is one slot read). Tombstoned / filtered-out neighbours are
    /// skipped. The base + expanded set is re-ranked by cosine and the top `top_k` returned.
    /// `hops == 0` is identical to `recall`.
    pub fn recall_with_hops(
        &mut self,
        query: &[f32],
        filter: &Filter,
        top_k: usize,
        hops: u8,
    ) -> Result<Vec<Hit>> {
        if hops == 0 {
            return self.recall(query, filter, top_k);
        }
        if query.len() != self.dim() {
            return Err(MsegError::DimMismatch {
                segment: self.dim(),
                got: query.len(),
            });
        }
        // seed with a wider base so the graph has good entry points.
        let base = self.recall(query, filter, top_k.max(top_k * 2))?;
        let n = self.slot_count() as usize;
        let mut seen: std::collections::HashSet<usize> = std::collections::HashSet::new();
        let mut frontier: Vec<usize> = Vec::new();
        for h in &base {
            let idx = h.slot_id as usize;
            if seen.insert(idx) {
                frontier.push(idx);
            }
        }
        // BFS expansion over adjacency.
        for _ in 0..hops {
            let mut next = Vec::new();
            for &idx in &frontier {
                let slot = self.slot(idx)?;
                for a in 0..mseg_format::ADJACENCY_LEN {
                    let nb = slot.adjacency(a) as usize;
                    if nb == SENTINEL_U32 as usize || nb >= n || !seen.insert(nb) {
                        continue;
                    }
                    next.push(nb);
                }
            }
            frontier = next;
            if frontier.is_empty() {
                break;
            }
        }
        // re-rank the whole reachable set by cosine, applying the filter + tombstone skip.
        let q_norm = l2_norm(query);
        let mut scored: Vec<(f32, usize)> = Vec::with_capacity(seen.len());
        for &idx in &seen {
            let slot = self.slot(idx)?;
            if slot.is_tombstoned() {
                continue;
            }
            if !filter.matches(slot.entity_bitmap(), slot.created_at(), slot.valid_from()) {
                continue;
            }
            let v = self.read_vector(idx)?;
            scored.push((cosine(query, q_norm, &v), idx));
        }
        sort_take(&mut scored, top_k);
        self.hydrate_all(scored)
    }

    /// Hydrate a ranked `(score, idx)` list into `Hit`s.
    fn hydrate_all(&mut self, scored: Vec<(f32, usize)>) -> Result<Vec<Hit>> {
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

/// Sort `(score, idx)` descending by score (tie-break ascending idx for determinism) and
/// keep the top `k`.
fn sort_take(scored: &mut Vec<(f32, usize)>, k: usize) {
    scored.sort_unstable_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.1.cmp(&b.1))
    });
    scored.truncate(k);
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
