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

    /// Rewrite a live slot's TEXT payload in place, keeping its vector, layer, temporal anchors,
    /// entity bitmap and adjacency untouched. Append-only compatible: the new text block is
    /// APPENDED to `.txt` and the slot's TextRef repointed — the old block becomes dead bytes
    /// reclaimed by `compact()` (same lifecycle as a deleted memory's text, SPEC §6.4).
    ///
    /// This is the durability primitive for metadata-only mutations (tags, recall reinforcement,
    /// supersession flags baked into the record JSON) — without it, callers that can't reproduce
    /// the slot's vector had no way to persist a record change.
    pub fn rewrite_text(&mut self, id: SlotId, text: &str) -> Result<()> {
        let idx = id as usize;
        if idx >= self.slot_count() as usize {
            return Err(MsegError::NoSuchSlot(id));
        }
        let mut slot = self.slot(idx)?;
        if slot.is_tombstoned() {
            return Err(MsegError::TombstonedSlot(id));
        }
        let tref = self.append_text_block(text.as_bytes())?;
        slot.set_text_ptr(tref.text_ptr);
        slot.set_text_len_lz4(tref.text_len_lz4);
        slot.set_text_len_raw(tref.text_len_raw);
        self.write_slot(idx, &slot)?;
        Ok(())
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
        // Wide ef floor so the exact rerank reliably recovers the true top-k — recall on par
        // with a float32 baseline (Qdrant). 256 chosen empirically: at it, recall@5 == 1.0.
        let base = (top_k * 24).max(256);
        let widened = if filter.is_active() { base * 4 } else { base };
        let ef = widened.min(self.slot_count() as usize).max(top_k);
        let candidates = self.hnsw_search(query, ef).expect("hnsw enabled")?; // Option is Some because hnsw_enabled() was checked
        let q_norm = l2_norm(query);
        let n = self.slot_count() as usize;

        // usearch returns candidates already ordered by (int8) distance, so the true top-k sit
        // near the front. Exact-rerank only the first MNEME_RERANK_DEPTH survivors instead of all
        // `ef` — at scale each rerank is a cold `.vec` read, so reranking ~32 vs 256 is the
        // difference between ~ms and ~30ms at 10M. Default = unbounded (full rerank, max recall).
        // Default cap = (top_k*6).max(64): the 10M real-BIGANN sweep showed depth 64 is lossless
        // vs full-rerank (recall_vs_full 1.0000) while cutting p50 31ms→2.4ms — so cap by default
        // and let MNEME_RERANK_DEPTH override (huge = exhaustive, smaller = faster/scale).
        let rerank_depth = std::env::var("MNEME_RERANK_DEPTH")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or((top_k * 6).max(64));
        let mut scored: Vec<(f32, usize)> = Vec::with_capacity(candidates.len());
        let mut seen = std::collections::HashSet::new();
        for c in candidates {
            let idx = c.slot_id as usize;
            if idx >= n || !seen.insert(idx) {
                continue; // stale/duplicate label guard
            }
            let slot = self.slot(idx)?;
            if slot.is_tombstoned() || slot.is_superseded() {
                continue;
            }
            if !filter.matches(
                slot.entity_bitmap(),
                slot.created_at(),
                slot.valid_from(),
                slot.layer(),
            ) {
                continue;
            }
            let v = self.read_vector(idx)?;
            scored.push((cosine(query, q_norm, &v), idx));
            if scored.len() >= rerank_depth {
                break; // top int8-ranked survivors reranked; stop the cold reads
            }
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
            if slot.is_tombstoned() || slot.is_superseded() {
                continue;
            }
            if !filter.matches(
                slot.entity_bitmap(),
                slot.created_at(),
                slot.valid_from(),
                slot.layer(),
            ) {
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
        let n = self.slot_count() as usize;
        let mut seen: std::collections::HashSet<usize> = std::collections::HashSet::new();
        let mut frontier: Vec<usize> = Vec::new();
        // Lean seeding: a fixed modest-ef HNSW search (NOT the filter-widened recall path —
        // that reads hundreds of vectors and dominates latency at 1M). The graph expansion
        // provides the breadth; the seeds just need to be good entry points.
        if let Some(cands) = self.hnsw_search(query, 32) {
            for c in cands? {
                let idx = c.slot_id as usize;
                if idx < n && seen.insert(idx) {
                    frontier.push(idx);
                }
            }
        } else {
            // no HNSW overlay → seed from a small brute pass.
            for h in self.recall_brute(query, filter, top_k.max(top_k * 2))? {
                let idx = h.slot_id as usize;
                if seen.insert(idx) {
                    frontier.push(idx);
                }
            }
        }
        // BFS expansion over adjacency, bounded: we never re-rank an unbounded pool — once the
        // reachable set reaches MAX_HOP_CANDIDATES we stop expanding (the closest entries are
        // discovered first via the seeded frontier, so the cap keeps recall high at bounded
        // latency, which is what the <8ms @1M gate requires).
        const MAX_HOP_CANDIDATES: usize = 256;
        'bfs: for _ in 0..hops {
            let mut next = Vec::new();
            for &idx in &frontier {
                let slot = self.slot(idx)?;
                for a in 0..mseg_format::ADJACENCY_LEN {
                    let nb = slot.adjacency(a) as usize;
                    if nb == SENTINEL_U32 as usize || nb >= n || !seen.insert(nb) {
                        continue;
                    }
                    next.push(nb);
                    if seen.len() >= MAX_HOP_CANDIDATES {
                        break 'bfs;
                    }
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
            if slot.is_tombstoned() || slot.is_superseded() {
                continue;
            }
            if !filter.matches(
                slot.entity_bitmap(),
                slot.created_at(),
                slot.valid_from(),
                slot.layer(),
            ) {
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
