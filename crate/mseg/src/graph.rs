//! Memory-engine layer: typed-edge graph (unbounded via the `.edg` overflow region) + bi-temporal
//! "as of date X" version queries — all served from the single mmap'd shard (no join, no second
//! store). This is the capability that separates a memory *engine* from a vector *store*:
//! relationships and version history live in the byte layout next to the embedding.
//!
//! Up to `EDGE_SLOTS` typed edges live inline in the slot. On the (EDGE_SLOTS+1)-th edge the slot
//! spills ALL its edges to the append-only `.edg` file and stores a `{ptr,count}` descriptor in
//! edge[0] (flag `EDGE_OVERFLOW`) — so a memory can have arbitrarily many typed relationships.

use std::collections::{HashSet, VecDeque};

use mseg_format::{
    flags, Result, EDGE_NONE, EDGE_SLOTS, EDGE_UPDATES, EDGE_WIRE_BYTES, SENTINEL_U32,
};

use crate::{MemoryInput, Segment, SlotId};

fn edges_to_bytes(edges: &[(u32, u8, u8)]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(edges.len() * EDGE_WIRE_BYTES);
    for &(t, ty, w) in edges {
        buf.extend_from_slice(&t.to_le_bytes());
        buf.push(ty);
        buf.push(w);
        buf.extend_from_slice(&[0u8, 0u8]); // pad to 8
    }
    buf
}

impl Segment {
    /// Read `slot_id`'s typed edges as `(target, type, weight)` — inline or `.edg`-backed.
    pub fn slot_edges(&self, slot_id: u32) -> Result<Vec<(u32, u8, u8)>> {
        let s = self.slot(slot_id as usize)?;
        if s.has_flag(flags::EDGE_OVERFLOW) {
            let (ptr, count) = s.edge_overflow();
            let bytes = self.read_edge_bytes(ptr, count as usize * EDGE_WIRE_BYTES)?;
            let mut out = Vec::with_capacity(count as usize);
            for c in bytes.chunks_exact(EDGE_WIRE_BYTES) {
                let target = u32::from_le_bytes([c[0], c[1], c[2], c[3]]);
                out.push((target, c[4], c[5]));
            }
            Ok(out)
        } else {
            let mut out = Vec::new();
            for i in 0..EDGE_SLOTS {
                let (t, ty, w) = s.edge(i);
                if t != SENTINEL_U32 && ty != EDGE_NONE {
                    out.push((t, ty, w));
                }
            }
            Ok(out)
        }
    }

    /// Add one typed edge to `slot_id` — UNBOUNDED. Fills the inline slots first, then spills the
    /// whole edge set to the append-only `.edg` region (old block orphaned, reclaimed at compact).
    pub fn add_edge(&mut self, slot_id: u32, target: u32, edge_type: u8, weight: u8) -> Result<()> {
        let s = self.slot(slot_id as usize)?;
        if s.has_flag(flags::EDGE_OVERFLOW) {
            let mut edges = self.slot_edges(slot_id)?;
            edges.push((target, edge_type, weight));
            let ptr = self.append_edge_bytes(&edges_to_bytes(&edges))?;
            let mut s = self.slot(slot_id as usize)?;
            s.set_edge_overflow(ptr, edges.len() as u32);
            return self.write_slot(slot_id as usize, &s);
        }
        // count inline edges
        let mut inline = Vec::new();
        for i in 0..EDGE_SLOTS {
            let (t, ty, w) = s.edge(i);
            if t != SENTINEL_U32 && ty != EDGE_NONE {
                inline.push((t, ty, w));
            }
        }
        if inline.len() < EDGE_SLOTS {
            let mut s = self.slot(slot_id as usize)?;
            s.set_edge(inline.len(), target, edge_type, weight);
            self.write_slot(slot_id as usize, &s)
        } else {
            // spill: write all (inline + new) to .edg, store descriptor, set the flag.
            inline.push((target, edge_type, weight));
            let ptr = self.append_edge_bytes(&edges_to_bytes(&inline))?;
            let mut s = self.slot(slot_id as usize)?;
            for i in 0..EDGE_SLOTS {
                s.set_edge(i, SENTINEL_U32, EDGE_NONE, 0);
            }
            s.set_edge_overflow(ptr, inline.len() as u32);
            s.set_flag(flags::EDGE_OVERFLOW);
            self.write_slot(slot_id as usize, &s)
        }
    }

    /// Update memory `old_slot` with a new version (write-path bi-temporal versioning). Inserts
    /// `new`, links `new --Updates--> old`, and marks `old` SUPERSEDED — so vector recall returns
    /// only the latest version while `as_of(new, t)` can still reach every past version. The
    /// version chain builds itself; no manual edges. Returns the new slot id.
    pub fn update(&mut self, old_slot: u32, new: MemoryInput) -> Result<SlotId> {
        let new_slot = self.insert(new)?;
        self.add_edge(new_slot, old_slot, EDGE_UPDATES, 0)?;
        let mut s = self.slot(old_slot as usize)?;
        s.set_flag(flags::SUPERSEDED);
        self.write_slot(old_slot as usize, &s)?;
        Ok(new_slot)
    }

    /// Write typed edge slot `i` (0..EDGE_SLOTS) directly inline. Low-level; prefer `add_edge`
    /// for the unbounded path.
    pub fn set_edge(
        &mut self,
        slot_id: u32,
        i: usize,
        target: u32,
        edge_type: u8,
        weight: u8,
    ) -> Result<()> {
        let mut s = self.slot(slot_id as usize)?;
        s.set_edge(i, target, edge_type, weight);
        self.write_slot(slot_id as usize, &s)
    }

    /// Typed graph traversal: from `seeds`, follow ONLY edges of `edge_type`, up to `max_hops`
    /// levels. Returns reachable LIVE slot ids (excluding seeds) in BFS order. One shard, no join.
    pub fn traverse_typed(&self, seeds: &[u32], edge_type: u8, max_hops: u8) -> Result<Vec<u32>> {
        let mut seen: HashSet<u32> = seeds.iter().copied().collect();
        let mut q: VecDeque<(u32, u8)> = seeds.iter().map(|&s| (s, 0)).collect();
        let mut out = Vec::new();
        while let Some((node, depth)) = q.pop_front() {
            if depth >= max_hops {
                continue;
            }
            let edges = match self.slot_edges(node) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for (t, ty, _w) in edges {
                if ty != edge_type {
                    continue;
                }
                if seen.insert(t) {
                    if let Ok(ts) = self.slot(t as usize) {
                        if !ts.is_tombstoned() {
                            out.push(t);
                            q.push_back((t, depth + 1));
                        }
                    }
                }
            }
        }
        Ok(out)
    }

    /// Bi-temporal point-in-time. Given the head (newest) of a version chain linked by
    /// `EDGE_UPDATES` (v_new --Updates--> v_old), return the slot CURRENT as of transaction time
    /// `txn_time` — the newest version whose `created_at <= txn_time`. `None` if not yet known.
    pub fn as_of(&self, head_slot: u32, txn_time: i64) -> Result<Option<u32>> {
        let mut cur = head_slot;
        let mut guard = 0usize;
        loop {
            let s = self.slot(cur as usize)?;
            if s.created_at() <= txn_time {
                return Ok(Some(cur));
            }
            let prev = self
                .slot_edges(cur)?
                .into_iter()
                .find(|&(_, ty, _)| ty == EDGE_UPDATES)
                .map(|(t, _, _)| t);
            match prev {
                Some(p) => cur = p,
                None => return Ok(None),
            }
            guard += 1;
            if guard > 10_000 {
                return Ok(None);
            }
        }
    }
}
