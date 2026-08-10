// Sanity check for the T1-5 fix: with ZERO env overrides (the real default path any caller
// hits), confirm recall@10 is still 1.0000 at 10k — not just that latency dropped.
use mseg::{Filter, MemoryInput, Shard};
use std::env;
use std::fs;
use std::path::Path;

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
    let corpus = load_f32(&args[1], args[3].parse().unwrap());
    let queries = load_f32(&args[2], args[3].parse().unwrap());
    let k: usize = args[4].parse().unwrap();

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

    let root = Path::new("/tmp/mseg-verify-default");
    let _ = fs::remove_dir_all(root);
    fs::create_dir_all(root).unwrap();
    let mut shard = Shard::open(root, "verify", args[3].parse().unwrap()).expect("open");
    for (i, v) in corpus.iter().enumerate() {
        let mut m = MemoryInput::new(i.to_string(), v.clone());
        m.valid_from = 0;
        shard.segment().insert(m).expect("insert");
    }
    shard.segment().enable_hnsw().expect("hnsw"); // zero env overrides — real default path

    let mut overlap = 0usize;
    for (qi, q) in queries.iter().enumerate() {
        let hits = shard.segment().recall(q, &Filter::default(), k).expect("recall");
        let got: std::collections::HashSet<usize> = hits.iter().map(|h| h.slot_id as usize).collect();
        for &gt in &ground_truth[qi] {
            if got.contains(&gt) {
                overlap += 1;
            }
        }
    }
    let recall = overlap as f64 / (queries.len() * k) as f64;
    println!("default_recall_at_k={recall:.4} (zero env overrides, n={})", corpus.len());
}
