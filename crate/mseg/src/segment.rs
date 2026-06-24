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
    read_text, FileHeader, MsegError, Result, SlotHeader, TextRef, FILE_HEADER_SIZE,
    SLOT_REGION_OFFSET, SLOT_SIZE,
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
    fn paths(dir: &Path, name: &str) -> (PathBuf, PathBuf, PathBuf) {
        (
            dir.join(format!("{name}.mseg")),
            dir.join(format!("{name}.vec")),
            dir.join(format!("{name}.txt")),
        )
    }

    /// Create a fresh, empty segment of dimension `dim` in `dir`. Overwrites any existing
    /// files of the same name.
    pub fn create(dir: &Path, name: &str, dim: usize) -> Result<Segment> {
        std::fs::create_dir_all(dir)?;
        let (mseg_path, vec_path, txt_path) = Self::paths(dir, name);

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
            capacity: INITIAL_SLOTS,
            hnsw: None,
        };
        seg.flush()?;
        Ok(seg)
    }

    /// Open an existing segment, validating the file header.
    pub fn open(dir: &Path, name: &str) -> Result<Segment> {
        let (mseg_path, vec_path, txt_path) = Self::paths(dir, name);
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

        Ok(Segment {
            dir: dir.to_path_buf(),
            name: name.to_string(),
            dim,
            mseg_file,
            mmap,
            vec_file,
            vec_mmap,
            txt_file,
            txt_len,
            capacity,
            hnsw: None,
        })
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
        self.flush()?;
        Ok(old_len.saturating_sub(new_len))
    }

    /// Flush all maps + files to disk (msync + fsync).
    pub fn flush(&mut self) -> Result<()> {
        self.mmap.flush()?;
        self.vec_mmap.flush()?;
        self.txt_file.flush()?;
        self.mseg_file.sync_all()?;
        self.vec_file.sync_all()?;
        self.txt_file.sync_all()?;
        Ok(())
    }

    // --- HNSW overlay (P3) -------------------------------------------------------

    /// Enable the async HNSW overlay, seeding it with every existing live slot. After this,
    /// `insert` enqueues new vectors for background indexing and `recall` uses HNSW candidates.
    /// Idempotent-ish: re-enabling rebuilds the overlay from the current segment.
    pub fn enable_hnsw(&mut self) -> Result<()> {
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
