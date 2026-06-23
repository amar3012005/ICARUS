//! Asymmetric Distance Computation (SPEC §3.3). The query stays full-precision; only the
//! database vectors are PQ-coded. We precompute, per query, a table of `query_subvec → each
//! centroid` distances, then a code's distance is just `M` table lookups summed — no decode.
//!
//! For L2-normalized vectors, squared-L2 distance `= 2 − 2·cos`, so ranking by ascending ADC
//! squared-L2 is identical to ranking by descending cosine — which is what recall wants.

use crate::codebook::PqCodebook;

/// Per-query ADC lookup table: `table[s*k + c]` = squared-L2(query subvec s, centroid s,c).
pub struct AdcTable {
    m: usize,
    k: usize,
    table: Vec<f32>,
}

impl PqCodebook {
    /// Precompute the ADC table for `query` (length `dim`).
    pub fn adc_table(&self, query: &[f32]) -> AdcTable {
        let p = self.params();
        assert_eq!(query.len(), p.dim, "adc query dim mismatch");
        let sd = p.sub_dim();
        let mut table = vec![0.0f32; p.m * p.k];
        for s in 0..p.m {
            let q = &query[s * sd..s * sd + sd];
            for c in 0..p.k {
                let cent = self.centroid_pub(s, c);
                table[s * p.k + c] = q
                    .iter()
                    .zip(cent)
                    .map(|(a, b)| (a - b) * (a - b))
                    .sum::<f32>();
            }
        }
        AdcTable {
            m: p.m,
            k: p.k,
            table,
        }
    }
}

impl AdcTable {
    /// Approximate squared-L2 distance from the query to a PQ `code` (lower = closer).
    #[inline]
    pub fn distance(&self, code: &[u8]) -> f32 {
        debug_assert_eq!(code.len(), self.m);
        let mut acc = 0.0f32;
        for (s, &c) in code.iter().enumerate() {
            acc += self.table[s * self.k + c as usize];
        }
        acc
    }
}
