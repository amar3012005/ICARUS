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
use std::sync::{Arc, RwLock};
use std::thread::JoinHandle;

use mnsw_index::{Candidate, MnswIndex};

use mseg_format::{MsegError, Result};

/// Messages to the background indexer thread.
enum Msg {
    Add(u32, Vec<f32>),
    /// Barrier: the thread replies once every prior `Add` has been applied (flush/test helper).
    Drain(Sender<()>),
}

/// Grow the index capacity to at least `need`, doubling, BEFORE any add can overflow it.
/// usearch `reserve` reallocates the graph and is unsafe concurrent with `search`/`add`, so it
/// runs under the RwLock **write** guard (exclusive) while search/add take the **read** guard.
fn ensure_capacity(index: &RwLock<MnswIndex>, need: usize) {
    let (len_cap_ok, cap) = {
        let g = index.read().expect("index lock");
        (g.len() < g.capacity() && need <= g.capacity(), g.capacity())
    };
    if !len_cap_ok {
        let target = need.max(cap * 2).max(16);
        let g = index.write().expect("index lock");
        let _ = g.reserve(target);
    }
}

/// Owns the HNSW index and the background add thread. The index is behind an `RwLock` purely to
/// serialize the unsafe `reserve` (write) against concurrent `search`/`add` (read).
pub(crate) struct AsyncIndexer {
    index: Arc<RwLock<MnswIndex>>,
    tx: Option<Sender<Msg>>,
    handle: Option<JoinHandle<()>>,
}

impl AsyncIndexer {
    /// Create an empty index of dimension `dim` and start the background add thread.
    pub fn new(dim: usize, capacity: usize) -> Result<AsyncIndexer> {
        let index = Arc::new(RwLock::new(MnswIndex::new(dim, capacity).map_err(map_err)?));
        let (tx, rx) = mpsc::channel::<Msg>();
        let worker = index.clone();
        let handle = std::thread::Builder::new()
            .name("mneme-hnsw-indexer".into())
            .spawn(move || {
                for msg in rx {
                    match msg {
                        Msg::Add(id, v) => {
                            // grow under the write guard FIRST, then add under the read guard
                            // (concurrent with searches) — never reserve while searching.
                            ensure_capacity(&worker, worker.read().expect("lock").len() + 1);
                            let g = worker.read().expect("index lock");
                            let _ = g.add(id, &v);
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

    /// Bulk-add a batch sequentially in the given order — a DETERMINISTIC graph and thus
    /// reproducible recall (no run-to-run variance). Used by `enable_hnsw` so recall quality
    /// is stable. Reserves capacity up front (exclusive), then adds under the read guard. Any
    /// failed add is surfaced (not silently dropped) so a missing vector can't degrade recall.
    pub fn bulk_add_sequential(&self, batch: &[(u32, Vec<f32>)]) -> Result<()> {
        let target = self.len() + batch.len();
        ensure_capacity(&self.index, target);
        let g = self.index.read().expect("index lock");
        for (id, v) in batch {
            g.add(*id, v).map_err(map_err)?;
        }
        Ok(())
    }

    /// Concurrent approximate search over the current index snapshot (never blocks on adds).
    pub fn search(&self, query: &[f32], k: usize) -> Result<Vec<Candidate>> {
        self.index
            .read()
            .expect("index lock")
            .search(query, k)
            .map_err(map_err)
    }

    /// Number of vectors indexed so far.
    pub fn len(&self) -> usize {
        self.index.read().expect("index lock").len()
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
