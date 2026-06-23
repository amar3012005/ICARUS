//! Asynchronous HNSW indexer (SPEC §6.2: recall never blocks on index rebuild).
//!
//! A single background thread owns the add path into the `usearch` index; `insert` enqueues
//! `(slot_id, vector)` and returns immediately (the durable write already happened in
//! `append.rs`). `recall` calls `search` directly on the shared index — usearch supports
//! concurrent search while the background thread adds — so a query never waits for pending
//! adds; it simply sees a slightly stale index (bounded by the async lag), exactly as the
//! invariant allows. This module is the ONLY place index mutation happens; the append path
//! (`append.rs`) has no edge to it.

use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;

use mnsw_index::{Candidate, MnswIndex};

use mseg_format::{MsegError, Result};

/// Messages to the background indexer thread.
enum Msg {
    Add(u32, Vec<f32>),
    /// Barrier: the thread replies once every prior `Add` has been applied (flush/test helper).
    Drain(Sender<()>),
}

/// Owns the HNSW index and the background add thread.
pub(crate) struct AsyncIndexer {
    index: Arc<MnswIndex>,
    tx: Option<Sender<Msg>>,
    handle: Option<JoinHandle<()>>,
}

impl AsyncIndexer {
    /// Create an empty index of dimension `dim` and start the background add thread.
    pub fn new(dim: usize, capacity: usize) -> Result<AsyncIndexer> {
        let index = Arc::new(MnswIndex::new(dim, capacity).map_err(map_err)?);
        let (tx, rx) = mpsc::channel::<Msg>();
        let worker = index.clone();
        let handle = std::thread::Builder::new()
            .name("mneme-hnsw-indexer".into())
            .spawn(move || {
                for msg in rx {
                    match msg {
                        // a failed add is logged-by-ignore: the durable .mseg/.vec already
                        // hold the memory; the index can be rebuilt by compact (never inline).
                        Msg::Add(id, v) => {
                            let _ = worker.add(id, &v);
                        }
                        Msg::Drain(ack) => {
                            let _ = ack.send(());
                        }
                    }
                }
            })?;
        Ok(AsyncIndexer {
            index,
            tx: Some(tx),
            handle: Some(handle),
        })
    }

    /// Enqueue a vector for asynchronous indexing. Non-blocking; never rebuilds.
    pub fn enqueue(&self, slot_id: u32, vector: &[f32]) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(Msg::Add(slot_id, vector.to_vec()));
        }
    }

    /// Bulk-add a batch of `(slot_id, vector)` in parallel (usearch add is thread-safe; the
    /// index capacity is pre-reserved at `new`, so no reserve races). Used by `enable_hnsw`
    /// to seed an existing segment's vectors far faster than one-at-a-time async adds.
    pub fn bulk_add_parallel(&self, batch: &[(u32, Vec<f32>)]) {
        use rayon::prelude::*;
        let idx = &self.index; // &Arc<MnswIndex>; MnswIndex is Sync (usearch concurrent add)
        batch.par_iter().for_each(|(id, v)| {
            let _ = idx.add(*id, v);
        });
    }

    /// Concurrent approximate search over the current index snapshot (never blocks on adds).
    pub fn search(&self, query: &[f32], k: usize) -> Result<Vec<Candidate>> {
        self.index.search(query, k).map_err(map_err)
    }

    /// Number of vectors indexed so far.
    pub fn len(&self) -> usize {
        self.index.len()
    }

    /// Block until every `enqueue` issued before this call has been applied. Test/flush only.
    pub fn drain(&self) {
        if let Some(tx) = &self.tx {
            let (ack_tx, ack_rx) = mpsc::channel();
            if tx.send(Msg::Drain(ack_tx)).is_ok() {
                let _ = ack_rx.recv();
            }
        }
    }
}

impl Drop for AsyncIndexer {
    fn drop(&mut self) {
        // close the channel so the worker's `for msg in rx` loop ends, then join it.
        self.tx.take();
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

fn map_err(e: mnsw_index::MnswError) -> MsegError {
    MsegError::Index(e.to_string())
}
