//! mneme `.mpq` Product Quantization — per-org codebook (k-means), encode/decode, the `.mpq`
//! on-disk format, and (P4-2/P4-3) ADC distance + centroid drift detection.
//!
//! PQ is one of the three things that ARE mneme (reference/OPENSOURCE_RECON.md): usearch does
//! scalar i8 quantization only, not product quantization, and the per-org codebook + drift
//! detection has no off-the-shelf equivalent — so it is built here, not reused.

mod adc;
mod codebook;
mod drift;
mod format;

pub use adc::AdcTable;
pub use codebook::{PqCodebook, PqParams};
pub use drift::{alignment_score, is_drifted, DRIFT_THRESHOLD};
pub use format::{load, save, MpqError, Result, MPQ_HEADER_SIZE, MPQ_MAGIC, MPQ_VERSION};
