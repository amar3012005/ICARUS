//! mneme `.mseg` on-disk format — the frozen SPEC v0 byte layout.
//!
//! This crate owns ONLY the format: the 64-byte file header, the 202-byte slot header,
//! the flag bits, and (P2-2) the LZ4 variable text region. It is pure data layout with no
//! I/O policy — the segment manager (P2-3) and CRUD (P2-4) build on top. Keeping the format
//! isolated lets the spec-lock test guard the frozen byte offsets in one place.

mod error;
mod header;
mod varregion;

pub use error::{MsegError, Result};
pub use header::{
    flags, FileHeader, SlotHeader, ADJACENCY_LEN, EDGE_CONTRADICTS, EDGE_DERIVES, EDGE_EXTENDS,
    EDGE_MENTIONS, EDGE_NONE, EDGE_PARTOF, EDGE_SLOTS, EDGE_UPDATES, EDGE_WIRE_BYTES,
    FILE_HEADER_SIZE, FORMAT_VERSION, LAYER_COGNITIVE, LAYER_EVIDENCE, LAYER_MEMORY, MAGIC,
    MAX_TEXT_BYTES, SENTINEL_U32, SLOT_REGION_OFFSET, SLOT_SIZE, VECTOR_PQ_LEN,
};
pub use varregion::{append_text, read_text, TextRef};
