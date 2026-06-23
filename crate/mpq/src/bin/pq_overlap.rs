//! P4 gate measurement: PQ recall@10 overlap vs exact float32 ground truth on the real bge-m3
//! 10k corpus, using the **production PQ pattern** — fast ADC scan over compact 128-byte codes
//! to retrieve a wide candidate pool, then exact-f32 rescore of that pool to the final top-10.
//! This is exactly how Qdrant (our baseline) uses quantization (`quant scan + rescore with
//! originals`) and how faiss uses IVF-PQ + rerank; pure-PQ-without-rescore is not how PQ is
//! deployed. The codebook is the production M=128/K=256 (128-byte code, 32× over the 4096-byte
//! float32). We also report the pure-ADC@10 number for transparency.
//!
//! Usage: pq-overlap <corpus_f32.bin> <queries_f32.bin> <dim> [rescore_pool]
//! Prints: pq_recall10_overlap_pct=<f>  pq_pure_adc_recall10_pct=<f>

use std::path::Path;

use mpq::PqCodebook;

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
        eprintln!("usage: {} <corpus> <queries> <dim>", args[0]);
        std::process::exit(2);
    }
    let dim: usize = args[3].parse().expect("dim");
    let pool: usize = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(100);
    let corpus = load_f32(Path::new(&args[1]), dim);
    let queries = load_f32(Path::new(&args[2]), dim);
    eprintln!(
        "corpus={} queries={} dim={dim} rescore_pool={pool}; training PQ M=128 K=256...",
        corpus.len(),
        queries.len()
    );

    let cb = PqCodebook::train(&corpus, 128, 256, 2026);
    let codes: Vec<Vec<u8>> = corpus.iter().map(|v| cb.encode(v)).collect();
    eprintln!("encoded {} vectors to 128-byte codes (32x)", codes.len());

    let k = 10;
    let mut rescored_overlap = 0usize;
    let mut pure_overlap = 0usize;
    for q in &queries {
        // exact float32 cosine top-k (ground truth)
        let cos = |v: &[f32]| q.iter().zip(v).map(|(a, b)| a * b).sum::<f32>();
        let mut exact: Vec<(f32, usize)> = corpus
            .iter()
            .enumerate()
            .map(|(i, v)| (cos(v), i))
            .collect();
        exact.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
        let exact_set: std::collections::HashSet<usize> =
            exact.iter().take(k).map(|(_, i)| *i).collect();

        // ADC ranking over compact codes (ascending sq-L2 == descending cosine for unit vectors)
        let table = cb.adc_table(q);
        let mut adc: Vec<(f32, usize)> = codes
            .iter()
            .enumerate()
            .map(|(i, c)| (table.distance(c), i))
            .collect();
        adc.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());

        // pure ADC@10 (transparency)
        pure_overlap += adc
            .iter()
            .take(k)
            .filter(|(_, i)| exact_set.contains(i))
            .count();

        // production pattern: take the ADC top-`pool`, rescore by EXACT cosine, keep top-k.
        let mut pool_v: Vec<(f32, usize)> = adc
            .iter()
            .take(pool)
            .map(|&(_, i)| (cos(&corpus[i]), i))
            .collect();
        pool_v.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
        rescored_overlap += pool_v
            .iter()
            .take(k)
            .filter(|(_, i)| exact_set.contains(i))
            .count();
    }
    let denom = (queries.len() * k) as f64;
    println!(
        "pq_recall10_overlap_pct={:.4}",
        100.0 * rescored_overlap as f64 / denom
    );
    println!(
        "pq_pure_adc_recall10_pct={:.4}",
        100.0 * pure_overlap as f64 / denom
    );
    println!("pq_rescore_pool={pool}");
    println!("pq_n_corpus={}", corpus.len());
    println!("pq_dim={dim}");
}
