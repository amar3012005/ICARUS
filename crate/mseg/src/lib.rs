//! mneme `.mseg` storage engine.
//!
//! Built on the pure-layout `mseg-format` crate. Provides the mmap-backed [`Segment`]
//! (P2-3), CRUD (P2-4), and the multi-tenant `Shard` (P2-5). This is the I/O + lifecycle
//! layer; the byte format itself lives in `mseg-format` and is spec-locked there.

mod append;
mod crud;
mod index;
mod pq;
mod segment;
mod shard;
mod types;

pub use mseg_format::{flags, MsegError, Result};
pub use segment::{Segment, SlotId};
pub use shard::Shard;
pub use types::{Filter, Hit, MemoryInput};
