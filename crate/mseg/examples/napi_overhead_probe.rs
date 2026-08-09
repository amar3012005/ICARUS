// T1-5 diagnostic — measure recall() latency with ZERO napi/FFI boundary, same corpus, same
// params (k=10, enableHnsw) as bench/lancedb/bench_mneme.mjs, to isolate "is the 4.38ms/query
// napi-measured cost the algorithm, or the binding?" This is a measurement, not a fix — it exists
// so T1-5's actual fix targets the real bottleneck instead of guessing.
//
// Usage: cargo run --release --example napi_overhead_probe -- <corpus.bin> <queries.bin> <dim> <k>
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
        for c in 0..dim {
            let o = (r * dim + c) * 4;
            v[c] = f32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
        }
        out.push(v);
    }
    out
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

    let root = Path::new("/tmp/mseg-napi-overhead-probe");
    let _ = fs::remove_dir_all(root);
    fs::create_dir_all(root).unwrap();
    let mut shard = Shard::open(root, "probe", dim).expect("open");

    let t0 = Instant::now();
    for (i, v) in corpus.iter().enumerate() {
        let mut m = MemoryInput::new(i.to_string(), v.clone());
        m.valid_from = 0;
        shard.segment().insert(m).expect("insert");
    }
    eprintln!("ingest_wall_ms={:.3}", t0.elapsed().as_secs_f64() * 1000.0);

    let t1 = Instant::now();
    shard.segment().enable_hnsw().expect("hnsw");
    eprintln!("index_build_ms={:.3}", t1.elapsed().as_secs_f64() * 1000.0);

    let mut latencies_us: Vec<f64> = Vec::with_capacity(queries.len());
    for q in &queries {
        let t = Instant::now();
        let _hits = shard
            .segment()
            .recall(q, &Filter::default(), k)
            .expect("recall");
        latencies_us.push(t.elapsed().as_secs_f64() * 1_000_000.0);
    }
    latencies_us.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p50 = latencies_us[latencies_us.len() / 2];
    let p90 = latencies_us[(latencies_us.len() as f64 * 0.9) as usize];
    let p99 = latencies_us[((latencies_us.len() as f64 * 0.99) as usize).min(latencies_us.len() - 1)];
    println!("native_query_p50_us={:.3}", p50);
    println!("native_query_p90_us={:.3}", p90);
    println!("native_query_p99_us={:.3}", p99);
    println!("native_query_p50_ms={:.4}", p50 / 1000.0);
}
