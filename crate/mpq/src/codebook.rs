//! Product Quantization codebook: per-subspace k-means, encode (vector → 128-byte code),
//! decode (code → reconstructed vector). mneme's own IP (usearch does scalar i8 only, not PQ).
//!
//! Layout (SPEC §3.1, erratum-corrected): a `dim`-vector is split into `M` contiguous
//! subspaces of `dim/M` dims each; each subspace has its own `K` centroids learned by k-means.
//! A code is `M` bytes — one centroid index (`u8`, so `K ≤ 256`) per subspace. For the frozen
//! 128-byte `vector_pq` field: M=128, K=256, dim=1024 → 8 dims/subspace, 32× compression.

use rayon::prelude::*;

/// Codebook parameters. `sub_dim = dim / m` (must divide evenly).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PqParams {
    pub m: usize,
    pub k: usize,
    pub dim: usize,
}

impl PqParams {
    pub fn sub_dim(&self) -> usize {
        self.dim / self.m
    }
    fn validate(&self) {
        assert!(
            self.m > 0 && self.k > 0 && self.dim > 0,
            "pq params must be > 0"
        );
        assert!(self.k <= 256, "K must be ≤ 256 (1-byte code)");
        assert_eq!(self.dim % self.m, 0, "dim must be divisible by M");
    }
}

/// A trained PQ codebook. `centroids` is row-major `[m][k][sub_dim]` f32.
#[derive(Debug, Clone)]
pub struct PqCodebook {
    params: PqParams,
    centroids: Vec<f32>,
    /// Number of vectors the codebook was trained on (provenance; written to `.mpq`).
    pub trained_on: u32,
}

impl PqCodebook {
    pub fn params(&self) -> PqParams {
        self.params
    }
    pub fn centroids(&self) -> &[f32] {
        &self.centroids
    }

    /// Construct from raw centroids (used by the `.mpq` loader). Length must be `m*k*sub_dim`.
    pub fn from_parts(params: PqParams, centroids: Vec<f32>, trained_on: u32) -> Self {
        params.validate();
        assert_eq!(
            centroids.len(),
            params.m * params.k * params.sub_dim(),
            "centroid buffer wrong length"
        );
        PqCodebook {
            params,
            centroids,
            trained_on,
        }
    }

    /// Slice of centroid `c` in subspace `s`.
    #[inline]
    fn centroid(&self, s: usize, c: usize) -> &[f32] {
        let sd = self.params.sub_dim();
        let base = (s * self.params.k + c) * sd;
        &self.centroids[base..base + sd]
    }

    /// Train a codebook on `vectors` (each length `dim`) via per-subspace k-means. `seed`
    /// makes training deterministic. Subspaces train in parallel (rayon).
    pub fn train(vectors: &[Vec<f32>], m: usize, k: usize, seed: u64) -> Self {
        assert!(!vectors.is_empty(), "cannot train on empty set");
        let dim = vectors[0].len();
        let params = PqParams { m, k, dim };
        params.validate();
        let sd = params.sub_dim();

        // train each subspace independently and in parallel; collect (subspace, centroids).
        let mut per_sub: Vec<(usize, Vec<f32>)> = (0..m)
            .into_par_iter()
            .map(|s| {
                // gather the s-th subvector of every training point.
                let sub: Vec<&[f32]> = vectors.iter().map(|v| &v[s * sd..s * sd + sd]).collect();
                let cents = kmeans(&sub, k, sd, seed ^ (s as u64).wrapping_mul(0x9E37_79B9));
                (s, cents)
            })
            .collect();
        per_sub.sort_by_key(|(s, _)| *s);

        let mut centroids = vec![0.0f32; m * k * sd];
        for (s, cents) in per_sub {
            let base = s * k * sd;
            centroids[base..base + k * sd].copy_from_slice(&cents);
        }
        PqCodebook {
            params,
            centroids,
            trained_on: vectors.len() as u32,
        }
    }

    /// Encode a full `dim`-vector into an `m`-byte PQ code (nearest centroid per subspace).
    pub fn encode(&self, vec: &[f32]) -> Vec<u8> {
        assert_eq!(vec.len(), self.params.dim, "encode dim mismatch");
        let sd = self.params.sub_dim();
        (0..self.params.m)
            .map(|s| {
                let sub = &vec[s * sd..s * sd + sd];
                let mut best = 0u8;
                let mut best_d = f32::INFINITY;
                for c in 0..self.params.k {
                    let d = l2_sq(sub, self.centroid(s, c));
                    if d < best_d {
                        best_d = d;
                        best = c as u8;
                    }
                }
                best
            })
            .collect()
    }

    /// Decode an `m`-byte code back to an approximate `dim`-vector (concatenate centroids).
    pub fn decode(&self, code: &[u8]) -> Vec<f32> {
        assert_eq!(code.len(), self.params.m, "decode code length mismatch");
        let sd = self.params.sub_dim();
        let mut out = vec![0.0f32; self.params.dim];
        for (s, &c) in code.iter().enumerate() {
            out[s * sd..s * sd + sd].copy_from_slice(self.centroid(s, c as usize));
        }
        out
    }
}

/// Squared L2 distance.
#[inline]
fn l2_sq(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| (x - y) * (x - y)).sum()
}

/// Deterministic xorshift64* RNG → f64 in [0, 1).
struct Rng(u64);
impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed | 1)
    }
    #[inline]
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    #[inline]
    fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// k-means over `points` (each `sub_dim` long) → `k` centroids (`k*sub_dim` flat).
/// kmeans++ init + Lloyd iterations; empty clusters reseed to the worst-fit point.
fn kmeans(points: &[&[f32]], k: usize, sub_dim: usize, seed: u64) -> Vec<f32> {
    let n = points.len();
    let mut rng = Rng::new(seed);

    // Degenerate: fewer points than clusters → use points (cycled) as centroids.
    if n <= k {
        let mut cents = vec![0.0f32; k * sub_dim];
        for c in 0..k {
            let p = points[c % n];
            cents[c * sub_dim..c * sub_dim + sub_dim].copy_from_slice(p);
        }
        return cents;
    }

    // --- kmeans++ initialization ---
    let mut cents = vec![0.0f32; k * sub_dim];
    let first = rng.next_u64() as usize % n;
    cents[0..sub_dim].copy_from_slice(points[first]);
    let mut d2: Vec<f32> = points.iter().map(|p| l2_sq(p, points[first])).collect();
    for c in 1..k {
        // sample next center with probability ∝ D²
        let sum: f64 = d2.iter().map(|&x| x as f64).sum();
        let mut target = rng.next_f64() * sum;
        let mut chosen = n - 1;
        for (i, &di) in d2.iter().enumerate() {
            target -= di as f64;
            if target <= 0.0 {
                chosen = i;
                break;
            }
        }
        cents[c * sub_dim..c * sub_dim + sub_dim].copy_from_slice(points[chosen]);
        // update nearest-center squared distances
        for (i, p) in points.iter().enumerate() {
            let dd = l2_sq(p, &cents[c * sub_dim..c * sub_dim + sub_dim]);
            if dd < d2[i] {
                d2[i] = dd;
            }
        }
    }

    // --- Lloyd iterations ---
    let max_iter = 25;
    let mut assign = vec![0usize; n];
    for _ in 0..max_iter {
        let mut changed = false;
        // assignment step
        for (i, p) in points.iter().enumerate() {
            let mut best = 0usize;
            let mut best_d = f32::INFINITY;
            for c in 0..k {
                let d = l2_sq(p, &cents[c * sub_dim..c * sub_dim + sub_dim]);
                if d < best_d {
                    best_d = d;
                    best = c;
                }
            }
            if assign[i] != best {
                assign[i] = best;
                changed = true;
            }
        }
        // update step: centroid = mean of assigned points
        let mut sums = vec![0.0f32; k * sub_dim];
        let mut counts = vec![0u32; k];
        for (i, p) in points.iter().enumerate() {
            let c = assign[i];
            counts[c] += 1;
            for (d, &x) in p.iter().enumerate() {
                sums[c * sub_dim + d] += x;
            }
        }
        for c in 0..k {
            if counts[c] == 0 {
                // empty cluster → reseed to the point currently worst-fit to its centroid.
                let mut worst = 0usize;
                let mut worst_d = -1.0f32;
                for (i, p) in points.iter().enumerate() {
                    let d = l2_sq(
                        p,
                        &cents[assign[i] * sub_dim..assign[i] * sub_dim + sub_dim],
                    );
                    if d > worst_d {
                        worst_d = d;
                        worst = i;
                    }
                }
                cents[c * sub_dim..c * sub_dim + sub_dim].copy_from_slice(points[worst]);
                assign[worst] = c;
                changed = true;
            } else {
                let inv = 1.0 / counts[c] as f32;
                for d in 0..sub_dim {
                    cents[c * sub_dim + d] = sums[c * sub_dim + d] * inv;
                }
            }
        }
        if !changed {
            break;
        }
    }
    cents
}
