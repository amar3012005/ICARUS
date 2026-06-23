//! mneme recall@10 quality on the 100%-real bge-m3 10k corpus: HNSW (int8 + exact f32 rerank)
//! vs the exact float32 brute-force ground truth. Prints `mneme_recall10` = mean overlap.
//! Pair with bench/quality_vs_qdrant.py (Qdrant float32 recall@10) to get the P3 quality-loss.
//!
//! Usage: quality <corpus_f32.bin> <queries_f32.bin> <dim> [top_k]

use std::path::Path;

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

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("usage: {} <corpus> <queries> <dim> [top_k]", args[0]);
        std::process::exit(2);
    }
    let dim: usize = args[3].parse().expect("dim");
    let k: usize = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(10);
    let corpus = load_f32(Path::new(&args[1]), dim);
    let queries = load_f32(Path::new(&args[2]), dim);

    let tmp = std::env::temp_dir().join("mneme_quality");
    let _ = std::fs::remove_dir_all(&tmp);
    let mut seg = Segment::create(&tmp, "q", dim).expect("create");
    for v in &corpus {
        seg.insert(MemoryInput::new(String::new(), v.clone()))
            .expect("insert");
    }
    seg.enable_hnsw().expect("hnsw");
    seg.index_drain();

    let filter = Filter::default();
    let mut overlap = 0usize;
    let mut denom = 0usize;
    for q in &queries {
        // exact float32 ground truth = the brute-force scan; HNSW result = recall().
        let exact: std::collections::HashSet<u32> = seg
            .recall_brute(q, &filter, k)
            .expect("brute")
            .iter()
            .map(|h| h.slot_id)
            .collect();
        let got = seg.recall(q, &filter, k).expect("recall");
        overlap += got.iter().filter(|h| exact.contains(&h.slot_id)).count();
        denom += k;
    }
    let recall = overlap as f64 / denom as f64;
    println!("mneme_recall10={recall:.4}");
    println!("mneme_quality_n={}", corpus.len());
    let _ = std::fs::remove_dir_all(&tmp);
}
