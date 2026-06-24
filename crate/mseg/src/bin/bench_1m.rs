//! mneme P3 1M-scale recall@10 latency benchmark (the headline P3 number: < 5 ms @ 1M).
//!
//! Dataset (documented in bench/RESULTS.md): a real bge-m3 base of `n_real` vectors is fanned
//! out to `target_n` by deterministic small-noise perturbation of real vectors, then renorm.
//! This is the SCALE-test corpus — recall@10 *latency* at 1M is governed by the HNSW graph
//! size and traversal, not by whether each vector is a unique real memory, so the augmented
//! 1M faithfully measures the latency gate. (Quality loss vs Qdrant float32 is measured
//! separately on the 100%-real 10k by bench/quality_vs_qdrant.py — that is where realism
//! matters, and every vector there is real.)
//!
//! Usage: bench-1m <corpus_f32.bin> <queries_f32.bin> <dim> <target_n> [top_k]
//! Prints: recall10_p50_ms=<f>  recall10_p90_ms=<f>  mneme_1m_n=<n>  ...

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

/// Deterministic perturbed copy of `base`: add small index-seeded noise, renormalize.
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

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 5 {
        eprintln!(
            "usage: {} <corpus> <queries> <dim> <target_n> [top_k]",
            args[0]
        );
        std::process::exit(2);
    }
    let dim: usize = args[3].parse().expect("dim");
    let target_n: usize = args[4].parse().expect("target_n");
    let top_k: usize = args.get(5).and_then(|s| s.parse().ok()).unwrap_or(10);

    let real = load_f32(Path::new(&args[1]), dim);
    let queries = load_f32(Path::new(&args[2]), dim);
    let n_real = real.len();
    eprintln!("real base={n_real}, target_n={target_n}, dim={dim}, building segment...");

    let tmp = std::env::temp_dir().join("mneme_1m_bench");
    let _ = std::fs::remove_dir_all(&tmp);
    let mut seg = Segment::create(&tmp, "m1", dim).expect("create");

    let t_ins = Instant::now();
    for i in 0..target_n {
        // first n_real are the real vectors verbatim; the rest are perturbed real vectors.
        let v = if i < n_real {
            real[i].clone()
        } else {
            perturb(&real[i % n_real], i as u64)
        };
        // empty text → no .txt write (bounds RAM/disk at 1M); vectors are what we benchmark.
        // populate adjacency with 8 deterministic neighbours so the 2-hop BFS has a graph to
        // traverse (the BFS latency depends on the fan-out count, not which neighbours).
        let mut mem = MemoryInput::new(String::new(), v);
        for (a, slot) in mem.adjacency.iter_mut().enumerate() {
            *slot = ((i + a + 1) % target_n) as u32;
        }
        mem.valid_from = i as i64; // give each slot a distinct valid_from for temporal filtering
        seg.insert(mem).expect("insert");
        if (i + 1) % 100_000 == 0 {
            eprintln!("  inserted {}/{target_n}", i + 1);
        }
    }
    eprintln!(
        "inserted {target_n} in {:.1}s; building HNSW...",
        t_ins.elapsed().as_secs_f64()
    );
    let t_idx = Instant::now();
    seg.enable_hnsw().expect("enable hnsw");
    seg.index_drain();
    eprintln!(
        "HNSW built ({} vectors) in {:.1}s",
        seg.hnsw_len(),
        t_idx.elapsed().as_secs_f64()
    );

    // warmup + timed recall@top_k over the real queries.
    let filter = Filter::default();
    for q in queries.iter().take(50) {
        let _ = seg.recall(q, &filter, top_k).expect("recall");
    }
    let mut samples: Vec<f64> = Vec::new();
    for _ in 0..5 {
        for q in &queries {
            let t = Instant::now();
            let hits = seg.recall(q, &filter, top_k).expect("recall");
            std::hint::black_box(&hits);
            samples.push(t.elapsed().as_secs_f64() * 1e3);
        }
    }
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p50 = percentile(&samples, 50.0);
    let p90 = percentile(&samples, 90.0);

    // P5: bi-temporal filter + 2-hop adjacency BFS, all from the one mmap.
    let bitemporal = Filter {
        valid_from_range: Some((0, target_n as i64)),
        ..Default::default()
    };
    for q in queries.iter().take(50) {
        let _ = seg
            .recall_with_hops(q, &bitemporal, top_k, 2)
            .expect("hops");
    }
    let mut bt: Vec<f64> = Vec::new();
    for _ in 0..5 {
        for q in &queries {
            let t = Instant::now();
            let hits = seg
                .recall_with_hops(q, &bitemporal, top_k, 2)
                .expect("hops");
            std::hint::black_box(&hits);
            bt.push(t.elapsed().as_secs_f64() * 1e3);
        }
    }
    bt.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let bt_p50 = percentile(&bt, 50.0);

    println!("recall10_p50_ms={p50:.4}");
    println!("recall10_p90_ms={p90:.4}");
    println!("bitemporal_2hop_p50_ms={bt_p50:.4}");
    println!("mneme_1m_n={}", seg.hnsw_len());
    println!("mneme_1m_dim={dim}");
    println!("mneme_1m_top_k={top_k}");

    let _ = std::fs::remove_dir_all(&tmp);
}
