//! T1-7 — recall_pq() (ADC/PQ) vs recall_hnsw() vs recall_brute() at a chosen scale, using the
//! SAME real-base + deterministic-perturbation scale-up as bench_1m.rs (bench/RESULTS.md),
//! so this is directly comparable to that gate's numbers, not a separate/inconsistent dataset.
//!
//! Usage: pq-bench <corpus_f32.bin> <queries_f32.bin> <dim> <target_n> [top_k]

use std::path::Path;
use std::time::Instant;

use mseg::{Filter, MemoryInput, Segment};

fn load_f32(path: &Path, dim: usize) -> Vec<Vec<f32>> {
    std::fs::read(path)
        .expect("read f32 bin")
        .chunks_exact(dim * 4)
        .map(|r| {
            r.chunks_exact(4)
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .collect()
        })
        .collect()
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let rank = (p / 100.0) * ((sorted.len() - 1) as f64);
    let lo = rank.floor() as usize;
    let hi = rank.ceil() as usize;
    if lo == hi {
        sorted[lo]
    } else {
        let f = rank - lo as f64;
        sorted[lo] * (1.0 - f) + sorted[hi] * f
    }
}

/// Deterministic perturbed copy of `base` — identical to bench_1m.rs's own `perturb()`, kept in
/// sync deliberately so both harnesses generate the same scaled corpus given the same inputs.
fn perturb(base: &[f32], seed: u64) -> Vec<f32> {
    let mut s = seed
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        .wrapping_add(0x1234_5678);
    let mut v: Vec<f32> = base
        .iter()
        .map(|&x| {
            s ^= s >> 12;
            s ^= s << 25;
            s ^= s >> 27;
            let noise = (((s >> 11) as f64 / (1u64 << 53) as f64) as f32 - 0.5) * 0.08;
            x + noise
        })
        .collect();
    let n: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 0.0 {
        for x in &mut v {
            *x /= n;
        }
    }
    v
}

fn measure<F: FnMut(&[f32]) -> Result<Vec<mseg::Hit>, mseg_format::MsegError>>(
    queries: &[Vec<f32>],
    mut recall_fn: F,
) -> (f64, f64, Vec<Vec<u32>>) {
    for q in queries.iter().take(20.min(queries.len())) {
        let _ = recall_fn(q);
    }
    let mut samples = Vec::with_capacity(queries.len());
    let mut all_hits = Vec::with_capacity(queries.len());
    for q in queries {
        let t = Instant::now();
        let hits = recall_fn(q).expect("recall");
        samples.push(t.elapsed().as_secs_f64() * 1e3);
        all_hits.push(hits.iter().map(|h| h.slot_id).collect());
    }
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    (percentile(&samples, 50.0), percentile(&samples, 90.0), all_hits)
}

fn recall_overlap(a: &[Vec<u32>], b: &[Vec<u32>]) -> f64 {
    let mut hit = 0usize;
    let mut total = 0usize;
    for (ha, hb) in a.iter().zip(b) {
        let set_b: std::collections::HashSet<u32> = hb.iter().copied().collect();
        hit += ha.iter().filter(|x| set_b.contains(x)).count();
        total += ha.len().max(hb.len());
    }
    if total == 0 { 1.0 } else { hit as f64 / total as f64 }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 5 {
        eprintln!("usage: {} <corpus> <queries> <dim> <target_n> [top_k]", args[0]);
        std::process::exit(2);
    }
    let dim: usize = args[3].parse().expect("dim");
    let target_n: usize = args[4].parse().expect("target_n");
    let top_k: usize = args.get(5).and_then(|s| s.parse().ok()).unwrap_or(10);

    let real = load_f32(Path::new(&args[1]), dim);
    let queries = load_f32(Path::new(&args[2]), dim);
    let n_real = real.len();
    eprintln!("real base={n_real}, target_n={target_n}, dim={dim}, building segment...");

    let tmp = std::env::temp_dir().join("mneme_pq_bench");
    let _ = std::fs::remove_dir_all(&tmp);
    let mut seg = Segment::create(&tmp, "m1", dim).expect("create");

    let t_ins = Instant::now();
    for i in 0..target_n {
        let v = if i < n_real { real[i].clone() } else { perturb(&real[i % n_real], i as u64) };
        let mut mem = MemoryInput::new(String::new(), v);
        mem.valid_from = i as i64;
        seg.insert(mem).expect("insert");
    }
    eprintln!("inserted {target_n} in {:.1}s", t_ins.elapsed().as_secs_f64());

    let filter = Filter::default();

    // ground truth = brute force (exact) — same oracle role as everywhere else in this repo.
    let (p50_brute, p90_brute, gt_hits) = measure(&queries, |q| seg.recall_brute(q, &filter, top_k));
    eprintln!("brute p50={p50_brute:.3}ms p90={p90_brute:.3}ms (ground truth)");

    let t_idx = Instant::now();
    seg.enable_hnsw().expect("enable hnsw");
    seg.index_drain();
    let hnsw_build_s = t_idx.elapsed().as_secs_f64();
    let (p50_hnsw, p90_hnsw, hnsw_hits) = measure(&queries, |q| seg.recall(q, &filter, top_k));
    let recall_hnsw = recall_overlap(&hnsw_hits, &gt_hits);
    eprintln!("hnsw build={hnsw_build_s:.1}s p50={p50_hnsw:.3}ms p90={p90_hnsw:.3}ms recall={recall_hnsw:.4}");

    let t_pq = Instant::now();
    seg.train_pq(42).expect("train_pq");
    let pq_build_s = t_pq.elapsed().as_secs_f64();
    let (p50_pq, p90_pq, pq_hits) = measure(&queries, |q| seg.recall_pq(q, &filter, top_k));
    let recall_pq = recall_overlap(&pq_hits, &gt_hits);
    eprintln!("pq   build={pq_build_s:.1}s p50={p50_pq:.3}ms p90={p90_pq:.3}ms recall={recall_pq:.4}");

    println!("n={target_n} dim={dim} top_k={top_k}");
    println!("brute_p50_ms={p50_brute:.3} brute_p90_ms={p90_brute:.3}");
    println!("hnsw_build_s={hnsw_build_s:.1} hnsw_p50_ms={p50_hnsw:.3} hnsw_p90_ms={p90_hnsw:.3} hnsw_recall={recall_hnsw:.4}");
    println!("pq_build_s={pq_build_s:.1} pq_p50_ms={p50_pq:.3} pq_p90_ms={p90_pq:.3} pq_recall={recall_pq:.4}");
}
