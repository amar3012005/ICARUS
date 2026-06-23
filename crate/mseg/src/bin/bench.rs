//! mneme P2 baseline benchmark.
//!
//! Loads the real bge-m3 corpus from P1, inserts every memory into a fresh `.mseg` segment,
//! then runs exact brute-force recall@10 over the 200 queries. Reports insert + recall p50.
//! This is the P2 production-CRUD baseline (no HNSW yet — that is P3).
//!
//! Usage: mseg-bench <corpus_f32.bin> <queries_f32.bin> <dim> <top_k>
//!
//! Prints machine-readable lines:
//!   mseg_insert_p50_us=<f>   mseg_insert_mean_us=<f>
//!   mseg_recall_p50_ms=<f>   mseg_recall_p90_ms=<f>
//!   mseg_n_corpus=<n>        mseg_dim=<d>

use std::path::Path;
use std::time::Instant;

use mseg::{Filter, MemoryInput, Segment};

fn load_f32_matrix(path: &Path, dim: usize) -> Vec<Vec<f32>> {
    let bytes = std::fs::read(path).expect("read matrix");
    let row = dim * 4;
    assert!(bytes.len() % row == 0, "matrix not a multiple of row size");
    bytes
        .chunks_exact(row)
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

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 5 {
        eprintln!("usage: {} <corpus> <queries> <dim> <top_k>", args[0]);
        std::process::exit(2);
    }
    let dim: usize = args[3].parse().expect("dim");
    let top_k: usize = args[4].parse().expect("top_k");
    let corpus = load_f32_matrix(Path::new(&args[1]), dim);
    let queries = load_f32_matrix(Path::new(&args[2]), dim);
    eprintln!(
        "corpus={} queries={} dim={dim}",
        corpus.len(),
        queries.len()
    );

    let tmp = tempfile_dir();
    let mut seg = Segment::create(&tmp, "bench", dim).expect("create segment");

    // insert all, timing each (text is a short placeholder — the corpus file is vectors only;
    // insert latency is dominated by the slot/vector write + LZ4, not text content).
    let mut ins_us: Vec<f64> = Vec::with_capacity(corpus.len());
    for (i, v) in corpus.iter().enumerate() {
        let m = MemoryInput::new(format!("memory {i}"), v.clone());
        let t = Instant::now();
        seg.insert(m).expect("insert");
        ins_us.push(t.elapsed().as_secs_f64() * 1e6);
    }
    seg.flush().expect("flush");
    ins_us.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let ins_p50 = percentile(&ins_us, 50.0);
    let ins_mean = ins_us.iter().sum::<f64>() / ins_us.len() as f64;

    // recall@k over all queries, a few passes for a stable p50.
    let mut rec_ms: Vec<f64> = Vec::new();
    let filter = Filter::default();
    for _ in 0..3 {
        for q in &queries {
            let t = Instant::now();
            let hits = seg.recall(q, &filter, top_k).expect("recall");
            std::hint::black_box(&hits);
            rec_ms.push(t.elapsed().as_secs_f64() * 1e3);
        }
    }
    rec_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let rec_p50 = percentile(&rec_ms, 50.0);
    let rec_p90 = percentile(&rec_ms, 90.0);

    // Write-path isolation (SPEC §6.1/§6.2): enabling HNSW seeds the whole corpus into the
    // background indexer's queue — a "rebuild in progress". We then time fresh inserts while
    // that rebuild churns. Insert = durable append + a non-blocking channel send, so its p99
    // must stay bounded regardless of the indexer backlog (the kill-condition guard).
    seg.enable_hnsw().expect("enable hnsw"); // enqueues `corpus.len()` adds = rebuild backlog
    let mut iso_us: Vec<f64> = Vec::with_capacity(corpus.len());
    for (i, v) in corpus.iter().enumerate() {
        let m = MemoryInput::new(format!("concurrent {i}"), v.clone());
        let t = Instant::now();
        seg.insert(m).expect("insert under rebuild");
        iso_us.push(t.elapsed().as_secs_f64() * 1e6);
    }
    iso_us.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let iso_p99 = percentile(&iso_us, 99.0);
    seg.index_drain(); // let the background indexer finish before teardown

    println!("mseg_insert_p50_us={ins_p50:.4}");
    println!("mseg_insert_mean_us={ins_mean:.4}");
    println!("mseg_recall_p50_ms={rec_p50:.4}");
    println!("mseg_recall_p90_ms={rec_p90:.4}");
    println!("append_p99_under_concurrent_rebuild={iso_p99:.4}");
    println!("mseg_n_corpus={}", corpus.len());
    println!("mseg_dim={dim}");
    println!("mseg_top_k={top_k}");

    let _ = std::fs::remove_dir_all(&tmp);
}

/// A unique temp directory for the bench segment (avoids clobbering across runs).
fn tempfile_dir() -> std::path::PathBuf {
    let base = std::env::temp_dir().join("mneme_p2_bench");
    let _ = std::fs::create_dir_all(&base);
    base
}
