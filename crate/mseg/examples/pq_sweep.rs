// T1-7 — real recall/latency comparison for the ADC (PQ) recall path vs brute-force ground
// truth AND vs HNSW, on the same real corpus/queries used throughout this session's work.
// Answers: is recall_pq() a genuinely viable no-graph alternative to recall_hnsw(), or just
// "technically works"?
//
// Usage: cargo run --release --example pq_sweep -p mseg -- <corpus.bin> <queries.bin> <dim> <k>
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

fn percentiles(mut xs: Vec<f64>) -> (f64, f64) {
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p50 = xs[xs.len() / 2];
    let p99 = xs[((xs.len() as f64 * 0.99) as usize).min(xs.len() - 1)];
    (p50, p99)
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

    let root = Path::new("/tmp/mseg-pq-sweep");
    let _ = fs::remove_dir_all(root);
    fs::create_dir_all(root).unwrap();
    let mut shard = Shard::open(root, "sweep", dim).expect("open");
    for (i, v) in corpus.iter().enumerate() {
        let mut m = MemoryInput::new(i.to_string(), v.clone());
        m.valid_from = 0;
        shard.segment().insert(m).expect("insert");
    }

    let recall_at = |hits: &[mseg::Hit], gt: &[usize]| -> usize {
        let got: std::collections::HashSet<usize> = hits.iter().map(|h| h.slot_id as usize).collect();
        gt.iter().filter(|i| got.contains(i)).count()
    };

    // --- brute force (baseline correctness + latency floor) ---
    let mut lat_brute = Vec::with_capacity(queries.len());
    let mut overlap_brute = 0usize;
    for (qi, q) in queries.iter().enumerate() {
        let t = Instant::now();
        let hits = shard.segment().recall_brute(q, &Filter::default(), k).expect("recall_brute");
        lat_brute.push(t.elapsed().as_secs_f64() * 1e6);
        overlap_brute += recall_at(&hits, &ground_truth[qi]);
    }
    let (p50_brute, p99_brute) = percentiles(lat_brute);
    let recall_brute = overlap_brute as f64 / (queries.len() * k) as f64;

    // --- HNSW ---
    shard.segment().enable_hnsw().expect("hnsw");
    let mut lat_hnsw = Vec::with_capacity(queries.len());
    let mut overlap_hnsw = 0usize;
    for (qi, q) in queries.iter().enumerate() {
        let t = Instant::now();
        let hits = shard.segment().recall(q, &Filter::default(), k).expect("recall (hnsw enabled)");
        lat_hnsw.push(t.elapsed().as_secs_f64() * 1e6);
        overlap_hnsw += recall_at(&hits, &ground_truth[qi]);
    }
    let (p50_hnsw, p99_hnsw) = percentiles(lat_hnsw);
    let recall_hnsw = overlap_hnsw as f64 / (queries.len() * k) as f64;

    // --- PQ / ADC ---
    let t_train = Instant::now();
    shard.segment().train_pq(42).expect("train_pq");
    let train_ms = t_train.elapsed().as_secs_f64() * 1000.0;
    let rerank_grid = [64usize, 128, 256, 512];
    println!("path,rerank_depth,recall_at_k,query_p50_us,query_p99_us,extra_ms");
    println!("brute,-,{recall_brute:.4},{p50_brute:.2},{p99_brute:.2},0");
    println!("hnsw,default,{recall_hnsw:.4},{p50_hnsw:.2},{p99_hnsw:.2},0");
    for &rerank in &rerank_grid {
        env::set_var("MNEME_PQ_RERANK_DEPTH", rerank.to_string());
        let mut lat_pq = Vec::with_capacity(queries.len());
        let mut overlap_pq = 0usize;
        for (qi, q) in queries.iter().enumerate() {
            let t = Instant::now();
            let hits = shard.segment().recall_pq(q, &Filter::default(), k).expect("recall_pq");
            lat_pq.push(t.elapsed().as_secs_f64() * 1e6);
            overlap_pq += recall_at(&hits, &ground_truth[qi]);
        }
        let (p50_pq, p99_pq) = percentiles(lat_pq);
        let recall_pq = overlap_pq as f64 / (queries.len() * k) as f64;
        println!("pq,{rerank},{recall_pq:.4},{p50_pq:.2},{p99_pq:.2},{train_ms:.1}");
    }
}
