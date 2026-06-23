//! Variable-length LZ4 text region (SPEC §1.5).
//!
//! The region is a flat byte buffer of back-to-back independent LZ4 blocks. A slot's
//! `text_ptr` is the byte offset of its block within the region; `text_len_lz4` is the
//! compressed length; `text_len_raw` is the original length (needed to size the decode).
//!
//! This module is pure (no I/O): the writer appends into an owned/borrowed `Vec<u8>`, and
//! the reader decompresses out of any `&[u8]` — which in P2-3 is a slice of the mmap. The
//! write path is append-only (SPEC §6.1): blocks are never moved or overwritten here.

use lz4_flex::block::{compress, decompress};

use crate::error::{MsegError, Result};
use crate::header::MAX_TEXT_BYTES;

/// A reference to one text block in the variable region — exactly the three slot fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextRef {
    pub text_ptr: u32,
    pub text_len_lz4: u32,
    pub text_len_raw: u32,
}

impl TextRef {
    /// The "no text" reference (SPEC §1.3: `text_len_lz4 == 0` means empty).
    pub const NONE: TextRef = TextRef {
        text_ptr: 0,
        text_len_lz4: 0,
        text_len_raw: 0,
    };

    pub fn is_empty(&self) -> bool {
        self.text_len_lz4 == 0
    }
}

/// Append `text` as an LZ4 block to `region`, returning its `TextRef`.
///
/// Enforces the 64 KiB cap (SPEC §1.5). Empty text appends nothing and returns
/// `TextRef::NONE`. Append-only: never mutates existing bytes.
pub fn append_text(region: &mut Vec<u8>, text: &[u8]) -> Result<TextRef> {
    if text.len() > MAX_TEXT_BYTES {
        return Err(MsegError::TextTooLarge {
            len: text.len(),
            max: MAX_TEXT_BYTES,
        });
    }
    if text.is_empty() {
        return Ok(TextRef::NONE);
    }
    let ptr = region.len() as u32;
    let comp = compress(text);
    region.extend_from_slice(&comp);
    Ok(TextRef {
        text_ptr: ptr,
        text_len_lz4: comp.len() as u32,
        text_len_raw: text.len() as u32,
    })
}

/// Decompress the block referenced by `r` out of `region`. Bounds-checked.
pub fn read_text(region: &[u8], r: TextRef) -> Result<Vec<u8>> {
    if r.is_empty() {
        return Ok(Vec::new());
    }
    let start = r.text_ptr as usize;
    let end = start + r.text_len_lz4 as usize;
    let block = region.get(start..end).ok_or(MsegError::OutOfBounds {
        start,
        end,
        len: region.len(),
    })?;
    decompress(block, r.text_len_raw as usize).map_err(|e| MsegError::Decompress(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn empty_text_is_none_ref() {
        let mut region = Vec::new();
        let r = append_text(&mut region, b"").unwrap();
        assert_eq!(r, TextRef::NONE);
        assert!(r.is_empty());
        assert!(region.is_empty());
        assert_eq!(read_text(&region, r).unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn over_cap_is_rejected() {
        let mut region = Vec::new();
        let big = vec![b'x'; MAX_TEXT_BYTES + 1];
        assert!(matches!(
            append_text(&mut region, &big),
            Err(MsegError::TextTooLarge { .. })
        ));
        // exactly at the cap is allowed
        let ok = vec![b'y'; MAX_TEXT_BYTES];
        assert!(append_text(&mut region, &ok).is_ok());
    }

    #[test]
    fn multiple_blocks_addressable_independently() {
        let mut region = Vec::new();
        let a = append_text(&mut region, b"the first memory").unwrap();
        let b = append_text(&mut region, b"a second, different memory text").unwrap();
        // blocks are back-to-back; b starts where a's block ends
        assert_eq!(b.text_ptr, a.text_ptr + a.text_len_lz4);
        assert_eq!(read_text(&region, a).unwrap(), b"the first memory");
        assert_eq!(
            read_text(&region, b).unwrap(),
            b"a second, different memory text"
        );
    }

    #[test]
    fn corrupt_ref_is_out_of_bounds_not_panic() {
        let mut region = Vec::new();
        let _ = append_text(&mut region, b"hello").unwrap();
        let bad = TextRef {
            text_ptr: 9999,
            text_len_lz4: 10,
            text_len_raw: 5,
        };
        assert!(matches!(
            read_text(&region, bad),
            Err(MsegError::OutOfBounds { .. })
        ));
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(200))]
        // Any utf8-ish bytes up to the cap round-trip through compress -> ptr -> decompress.
        #[test]
        fn prop_text_roundtrip(blocks in proptest::collection::vec(
            proptest::collection::vec(any::<u8>(), 0..4096), 0..20))
        {
            let mut region = Vec::new();
            let mut refs = Vec::new();
            for b in &blocks {
                refs.push(append_text(&mut region, b).unwrap());
            }
            for (i, b) in blocks.iter().enumerate() {
                prop_assert_eq!(&read_text(&region, refs[i]).unwrap(), b);
            }
        }
    }
}
