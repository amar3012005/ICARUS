//! Real-corpus scale bench: load a REAL pre-embedded corpus (no perturbation), build the shard,
//! measure recall@10 query latency p50/p99 + on-disk storage. Honours MNEME_HNSW_QUANT (f32|i8).
//! Usage: bench-real <corpus_f32.bin> <queries_f32.bin> <dim> <n> [k]

use std::time::Instant;

use mseg::{Filter, MemoryInput, Segment};

fn load(path: &std::path::Path, dim: usize, max: usize) -> Vec<Vec<f32>> {
    let bytes = std::fs::read(path).expect("read");
    let n = (bytes.len() / 4 / dim).min(max);
    let mut out = Vec::with_capacity(n);
    for r in 0..n {
        let mut v = Vec::with_capacity(dim);
        for c in 0..dim {
            let o = (r * dim + c) * 4;
            v.push(f32::from_le_bytes([
                bytes[o],
                bytes[o + 1],
                bytes[o + 2],
                bytes[o + 3],
            ]));
        }
        out.push(v);
    }
    out
}
fn pct(s: &[f64], p: f64) -> f64 {
    let r = (p / 100.0) * ((s.len() - 1) as f64);
    let (lo, hi) = (r.floor() as usize, r.ceil() as usize);
    if lo == hi {
        s[lo]
    } else {
        s[lo] * (1.0 - (r - lo as f64)) + s[hi] * (r - lo as f64)
    }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let dim: usize = a[3].parse().unwrap();
    let n: usize = a[4].parse().unwrap();
    let k: usize = a.get(5).and_then(|s| s.parse().ok()).unwrap_or(10);

    let corpus = load(std::path::Path::new(&a[1]), dim, n);
    let queries = load(std::path::Path::new(&a[2]), dim, 1000);
    eprintln!(
        "loaded corpus={} queries={} dim={}",
        corpus.len(),
        queries.len(),
        dim
    );

    let tmp = std::env::temp_dir().join(format!("mneme_real_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let mut seg = Segment::create(&tmp, "r", dim).expect("create");

    let t0 = Instant::now();
    for v in &corpus {
        seg.insert(MemoryInput::new(String::new(), v.clone()))
            .expect("insert");
    }
    eprintln!(
        "inserted {} in {:.1}s",
        corpus.len(),
        t0.elapsed().as_secs_f64()
    );
    let ti = Instant::now();
    seg.enable_hnsw().expect("hnsw");
    seg.index_drain();
    eprintln!("HNSW built in {:.1}s", ti.elapsed().as_secs_f64());

    // on-disk storage — Segment::create writes <tmp>/r.amr, r.vec, r.txt, r.edg directly in tmp.
    let bytes: u64 = std::fs::read_dir(&tmp)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.metadata().map(|m| m.len()).unwrap_or(0))
        .sum();
    let quant = std::env::var("MNEME_HNSW_QUANT").unwrap_or_else(|_| "f32".into());
    println!("real_n={n}");
    println!("real_dim={dim}");
    println!("real_hnsw_quant={quant}");
    println!("real_shard_mb={:.1}", bytes as f64 / 1e6);
    println!("real_bytes_per_vec={}", bytes / corpus.len() as u64);

    // sweep rerank depth on the SAME built shard (recall reads MNEME_RERANK_DEPTH per call) so one
    // 32-min build yields the whole latency-vs-depth curve.
    let filter = Filter::default();
    let depths: Vec<usize> = std::env::var("MNEME_DEPTH_SWEEP")
        .unwrap_or_else(|_| "1000000,64,32,16,10".into())
        .split(',')
        .filter_map(|s| s.parse().ok())
        .collect();
    // depth=full (first) reranks all candidates → its top-k is the reference; later depths' overlap
    // vs it = the recall cost of capping (scale-correct, no slow exact brute-force GT).
    let mut reference: Vec<Vec<u32>> = Vec::new();
    for (di, depth) in depths.iter().enumerate() {
        std::env::set_var("MNEME_RERANK_DEPTH", depth.to_string());
        for q in queries.iter().take(50) {
            let _ = seg.recall(q, &filter, k).unwrap(); // warm
        }
        let mut lat = Vec::new();
        let mut topk: Vec<Vec<u32>> = Vec::with_capacity(queries.len());
        for _ in 0..5 {
            for q in &queries {
                let t = Instant::now();
                let h = seg.recall(q, &filter, k).unwrap();
                lat.push(t.elapsed().as_secs_f64() * 1e3);
                std::hint::black_box(&h);
            }
        }
        for q in &queries {
            topk.push(
                seg.recall(q, &filter, k)
                    .unwrap()
                    .iter()
                    .map(|h| h.slot_id)
                    .collect(),
            );
        }
        lat.sort_by(|x, y| x.partial_cmp(y).unwrap());
        let recall = if di == 0 {
            reference = topk;
            1.0
        } else {
            let mut hit = 0usize;
            let mut tot = 0usize;
            for (r, t) in reference.iter().zip(topk.iter()) {
                let rs: std::collections::HashSet<u32> = r.iter().copied().collect();
                hit += t.iter().filter(|id| rs.contains(id)).count();
                tot += r.len();
            }
            hit as f64 / tot as f64
        };
        println!(
            "depth={depth}\tp50={:.3}ms\tp90={:.3}ms\tp99={:.3}ms\trecall_vs_full={recall:.4}",
            pct(&lat, 50.0),
            pct(&lat, 90.0),
            pct(&lat, 99.0)
        );
    }
    let _ = std::fs::remove_dir_all(&tmp);
}
