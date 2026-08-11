//! Asynchronous HNSW indexer (SPEC §6.2: recall never blocks on index rebuild).
//!
//! A single background thread owns the add path into the `usearch` index; `insert` enqueues
//! `(slot_id, vector)` and returns immediately (the durable write already happened in
//! `append.rs`). `recall` calls `search` directly on the shared index — usearch supports
//! concurrent search while the background thread adds — so a query never waits for pending
//! adds; it simply sees a slightly stale index (bounded by the async lag), exactly as the
//! invariant allows. This module is the ONLY place index mutation happens; the append path
//! (`append.rs`) has no edge to it.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender, SyncSender, TrySendError};
use std::sync::{Arc, RwLock};
use std::thread::JoinHandle;

use mnsw_index::{Candidate, MnswIndex};

use mseg_format::{MsegError, Result};

/// Bounded async-index queue. Past this many pending adds, `enqueue` indexes inline (synchronously)
/// instead of growing memory unboundedly — backpressure that never drops a vector.
const QUEUE_CAP: usize = 65_536;

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
    tx: Option<SyncSender<Msg>>,
    queued: Arc<AtomicU64>, // enqueued-but-not-yet-applied = index lag (0 once caught up)
    failures: Arc<AtomicU64>, // adds that errored; should always be 0, >0 = degraded recall
    handle: Option<JoinHandle<()>>,
}

/// Apply one add: grow under the write guard, then add under the read guard (concurrent with
/// searches). A failed add is COUNTED, never silently lost.
fn apply_add(index: &Arc<RwLock<MnswIndex>>, failures: &AtomicU64, id: u32, v: &[f32]) {
    let need = index.read().expect("index lock").len() + 1;
    ensure_capacity(index, need);
    let g = index.read().expect("index lock");
    if g.add(id, v).is_err() {
        failures.fetch_add(1, Ordering::Relaxed);
    }
}

impl AsyncIndexer {
    /// Create an empty index of dimension `dim` and start the background add thread.
    pub fn new(dim: usize, capacity: usize) -> Result<AsyncIndexer> {
        Self::from_index(MnswIndex::new(dim, capacity).map_err(map_err)?)
    }

    /// Load a persisted index from a `.mnsw` file (skips the expensive rebuild) and start the
    /// background add thread so incremental inserts continue to apply.
    pub fn load(path: &std::path::Path, dim: usize) -> Result<AsyncIndexer> {
        Self::from_index(MnswIndex::load(path, dim).map_err(map_err)?)
    }

    /// Persist the current index to a `.mnsw` file (drains pending async adds first so the saved
    /// graph is complete).
    pub fn save(&self, path: &std::path::Path) -> Result<()> {
        self.drain();
        self.index
            .read()
            .expect("index lock")
            .save(path)
            .map_err(map_err)
    }

    /// Wrap an existing `MnswIndex` (fresh or loaded) and start its background add thread.
    fn from_index(index: MnswIndex) -> Result<AsyncIndexer> {
        let index = Arc::new(RwLock::new(index));
        let (tx, rx) = mpsc::sync_channel::<Msg>(QUEUE_CAP); // bounded → backpressure, no RAM blowup
        let queued = Arc::new(AtomicU64::new(0));
        let failures = Arc::new(AtomicU64::new(0));
        let worker = index.clone();
        let w_queued = queued.clone();
        let w_failures = failures.clone();
        let handle = std::thread::Builder::new()
            .name("mneme-hnsw-indexer".into())
            .spawn(move || {
                for msg in rx {
                    match msg {
                        Msg::Add(id, v) => {
                            apply_add(&worker, &w_failures, id, &v);
                            w_queued.fetch_sub(1, Ordering::Relaxed);
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
            queued,
            failures,
            handle: Some(handle),
        })
    }

    /// Enqueue a vector for asynchronous indexing. Non-blocking under normal load; if the queue is
    /// saturated (or the worker died), indexes INLINE so a vector is NEVER dropped — backpressure,
    /// not data loss.
    pub fn enqueue(&self, slot_id: u32, vector: &[f32]) {
        if let Some(tx) = &self.tx {
            self.queued.fetch_add(1, Ordering::Relaxed);
            match tx.try_send(Msg::Add(slot_id, vector.to_vec())) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                    self.queued.fetch_sub(1, Ordering::Relaxed);
                    apply_add(&self.index, &self.failures, slot_id, vector);
                }
            }
        }
    }

    /// Pending adds not yet applied to the graph (index lag). 0 = fully caught up.
    pub fn index_lag(&self) -> u64 {
        self.queued.load(Ordering::Relaxed)
    }

    /// Count of adds that errored — should always be 0; >0 means recall may be missing vectors.
    pub fn add_failures(&self) -> u64 {
        self.failures.load(Ordering::Relaxed)
    }

    /// Bulk-add a batch into the graph. Reserves capacity up front (exclusive), then adds under
    /// the read guard (usearch's `add` is thread-safe for concurrent callers).
    ///
    /// `MNEME_BUILD_PARALLEL=1` adds concurrently via rayon instead of one-at-a-time: measured
    /// on a real 10k×1024 bge-m3 corpus, ~23.9s → ~3.8s (6.1×) with recall@10 unchanged (0.999 at
    /// ef=16, identical to sequential — verified via `examples/ef_sweep.rs`). BUT this is NOT the
    /// default and must NOT become the default without per-scale verification: at 100k the same
    /// flag measured recall10_p50_ms 3.91ms → 5.24ms (+34% WORSE query latency, via
    /// `bin/bench_1m.rs`), and at 1M, 1.95ms → 3.85ms (~2×). Concurrent insertion order changes
    /// the HNSW graph's shape in a way that degrades search-time navigability at scale, even
    /// though recall@10 (checked only at 10k) looked identical — build speed and query latency
    /// trade off here, and there is no known-safe default threshold between 10k (fine) and 100k
    /// (already regressed): guessing one would repeat exactly the mistake that shipped the
    /// regression in the first place. Default = sequential/deterministic, unconditionally safe
    /// at every scale measured. Opt into `MNEME_BUILD_PARALLEL=1` only if you've verified the
    /// query-latency cost is acceptable for your own corpus size.
    /// A failed add is COUNTED via the shared `failures` counter, never silently dropped, on
    /// both paths — `add_failures()` still means what its doc says.
    pub fn bulk_add_sequential(&self, batch: &[(u32, Vec<f32>)]) -> Result<()> {
        let target = self.len() + batch.len();
        ensure_capacity(&self.index, target); // reserve the whole batch up front (no per-add race)
        if std::env::var("MNEME_BUILD_PARALLEL").as_deref() == Ok("1") {
            use rayon::prelude::*;
            let g = self.index.read().expect("index lock");
            batch.par_iter().for_each(|(id, v)| {
                if g.add(*id, v).is_err() {
                    self.failures.fetch_add(1, Ordering::Relaxed);
                }
            });
            return Ok(());
        }
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
