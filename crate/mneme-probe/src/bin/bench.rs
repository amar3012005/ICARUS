//! mneme P1 benchmark binary.
//!
//! Loads the real bge-m3 corpus + queries produced by `bench/gen_vectors.py`, builds a
//! probe `.mseg` segment, and measures the per-query wall-clock latency of a brute-force
//! int8 cosine recall@k — the number the P1 gate compares against Qdrant REST.
//!
//! Usage:
//!   mneme-bench <corpus_f32.bin> <queries_f32.bin> <dim> <top_k> [warmup] [repeats]
//!
//! Prints, on stdout:
//!   mneme_scan_p50_ms=<f>        # median per-query recall latency (the gate number)
//!   mneme_scan_p90_ms=<f>
//!   mneme_scan_mean_ms=<f>
//!   mneme_recall_at_k=<f>        # overlap of int8 top-k vs exact f32 oracle (quality sanity)
//!   mneme_n_corpus=<n>  mneme_n_query=<n>  mneme_dim=<d>
//!
//! The mneme number measures only the recall operation (no network, no process spawn),
//! exactly mirroring what Qdrant's REST p50 measures: time to answer one query.

use std::path::Path;
use std::time::Instant;

use mneme_probe::{exact_topk_f32, load_f32_matrix, quantize_i8, write_segment, Segment};

fn percentile(sorted_ms: &[f64], p: f64) -> f64 {
    if sorted_ms.is_empty() {
        return f64::NAN;
    }
    let rank = (p / 100.0) * ((sorted_ms.len() - 1) as f64);
    let lo = rank.floor() as usize;
    let hi = rank.ceil() as usize;
    if lo == hi {
        sorted_ms[lo]
    } else {
        let frac = rank - lo as f64;
        sorted_ms[lo] * (1.0 - frac) + sorted_ms[hi] * frac
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 5 {
        eprintln!(
            "usage: {} <corpus_f32.bin> <queries_f32.bin> <dim> <top_k> [warmup] [repeats]",
            args[0]
        );
        std::process::exit(2);
    }
    let corpus_path = Path::new(&args[1]);
    let queries_path = Path::new(&args[2]);
    let dim: usize = args[3].parse().expect("dim must be a positive integer");
    let top_k: usize = args[4].parse().expect("top_k must be a positive integer");
    let warmup: usize = args.get(5).and_then(|s| s.parse().ok()).unwrap_or(50);
    let repeats: usize = args.get(6).and_then(|s| s.parse().ok()).unwrap_or(5);

    eprintln!("loading corpus {corpus_path:?} (dim={dim}) ...");
    let corpus_f32 = load_f32_matrix(corpus_path, dim).expect("load corpus");
    let queries_f32 = load_f32_matrix(queries_path, dim).expect("load queries");
    eprintln!(
        "corpus={} queries={} dim={dim}",
        corpus_f32.len(),
        queries_f32.len()
    );

    // Build the segment: quantize corpus to int8, write, mmap-open.
    let ids: Vec<u32> = (0..corpus_f32.len() as u32).collect();
    let corpus_i8: Vec<Vec<i8>> = corpus_f32.iter().map(|v| quantize_i8(v)).collect();
    let seg_path = std::env::temp_dir().join("mneme_p1_bench.msegp1");
    write_segment(&seg_path, dim, &ids, &corpus_i8).expect("write segment");
    let seg = Segment::open(&seg_path).expect("open segment");
    eprintln!(
        "segment built: {} slots, {} bytes on disk",
        seg.count(),
        std::fs::metadata(&seg_path).map(|m| m.len()).unwrap_or(0)
    );

    let queries_i8: Vec<Vec<i8>> = queries_f32.iter().map(|v| quantize_i8(v)).collect();

    // Warmup: page in the mmap + warm rayon pool + CPU caches.
    for q in queries_i8.iter().take(warmup.min(queries_i8.len())) {
        let _ = seg.brute_scan(q, top_k).unwrap();
    }

    // Timed: per-query latency, `repeats` passes over all queries, keep every sample.
    let mut samples_ms: Vec<f64> = Vec::with_capacity(queries_i8.len() * repeats);
    for _ in 0..repeats {
        for q in &queries_i8 {
            let t = Instant::now();
            let hits = seg.brute_scan(q, top_k).unwrap();
            let dt = t.elapsed().as_secs_f64() * 1000.0;
            std::hint::black_box(&hits);
            samples_ms.push(dt);
        }
    }
    samples_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p50 = percentile(&samples_ms, 50.0);
    let p90 = percentile(&samples_ms, 90.0);
    let mean = samples_ms.iter().sum::<f64>() / samples_ms.len() as f64;

    // Recall@k vs exact f32 oracle (quality sanity — int8 should lose little).
    let mut overlap = 0usize;
    let mut denom = 0usize;
    for (qi, q_f32) in queries_f32.iter().enumerate() {
        let exact: std::collections::HashSet<u32> = exact_topk_f32(&corpus_f32, q_f32, top_k)
            .into_iter()
            .collect();
        let approx: Vec<u32> = seg
            .brute_scan(&queries_i8[qi], top_k)
            .unwrap()
            .into_iter()
            .map(|h| h.slot_id)
            .collect();
        overlap += approx.iter().filter(|id| exact.contains(id)).count();
        denom += top_k;
    }
    let recall = overlap as f64 / denom as f64;

    // Machine-readable lines (consumed by the bench wrapper -> RESULTS.md).
    println!("mneme_scan_p50_ms={p50:.4}");
    println!("mneme_scan_p90_ms={p90:.4}");
    println!("mneme_scan_mean_ms={mean:.4}");
    println!("mneme_recall_at_k={recall:.4}");
    println!("mneme_n_corpus={}", corpus_f32.len());
    println!("mneme_n_query={}", queries_f32.len());
    println!("mneme_dim={dim}");
    println!("mneme_top_k={top_k}");

    let _ = std::fs::remove_file(&seg_path);
}
