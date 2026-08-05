//! The mmap-backed `.mseg` segment: the storage substrate CRUD (P2-4) builds on.
//!
//! Files in the shard directory (SPEC §4.1, with the §1.5 clarification):
//!   `<name>.mseg` — 64 B file header + 4 KiB-aligned fixed-stride slot array. mmap'd RW,
//!                   grown by file-extend + remap. Existing slots never move (SPEC §6.1).
//!   `<name>.vec`  — parallel raw-f32 vector array, entry `i` = slot `i` (SPEC §3.3 bootstrap
//!                   before PQ). mmap'd RW, grown in lockstep with the slot array.
//!   `<name>.txt`  — append-only LZ4 text region (SPEC §1.5 clarification). Plain file:
//!                   blocks appended on insert, pread+decompressed on read.
//!
//! SAFETY: both mmaps are `unsafe` (mutating a mapped file is UB if done out from under the
//! map). `Segment` owns the files and the maps together and is the sole writer; growth flushes
//! then remaps. Callers get only checked typed views.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use memmap2::MmapMut;
use mseg_format::{
    flags, read_text, FileHeader, MsegError, Result, SlotHeader, TextRef, EDGE_WIRE_BYTES,
    FILE_HEADER_SIZE, SLOT_REGION_OFFSET, SLOT_SIZE,
};
use zerocopy::{FromBytes, IntoBytes};

/// Slots the segment is grown by when capacity is exceeded (amortizes remap cost).
const GROW_SLOTS: usize = 4096;
/// Initial slot capacity on create.
const INITIAL_SLOTS: usize = 1024;

/// A stable slot identifier (SPEC §5.1). Here it equals the physical slot index.
pub type SlotId = u32;

/// An mmap-backed `.mseg` segment plus its `.vec` and `.txt` companions.
pub struct Segment {
    dir: PathBuf,
    name: String,
    dim: usize,
    mseg_file: File,
    mmap: MmapMut, // [header | pad | slot array]
    vec_file: File,
    vec_mmap: MmapMut, // parallel f32 vectors, entry i = slot i
    txt_file: File,    // append-only text region
    txt_len: u64,
    edg_file: File, // append-only typed-edge overflow region (memory-engine layer)
    edg_len: u64,
    capacity: usize,                          // slots the current maps can hold
    hnsw: Option<crate::index::AsyncIndexer>, // optional async HNSW overlay (P3)
}

#[inline]
fn vec_bytes(dim: usize) -> usize {
    dim * 4
}

#[inline]
fn mseg_len_for(capacity: usize) -> u64 {
    (SLOT_REGION_OFFSET + capacity * SLOT_SIZE) as u64
}

impl Segment {
    fn paths(dir: &Path, name: &str) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        (
            dir.join(format!("{name}.amr")),
            dir.join(format!("{name}.vec")),
            dir.join(format!("{name}.txt")),
            dir.join(format!("{name}.edg")),
        )
    }

    /// Create a fresh, empty segment of dimension `dim` in `dir`. Overwrites any existing
    /// files of the same name.
    pub fn create(dir: &Path, name: &str, dim: usize) -> Result<Segment> {
        std::fs::create_dir_all(dir)?;
        let (mseg_path, vec_path, txt_path, edg_path) = Self::paths(dir, name);

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        // .mseg: header + pad + INITIAL_SLOTS capacity, zero-filled.
        let mseg_file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(true)
            .open(&mseg_path)?;
        mseg_file.set_len(mseg_len_for(INITIAL_SLOTS))?;
        let mut mmap = unsafe { MmapMut::map_mut(&mseg_file)? };
        {
            let hdr = FileHeader::new(dim as u32, now);
            write_header(&mut mmap, &hdr);
        }

        // .vec: parallel raw-f32 array, INITIAL_SLOTS capacity.
        let vec_file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(true)
            .open(&vec_path)?;
        vec_file.set_len((INITIAL_SLOTS * vec_bytes(dim)) as u64)?;
        let vec_mmap = unsafe { MmapMut::map_mut(&vec_file)? };

        // .txt: empty append-only text file.
        let txt_file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(true)
            .open(&txt_path)?;

        // .edg: empty append-only typed-edge overflow file.
        let edg_file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(true)
            .open(&edg_path)?;

        let mut seg = Segment {
            dir: dir.to_path_buf(),
            name: name.to_string(),
            dim,
            mseg_file,
            mmap,
            vec_file,
            vec_mmap,
            txt_file,
            txt_len: 0,
            edg_file,
            edg_len: 0,
            capacity: INITIAL_SLOTS,
            hnsw: None,
        };
        seg.flush()?;
        Ok(seg)
    }

    /// Open an existing segment, validating the file header.
    pub fn open(dir: &Path, name: &str) -> Result<Segment> {
        let (mseg_path, vec_path, txt_path, edg_path) = Self::paths(dir, name);
        let mseg_file = OpenOptions::new().read(true).write(true).open(&mseg_path)?;
        let mmap = unsafe { MmapMut::map_mut(&mseg_file)? };
        if mmap.len() < FILE_HEADER_SIZE {
            return Err(MsegError::Corrupt(format!(
                "{}.mseg shorter than file header",
                name
            )));
        }
        let hdr = read_header(&mmap)?;
        if !hdr.is_valid() {
            return Err(MsegError::BadHeader);
        }
        let dim = hdr.dim() as usize;
        let file_len = mmap.len() as u64;
        if file_len < mseg_len_for(0) {
            return Err(MsegError::Corrupt("mseg shorter than slot region".into()));
        }
        let capacity = ((file_len - SLOT_REGION_OFFSET as u64) / SLOT_SIZE as u64) as usize;

        let vec_file = OpenOptions::new().read(true).write(true).open(&vec_path)?;
        let vec_mmap = unsafe { MmapMut::map_mut(&vec_file)? };

        let mut txt_file = OpenOptions::new().read(true).write(true).open(&txt_path)?;
        let txt_len = txt_file.seek(SeekFrom::End(0))?;

        // .edg may not exist on shards written before the memory-engine layer — create if absent.
        let mut edg_file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false) // preserve existing edge overflow on reopen
            .open(&edg_path)?;
        let edg_len = edg_file.seek(SeekFrom::End(0))?;

        let mut seg = Segment {
            dir: dir.to_path_buf(),
            name: name.to_string(),
            dim,
            mseg_file,
            mmap,
            vec_file,
            vec_mmap,
            txt_file,
            txt_len,
            edg_file,
            edg_len,
            capacity,
            hnsw: None,
        };
        seg.recover_if_needed()?;
        Ok(seg)
    }

    /// Crash recovery (v1+): trust only `committed_count`. Any slots appended after the last
    /// `flush()` (in `[committed_count, slot_count)`) are discarded — at worst the last unflushed
    /// batch is lost, never corruption. v0 (pre-checkpoint) shards are trusted as fully committed.
    /// The free list is reset (orphaning any tombstones freed post-checkpoint) for safety; the next
    /// `compact()` reclaims that space. live_count is recomputed by scanning the survivors.
    fn recover_if_needed(&mut self) -> Result<()> {
        let hdr = read_header(&self.mmap)?;
        if hdr.format_version() < 1 {
            return Ok(()); // legacy: no checkpoint, trust slot_count as-is
        }
        let committed = hdr.committed_count();
        let slot_count = hdr.slot_count();
        if committed >= slot_count {
            return Ok(()); // clean shutdown — nothing to discard
        }
        let mut live = 0u32;
        for idx in 0..committed as usize {
            if !self.slot(idx)?.is_tombstoned() {
                live += 1;
            }
        }
        self.with_header_mut(|h| {
            h.set_slot_count(committed);
            h.set_live_count(live);
            h.set_free_list_head(mseg_format::SENTINEL_U32);
        });
        self.mmap.flush()?;
        Ok(())
    }

    pub fn dim(&self) -> usize {
        self.dim
    }
    pub fn dir(&self) -> &Path {
        &self.dir
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Read-only view of the file header.
    pub fn header(&self) -> FileHeader {
        read_header(&self.mmap).expect("header always valid once opened")
    }
    pub fn slot_count(&self) -> u32 {
        self.header().slot_count()
    }
    pub fn live_count(&self) -> u32 {
        self.header().live_count()
    }
    pub fn free_list_head(&self) -> u32 {
        self.header().free_list_head()
    }

    /// Apply `f` to a mutable view of the header, persisting the change in the mmap.
    pub(crate) fn with_header_mut<R>(&mut self, f: impl FnOnce(&mut FileHeader) -> R) -> R {
        let mut hdr = read_header(&self.mmap).expect("header valid");
        let r = f(&mut hdr);
        write_header(&mut self.mmap, &hdr);
        r
    }

    /// Read slot `i` (physical index). Bounds-checked against capacity.
    pub fn slot(&self, i: usize) -> Result<SlotHeader> {
        if i >= self.capacity {
            return Err(MsegError::NoSuchSlot(i as u32));
        }
        let off = SLOT_REGION_OFFSET + i * SLOT_SIZE;
        SlotHeader::ref_from_bytes(&self.mmap[off..off + SLOT_SIZE])
            .copied()
            .map_err(|_| MsegError::Corrupt("slot cast failed".into()))
    }

    /// Write slot `i` (physical index). Caller must have ensured capacity.
    pub(crate) fn write_slot(&mut self, i: usize, slot: &SlotHeader) -> Result<()> {
        if i >= self.capacity {
            return Err(MsegError::NoSuchSlot(i as u32));
        }
        let off = SLOT_REGION_OFFSET + i * SLOT_SIZE;
        self.mmap[off..off + SLOT_SIZE].copy_from_slice(slot.as_bytes());
        Ok(())
    }

    /// Ensure the maps can hold at least `needed` slots, growing (file-extend + remap) if not.
    pub(crate) fn ensure_capacity(&mut self, needed: usize) -> Result<()> {
        if needed <= self.capacity {
            return Ok(());
        }
        let new_cap = needed.max(self.capacity + GROW_SLOTS);
        // grow .mseg
        self.mmap.flush()?;
        self.mseg_file.set_len(mseg_len_for(new_cap))?;
        self.mmap = unsafe { MmapMut::map_mut(&self.mseg_file)? };
        // grow .vec in lockstep
        self.vec_mmap.flush()?;
        self.vec_file
            .set_len((new_cap * vec_bytes(self.dim)) as u64)?;
        self.vec_mmap = unsafe { MmapMut::map_mut(&self.vec_file)? };
        self.capacity = new_cap;
        Ok(())
    }

    /// Read the raw f32 vector for slot index `i` from the `.vec` mmap.
    pub fn read_vector(&self, i: usize) -> Result<Vec<f32>> {
        if i >= self.capacity {
            return Err(MsegError::NoSuchSlot(i as u32));
        }
        let vb = vec_bytes(self.dim);
        let off = i * vb;
        let bytes = &self.vec_mmap[off..off + vb];
        let mut out = Vec::with_capacity(self.dim);
        for c in 0..self.dim {
            let o = c * 4;
            out.push(f32::from_le_bytes(bytes[o..o + 4].try_into().unwrap()));
        }
        Ok(out)
    }

    /// Write the raw f32 vector for slot index `i` into the `.vec` mmap.
    pub(crate) fn write_vector(&mut self, i: usize, v: &[f32]) -> Result<()> {
        if v.len() != self.dim {
            return Err(MsegError::DimMismatch {
                segment: self.dim,
                got: v.len(),
            });
        }
        if i >= self.capacity {
            return Err(MsegError::NoSuchSlot(i as u32));
        }
        let vb = vec_bytes(self.dim);
        let off = i * vb;
        for (c, &x) in v.iter().enumerate() {
            let o = off + c * 4;
            self.vec_mmap[o..o + 4].copy_from_slice(&x.to_le_bytes());
        }
        Ok(())
    }

    /// Append an LZ4 text block to `.txt`, returning its `TextRef`. Append-only.
    pub(crate) fn append_text_block(&mut self, text: &[u8]) -> Result<TextRef> {
        // Build the block in memory via the format crate, then append to the file.
        let mut region: Vec<u8> = Vec::new();
        let mut r = mseg_format::append_text(&mut region, text)?;
        if r.is_empty() {
            return Ok(TextRef::NONE);
        }
        // shift ptr to the file-global offset where we are about to append
        r.text_ptr = self.txt_len as u32;
        self.txt_file.seek(SeekFrom::End(0))?;
        self.txt_file.write_all(&region)?;
        self.txt_len += region.len() as u64;
        Ok(r)
    }

    /// Read + decompress the text block referenced by `r` from `.txt`.
    pub fn read_text_block(&mut self, r: TextRef) -> Result<Vec<u8>> {
        if r.is_empty() {
            return Ok(Vec::new());
        }
        let mut buf = vec![0u8; r.text_len_lz4 as usize];
        self.txt_file.seek(SeekFrom::Start(r.text_ptr as u64))?;
        self.txt_file.read_exact(&mut buf)?;
        // read_text expects the block at offset 0 of the slice we pass.
        let local = TextRef {
            text_ptr: 0,
            text_len_lz4: r.text_len_lz4,
            text_len_raw: r.text_len_raw,
        };
        read_text(&buf, local)
    }

    /// Compact the variable text region (SPEC §5.5): rewrite `<name>.txt` keeping only the
    /// blocks of LIVE slots, reclaiming the bytes of tombstoned/superseded memories (which
    /// `delete` never frees — §6.4). Slot ids are NOT renumbered (§6.3): the fixed slot array
    /// and `.vec` are untouched; only each live slot's `text_ptr` is rewritten to its new offset
    /// in the compacted file. Returns the bytes reclaimed.
    ///
    /// This is a rare maintenance op — call it with the shard otherwise idle (no concurrent
    /// recall). It is correct on completion; it is not crash-atomic across the `.mseg`/`.txt`
    /// pair, so if interrupted mid-rename, re-run it (no data is lost — the slot array still
    /// names every live memory; only `text_ptr`s may need the rewrite to finish).
    pub fn compact(&mut self) -> Result<u64> {
        let n = self.slot_count() as usize;
        let txt_path = self.dir.join(format!("{}.txt", self.name));
        let tmp_path = self.dir.join(format!("{}.txt.compact", self.name));
        let old_len = self.txt_len;

        let mut tmp = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp_path)?;
        let mut new_len: u64 = 0;
        // copy each live slot's raw (still-compressed) block into the new file, rewrite its ptr.
        for i in 0..n {
            let mut slot = self.slot(i)?;
            if slot.is_tombstoned() || slot.text_len_lz4() == 0 {
                continue;
            }
            let len = slot.text_len_lz4() as usize;
            let mut buf = vec![0u8; len];
            self.txt_file
                .seek(SeekFrom::Start(slot.text_ptr() as u64))?;
            self.txt_file.read_exact(&mut buf)?;
            tmp.write_all(&buf)?;
            slot.set_text_ptr(new_len as u32);
            self.write_slot(i, &slot)?;
            new_len += len as u64;
        }
        tmp.flush()?;
        tmp.sync_all()?;
        drop(tmp);

        // commit: durably write the rewritten slot ptrs, then atomically swap in the new file.
        self.mmap.flush()?;
        std::fs::rename(&tmp_path, &txt_path)?;
        self.txt_file = OpenOptions::new().read(true).write(true).open(&txt_path)?;
        self.txt_len = new_len;
        let compacted_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as i64)
            .unwrap_or(0);
        self.with_header_mut(|h| {
            h.set_var_region_len(new_len as u32);
            h.set_last_compact_at(compacted_at);
        });

        // reclaim the `.edg` overflow region too: copy each LIVE overflow slot's edge block into a
        // fresh file and rewrite its descriptor — orphaned blocks from edge updates are dropped.
        let edg_path = self.dir.join(format!("{}.edg", self.name));
        let edg_tmp = self.dir.join(format!("{}.edg.compact", self.name));
        let old_edg = self.edg_len;
        let mut etmp = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&edg_tmp)?;
        let mut enew: u64 = 0;
        for i in 0..n {
            let mut slot = self.slot(i)?;
            if slot.is_tombstoned() || !slot.has_flag(flags::EDGE_OVERFLOW) {
                continue;
            }
            let (ptr, count) = slot.edge_overflow();
            let len = count as usize * EDGE_WIRE_BYTES;
            let mut buf = vec![0u8; len];
            self.edg_file.seek(SeekFrom::Start(ptr as u64))?;
            self.edg_file.read_exact(&mut buf)?;
            etmp.write_all(&buf)?;
            slot.set_edge_overflow(enew as u32, count);
            self.write_slot(i, &slot)?;
            enew += len as u64;
        }
        etmp.flush()?;
        etmp.sync_all()?;
        drop(etmp);
        self.mmap.flush()?;
        std::fs::rename(&edg_tmp, &edg_path)?;
        self.edg_file = OpenOptions::new().read(true).write(true).open(&edg_path)?;
        self.edg_len = enew;

        self.flush()?;
        Ok((old_len.saturating_sub(new_len)) + old_edg.saturating_sub(enew))
    }

    /// Flush all maps + files to disk (msync + fsync).
    pub fn flush(&mut self) -> Result<()> {
        // Crash-safe checkpoint. Ordering matters: data durable BEFORE the header records it as
        // committed, so a crash never leaves committed_count pointing at unwritten data. A crash
        // between flushes loses at most the last unflushed batch — never corruption.
        // 1) data files durable first
        self.vec_mmap.flush()?;
        self.txt_file.flush()?;
        self.edg_file.flush()?;
        self.vec_file.sync_all()?;
        self.txt_file.sync_all()?;
        self.edg_file.sync_all()?;
        // 2) slots durable while header.committed_count still holds the OLD value
        self.mmap.flush()?;
        self.mseg_file.sync_all()?;
        // 3) advance the checkpoint to cover every now-durable slot; stamp the v1 format
        let committed = self.header().slot_count();
        self.with_header_mut(|h| {
            h.set_committed_count(committed);
            h.set_format_version(mseg_format::FORMAT_VERSION);
        });
        // 4) header durable — THIS is the commit point
        self.mmap.flush()?;
        self.mseg_file.sync_all()?;
        // Persist the HNSW graph so a reopen loads it (ms) instead of rebuilding from scratch
        // (minutes at scale). Best-effort: a save failure must not fail the data flush.
        if let Some(ix) = &self.hnsw {
            let mnsw_path = self.dir.join(format!("{}.mnsw", self.name));
            if let Err(e) = ix.save(&mnsw_path) {
                eprintln!("[mneme] warn: .mnsw save failed ({e}); will rebuild on next open");
            }
        }
        Ok(())
    }

    /// Append raw typed-edge bytes to the `.edg` region; returns the byte offset. Append-only
    /// (old overflow blocks are orphaned on rewrite, reclaimed at compact — same as `.txt`).
    pub(crate) fn append_edge_bytes(&mut self, buf: &[u8]) -> Result<u32> {
        let off = self.edg_len;
        self.edg_file.seek(SeekFrom::End(0))?;
        self.edg_file.write_all(buf)?;
        self.edg_len += buf.len() as u64;
        Ok(off as u32)
    }

    /// Read `len` typed-edge bytes from the `.edg` region at `ptr`.
    pub(crate) fn read_edge_bytes(&self, ptr: u32, len: usize) -> Result<Vec<u8>> {
        let mut f = &self.edg_file;
        f.seek(SeekFrom::Start(ptr as u64))?;
        let mut buf = vec![0u8; len];
        f.read_exact(&mut buf)?;
        Ok(buf)
    }

    // --- HNSW overlay (P3) -------------------------------------------------------

    /// Enable the async HNSW overlay, seeding it with every existing live slot. After this,
    /// `insert` enqueues new vectors for background indexing and `recall` uses HNSW candidates.
    /// Idempotent-ish: re-enabling rebuilds the overlay from the current segment.
    pub fn enable_hnsw(&mut self) -> Result<()> {
        // Fast path: a persisted .mnsw exists → load it (ms) instead of rebuilding the graph.
        let mnsw_path = self.dir.join(format!("{}.mnsw", self.name));
        if mnsw_path.exists() {
            match crate::index::AsyncIndexer::load(&mnsw_path, self.dim) {
                Ok(ix) => {
                    self.hnsw = Some(ix);
                    return Ok(());
                }
                Err(e) => eprintln!("[mneme] warn: .mnsw load failed ({e}); rebuilding"),
            }
        }
        let n = self.slot_count() as usize;
        let indexer = crate::index::AsyncIndexer::new(self.dim, n.max(self.capacity))?;
        // Seed in parallel chunks: collect a chunk of live (id, vector) pairs, parallel-add it,
        // then drop it — bounds extra RAM to chunk_size·dim·4 while using all cores.
        const CHUNK: usize = 50_000;
        let mut batch: Vec<(u32, Vec<f32>)> = Vec::with_capacity(CHUNK.min(n));
        for idx in 0..n {
            let slot = self.slot(idx)?;
            if slot.is_tombstoned() {
                continue;
            }
            batch.push((slot.id(), self.read_vector(idx)?));
            if batch.len() >= CHUNK {
                indexer.bulk_add_sequential(&batch)?;
                batch.clear();
            }
        }
        if !batch.is_empty() {
            indexer.bulk_add_sequential(&batch)?;
        }
        self.hnsw = Some(indexer);
        Ok(())
    }

    /// True if the HNSW overlay is enabled.
    pub fn hnsw_enabled(&self) -> bool {
        self.hnsw.is_some()
    }

    /// Enqueue a vector for async indexing (no-op if the overlay is disabled). Never blocks,
    /// never rebuilds (SPEC §6.2) — called from the `insert` path in crud.rs.
    pub(crate) fn enqueue_index_add(&self, slot_id: u32, vector: &[f32]) {
        if let Some(ix) = &self.hnsw {
            ix.enqueue(slot_id, vector);
        }
    }

    /// Approximate HNSW candidate search (returns `None` if the overlay is disabled).
    pub(crate) fn hnsw_search(
        &self,
        query: &[f32],
        k: usize,
    ) -> Option<Result<Vec<mnsw_index::Candidate>>> {
        self.hnsw.as_ref().map(|ix| ix.search(query, k))
    }

    /// Block until all enqueued index adds are applied (test/flush helper).
    pub fn index_drain(&self) {
        if let Some(ix) = &self.hnsw {
            ix.drain();
        }
    }

    /// Number of vectors currently in the HNSW overlay (0 if disabled).
    pub fn hnsw_len(&self) -> usize {
        self.hnsw.as_ref().map(|ix| ix.len()).unwrap_or(0)
    }
}

impl Drop for Segment {
    fn drop(&mut self) {
        // Best-effort flush on drop (SPEC §4.3 Shard::drop flushes). Errors are swallowed
        // here only because Drop cannot return them; explicit flush() is offered for callers
        // that must observe failure.
        let _ = self.mmap.flush();
        let _ = self.vec_mmap.flush();
        let _ = self.txt_file.flush();
    }
}

// --- header helpers (cast to/from the mmap prefix) ------------------------------

fn read_header(mmap: &[u8]) -> Result<FileHeader> {
    FileHeader::ref_from_bytes(&mmap[..FILE_HEADER_SIZE])
        .copied()
        .map_err(|_| MsegError::Corrupt("file header cast failed".into()))
}

fn write_header(mmap: &mut [u8], hdr: &FileHeader) {
    mmap[..FILE_HEADER_SIZE].copy_from_slice(hdr.as_bytes());
}

#[cfg(test)]
mod crash_tests {
    use crate::{Filter, MemoryInput, Segment};
    use tempfile::tempdir;

    /// Simulate a crash in the exact danger window: N slots flushed (committed), M more appended
    /// and their slots msync'd to disk, but the process dies BEFORE the checkpoint advances. On
    /// reopen, recovery must discard the M uncommitted slots — surviving count = N, no corruption.
    #[test]
    fn recovers_to_last_checkpoint_after_crash() {
        let dir = tempdir().unwrap();
        const N: usize = 100;
        const M: usize = 37;
        {
            let mut seg = Segment::create(dir.path(), "g", 4).unwrap();
            for i in 0..N {
                seg.insert(MemoryInput::new(format!("c{i}"), vec![i as f32, 1.0, 0.0, 0.0]))
                    .unwrap();
            }
            seg.flush().unwrap(); // checkpoint at N
            for i in 0..M {
                seg.insert(MemoryInput::new(format!("u{i}"), vec![1000.0 + i as f32, 1.0, 0.0, 0.0]))
                    .unwrap();
            }
            // crash window: slots durable on disk, but committed_count NOT advanced (no flush()).
            seg.mmap.flush().unwrap();
            seg.vec_mmap.flush().unwrap();
            seg.mseg_file.sync_all().unwrap();
            // (drop without flush = power loss here)
        }
        // reopen → recovery truncates the uncommitted tail.
        let mut seg = Segment::open(dir.path(), "g").unwrap();
        assert_eq!(seg.slot_count(), N as u32, "uncommitted tail must be discarded");
        // a query for an uncommitted vector must NOT return one (it's gone, not corrupt).
        let hits = seg.recall(&[1000.0, 1.0, 0.0, 0.0], &Filter::default(), 5).unwrap();
        assert!(
            hits.iter().all(|h| (h.slot_id as usize) < N),
            "no recovered hit may reference a discarded slot"
        );
        // committed data is intact + queryable.
        let ok = seg.recall(&[5.0, 1.0, 0.0, 0.0], &Filter::default(), 1).unwrap();
        assert_eq!(seg.get(ok[0].slot_id).unwrap().text, "c5");
    }
}
