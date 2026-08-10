// T1-5 — real parameter sweep for the HNSW `ef` floor and `MNEME_RERANK_DEPTH`, measured
// against a brute-force ground truth (not assumed), at real corpus sizes. Existence and result
// table referenced by `ef_floor()`'s doc comment in `crud.rs` — run this before changing that
// function's tiering, and update both when the numbers change.
//
// Usage: cargo run --release --example ef_sweep -p mseg -- <corpus.bin> <queries.bin> <dim> <k>
use mseg::{Filter, MemoryInput, Shard};
use std::env;
use std::fs;
use std::path::Path;
use std::time::Instant;

fn load_f32(path: &str, dim: usize) -> Vec<Vec<f32>> {
    let bytes = fs::read(path).expect("read");
    let n = bytes.len() / 4 / dim;
    let mut out = Vec::with_capacity(n);
    for r in 0..n {
        let mut v = vec![0f32; dim];
        for (c, slot) in v.iter_mut().enumerate() {
            let o = (r * dim + c) * 4;
            *slot = f32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
        }
        out.push(v);
    }
    out
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let corpus_path = &args[1];
    let queries_path = &args[2];
    let dim: usize = args[3].parse().unwrap();
    let k: usize = args[4].parse().unwrap();

    let corpus = load_f32(corpus_path, dim);
    let queries = load_f32(queries_path, dim);
    eprintln!("corpus={} queries={} dim={} k={}", corpus.len(), queries.len(), dim, k);

    // Ground truth: exact brute-force top-k per query, computed once.
    eprintln!("computing exact ground truth...");
    let ground_truth: Vec<Vec<usize>> = queries
        .iter()
        .map(|q| {
            let mut scored: Vec<(f32, usize)> =
                corpus.iter().enumerate().map(|(i, v)| (dot(q, v), i)).collect();
            scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
            scored.truncate(k);
            scored.into_iter().map(|(_, i)| i).collect()
        })
        .collect();

    let root = Path::new("/tmp/mseg-ef-sweep");
    // usearch's own internal search-expansion (MNEME_HNSW_EFS, default 400) is a SEPARATE,
    // index-build-time knob from crud.rs's query-time `ef` — swept first because the first pass
    // (fixed EFS=400) showed flat latency across the full ef/rerank grid, meaning EFS -- not
    // crud.rs's own parameters -- is almost certainly the real fixed cost at 10k.
    let efs_grid = [16usize, 40];
    let ef_grid = [64usize];
    let rerank_grid = [1usize, 4, 16, 64];

    println!("hnsw_efs,ef_floor,rerank_depth,recall_at_k,query_p50_us,query_p99_us");
    for &efs in &efs_grid {
        for &ef in &ef_grid {
        for &rerank in &rerank_grid {
            let _ = fs::remove_dir_all(root);
            fs::create_dir_all(root).unwrap();
            let mut shard = Shard::open(root, "sweep", dim).expect("open");
            for (i, v) in corpus.iter().enumerate() {
                let mut m = MemoryInput::new(i.to_string(), v.clone());
                m.valid_from = 0;
                shard.segment().insert(m).expect("insert");
            }
            // SAFETY: single-process sweep, sequential runs — env vars read once per call.
            // MNEME_HNSW_EFS must be set BEFORE enable_hnsw() (index-build-time), the others
            // are read per-recall-call (query-time) so order relative to enable_hnsw doesn't
            // matter for them.
            env::set_var("MNEME_HNSW_EFS", efs.to_string());
            env::set_var("MNEME_EF_FLOOR", ef.to_string());
            env::set_var("MNEME_RERANK_DEPTH", rerank.to_string());
            shard.segment().enable_hnsw().expect("hnsw");

            let mut overlap = 0usize;
            let mut latencies_us: Vec<f64> = Vec::with_capacity(queries.len());
            for (qi, q) in queries.iter().enumerate() {
                let t = Instant::now();
                let hits = shard.segment().recall(q, &Filter::default(), k).expect("recall");
                latencies_us.push(t.elapsed().as_secs_f64() * 1_000_000.0);
                let got: std::collections::HashSet<usize> =
                    hits.iter().map(|h| h.slot_id as usize).collect();
                for &gt_idx in &ground_truth[qi] {
                    if got.contains(&gt_idx) {
                        overlap += 1;
                    }
                }
            }
            latencies_us.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let p50 = latencies_us[latencies_us.len() / 2];
            let p99 = latencies_us[((latencies_us.len() as f64 * 0.99) as usize).min(latencies_us.len() - 1)];
            let recall = overlap as f64 / (queries.len() * k) as f64;
            println!("{efs},{ef},{rerank},{recall:.4},{p50:.2},{p99:.2}");
        }
        }
    }
}
