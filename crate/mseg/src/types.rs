//! Query-API value types (SPEC §5.1). Kept separate from the engine so the public surface
//! is easy to read and stays aligned with the frozen API.

use crate::segment::SlotId;
use mseg_format::ADJACENCY_LEN;

/// Input to `insert` (SPEC §5.1). `created_at = None` means "use wall-clock at insert".
#[derive(Debug, Clone)]
pub struct MemoryInput {
    pub text: String,
    pub vector: Vec<f32>,
    pub entity_bitmap: u64,
    pub adjacency: [SlotId; ADJACENCY_LEN],
    pub valid_from: i64,
    pub created_at: Option<i64>,
    /// Which HIVEMIND layer this memory belongs to: 0=memory (default), 1=evidence, 2=cognitive.
    pub layer: u8,
}

impl MemoryInput {
    /// Minimal constructor: text + vector, no entities/graph/temporal metadata.
    pub fn new(text: impl Into<String>, vector: Vec<f32>) -> Self {
        MemoryInput {
            text: text.into(),
            vector,
            entity_bitmap: 0,
            adjacency: [mseg_format::SENTINEL_U32; ADJACENCY_LEN],
            valid_from: 0,
            created_at: None,
            layer: mseg_format::LAYER_MEMORY,
        }
    }
}

/// One recall result (SPEC §5.1).
#[derive(Debug, Clone)]
pub struct Hit {
    pub slot_id: SlotId,
    /// Cosine similarity in `[-1, 1]` (higher = more similar).
    pub score: f32,
    pub text: String,
    pub entity_bitmap: u64,
    pub created_at: i64,
    pub valid_from: i64,
    pub adjacency: [SlotId; ADJACENCY_LEN],
}

/// Recall filter (SPEC §5.1). All present conditions are ANDed.
#[derive(Debug, Clone, Default)]
pub struct Filter {
    /// If `Some(m)`, a slot passes iff `(slot.entity_bitmap & m) != 0`.
    pub entity_mask: Option<u64>,
    /// Inclusive `[lo, hi]` nanosecond range on `created_at`.
    pub created_at_range: Option<(i64, i64)>,
    /// Inclusive `[lo, hi]` nanosecond range on `valid_from`.
    pub valid_from_range: Option<(i64, i64)>,
    /// If `Some(l)`, only slots whose layer == `l` pass (0=memory, 1=evidence, 2=cognitive).
    /// Recall sets `memory`; provenance sets `evidence`; synthesis sets `cognitive` — like Qdrant's
    /// `layer` payload filter, so one `.amr` shard serves all three usages, separated.
    pub layer: Option<u8>,
}

impl Filter {
    /// True if any filter condition is set (used to widen HNSW over-fetch).
    pub fn is_active(&self) -> bool {
        self.entity_mask.is_some()
            || self.created_at_range.is_some()
            || self.valid_from_range.is_some()
            || self.layer.is_some()
    }

    /// True if `(entity_bitmap, created_at, valid_from, layer)` passes every present condition.
    pub fn matches(&self, entity_bitmap: u64, created_at: i64, valid_from: i64, layer: u8) -> bool {
        if let Some(l) = self.layer {
            if layer != l {
                return false;
            }
        }
        if let Some(m) = self.entity_mask {
            if entity_bitmap & m == 0 {
                return false;
            }
        }
        if let Some((lo, hi)) = self.created_at_range {
            if created_at < lo || created_at > hi {
                return false;
            }
        }
        if let Some((lo, hi)) = self.valid_from_range {
            if valid_from < lo || valid_from > hi {
                return false;
            }
        }
        true
    }
}
