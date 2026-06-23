//! solvis-demo — end-to-end recall over real documents using the `.mseg` engine.
//!
//! Ingests the chunks produced by `bench/ingest_solvis.py` into a `solvis` `.mseg` shard
//! (text + bge-m3 vector per chunk), enables the HNSW overlay, then runs each query through
//! `recall` and prints the top matching document chunks. Proves the engine on real data.
//!
//! Usage:
//!   solvis-demo <solvis_dir> <data_root> <dim> <top_k>
//! where <solvis_dir> contains records.bin, corpus_f32.bin, queries_f32.bin, queries.txt.

use std::io::Read;
use std::path::{Path, PathBuf};

use mseg::{Filter, MemoryInput, Shard};

/// Read length-prefixed (u32 LE len + utf8) records written by ingest_solvis.py.
fn read_records(path: &Path) -> Vec<String> {
    let bytes = std::fs::read(path).expect("read records.bin");
    let mut out = Vec::new();
    let mut i = 0;
    while i + 4 <= bytes.len() {
        let len = u32::from_le_bytes(bytes[i..i + 4].try_into().unwrap()) as usize;
        i += 4;
        let s = String::from_utf8_lossy(&bytes[i..i + len]).into_owned();
        i += len;
        out.push(s);
    }
    out
}

fn read_f32(path: &Path, dim: usize) -> Vec<Vec<f32>> {
    let bytes = std::fs::read(path).expect("read f32 bin");
    bytes
        .chunks_exact(dim * 4)
        .map(|r| {
            r.chunks_exact(4)
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .collect()
        })
        .collect()
}

fn read_lines(path: &Path) -> Vec<String> {
    let mut s = String::new();
    if let Ok(mut f) = std::fs::File::open(path) {
        let _ = f.read_to_string(&mut s);
    }
    s.lines().map(|l| l.to_string()).collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 5 {
        eprintln!("usage: {} <solvis_dir> <data_root> <dim> <top_k>", args[0]);
        std::process::exit(2);
    }
    let dir = PathBuf::from(&args[1]);
    let data_root = PathBuf::from(&args[2]);
    let dim: usize = args[3].parse().expect("dim");
    let top_k: usize = args[4].parse().expect("top_k");

    let records = read_records(&dir.join("records.bin"));
    let corpus = read_f32(&dir.join("corpus_f32.bin"), dim);
    assert_eq!(records.len(), corpus.len(), "records/vectors misaligned");
    println!(
        "ingesting {} chunks into .mseg shard 'solvis' ...",
        records.len()
    );

    // fresh shard each run
    let _ = std::fs::remove_dir_all(data_root.join("solvis"));
    let mut shard = Shard::open(&data_root, "solvis", dim).expect("open shard");
    let t0 = std::time::Instant::now();
    for (text, vec) in records.iter().zip(corpus.iter()) {
        shard
            .segment()
            .insert(MemoryInput::new(text.clone(), vec.clone()))
            .expect("insert");
    }
    shard.segment().enable_hnsw().expect("enable hnsw");
    shard.segment().index_drain();
    shard.segment().flush().expect("flush");
    println!(
        "ingested {} chunks in {:.2}s, HNSW indexed {} vectors\n",
        records.len(),
        t0.elapsed().as_secs_f64(),
        shard.segment().hnsw_len()
    );

    let q_path = dir.join("queries_f32.bin");
    if !q_path.exists() {
        println!("(no queries_f32.bin — ingest with --query to test recall)");
        return;
    }
    let queries = read_f32(&q_path, dim);
    let q_texts = read_lines(&dir.join("queries.txt"));

    // Retrieve a WIDE candidate pool per query, then FUSE vector + lexical signals (RRF) and
    // apply MMR diversity — all local, sub-ms, no model. This is the fast accuracy layer
    // (parity with HIVEMIND's RRF + MMR, minus the network hops). We also write candidates.bin
    // so the optional hosted cross-encoder rerank can run when credits exist.
    let retrieve_n = top_k.max(30);
    let mut cand_buf: Vec<u8> = Vec::new();
    cand_buf.extend_from_slice(&(queries.len() as u32).to_le_bytes());
    let mut total_ms = 0.0;

    for (qi, qv) in queries.iter().enumerate() {
        let qt = q_texts.get(qi).map(|s| s.as_str()).unwrap_or("<query>");
        let t = std::time::Instant::now();
        let cands = shard
            .segment()
            .recall(qv, &Filter::default(), retrieve_n)
            .expect("recall");
        // fast hybrid fusion + MMR over the candidate pool (uses corpus vectors for MMR sim).
        let cand_vecs: Vec<&Vec<f32>> = cands.iter().map(|h| &corpus[h.slot_id as usize]).collect();
        let fused = hybrid_fuse_mmr(qt, &cands, &cand_vecs, top_k);
        let ms = t.elapsed().as_secs_f64() * 1e3;
        total_ms += ms;

        // serialize the wide pool for the optional hosted reranker.
        cand_buf.extend_from_slice(&(cands.len() as u32).to_le_bytes());
        for h in &cands {
            cand_buf.extend_from_slice(&h.score.to_le_bytes());
            let b = h.text.as_bytes();
            cand_buf.extend_from_slice(&(b.len() as u32).to_le_bytes());
            cand_buf.extend_from_slice(b);
        }

        println!("─────────────────────────────────────────────────────────────");
        println!(
            "QUERY: {qt}   (mneme hybrid recall {ms:.2} ms, {} candidates)",
            cands.len()
        );
        for (rank, &ci) in fused.iter().enumerate() {
            println!(
                "  {}. {}",
                rank + 1,
                fmt_hit(cands[ci].score, &cands[ci].text)
            );
        }
        println!();
    }
    std::fs::write(dir.join("candidates.bin"), &cand_buf).expect("write candidates.bin");
    println!(
        "mneme hybrid retrieval: {} queries, mean {:.3} ms/query over {} chunks (HNSW + RRF + MMR, local).",
        queries.len(),
        total_ms / queries.len() as f64,
        records.len()
    );
    println!("wrote candidates.bin (optional hosted rerank: bench/rerank_solvis.py).");
}

/// Lowercase alphanumeric tokens (unicode-aware: keeps umlauts), length >= 2.
fn tokenize(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.chars().count() >= 2)
        .map(|t| t.to_lowercase())
        .collect()
}

/// Hybrid fusion (RRF of vector rank + lexical-overlap rank) followed by MMR diversity.
/// Returns indices into `cands` for the top `top_k`. Pure-local, sub-ms over a small pool.
fn hybrid_fuse_mmr(
    query: &str,
    cands: &[mseg::Hit],
    cand_vecs: &[&Vec<f32>],
    top_k: usize,
) -> Vec<usize> {
    let n = cands.len();
    if n == 0 {
        return Vec::new();
    }
    let q_tokens: std::collections::HashSet<String> = tokenize(query).into_iter().collect();

    // lexical score: fraction of query tokens present in the record (source + text), with the
    // filename matched at a small premium (a doc titled with the query terms is a strong signal).
    let lex: Vec<f32> = cands
        .iter()
        .map(|h| {
            if q_tokens.is_empty() {
                return 0.0;
            }
            let doc: std::collections::HashSet<String> = tokenize(&h.text).into_iter().collect();
            let hits = q_tokens.iter().filter(|t| doc.contains(*t)).count();
            hits as f32 / q_tokens.len() as f32
        })
        .collect();

    // ranks (0 = best) for vector score and lexical score.
    let vec_rank = rank_desc(&cands.iter().map(|h| h.score).collect::<Vec<_>>());
    let lex_rank = rank_desc(&lex);
    const RRF_K: f32 = 60.0;
    let fused: Vec<f32> = (0..n)
        .map(|i| 1.0 / (RRF_K + vec_rank[i] as f32) + 1.0 / (RRF_K + lex_rank[i] as f32))
        .collect();

    // MMR: greedily pick maximizing fused - λ·max cosine to already-selected (drops near-dupes).
    let lambda = 0.5f32;
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| fused[b].partial_cmp(&fused[a]).unwrap());
    let mut selected: Vec<usize> = Vec::new();
    let mut remaining: Vec<usize> = order;
    while selected.len() < top_k.min(n) && !remaining.is_empty() {
        let mut best_pos = 0;
        let mut best_score = f32::NEG_INFINITY;
        for (pos, &ci) in remaining.iter().enumerate() {
            let max_sim = selected
                .iter()
                .map(|&sj| cosine(cand_vecs[ci], cand_vecs[sj]))
                .fold(0.0f32, f32::max);
            let mmr = fused[ci] - lambda * max_sim * 0.05; // fused is small-scale; scale sim down
            if mmr > best_score {
                best_score = mmr;
                best_pos = pos;
            }
        }
        selected.push(remaining.remove(best_pos));
    }
    selected
}

/// Dense ranks (0 = highest value). Ties broken by original order.
fn rank_desc(scores: &[f32]) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..scores.len()).collect();
    idx.sort_by(|&a, &b| scores[b].partial_cmp(&scores[a]).unwrap().then(a.cmp(&b)));
    let mut rank = vec![0usize; scores.len()];
    for (r, &i) in idx.iter().enumerate() {
        rank[i] = r;
    }
    rank
}

/// Cosine similarity of two equal-length vectors.
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let na: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na * nb)
    }
}

/// Format one hit line: "score=… [source#idx] snippet".
fn fmt_hit(score: f32, record: &str) -> String {
    let mut parts = record.splitn(3, '\t');
    let source = parts.next().unwrap_or("?");
    let cidx = parts.next().unwrap_or("?");
    let snippet: String = parts
        .next()
        .unwrap_or("")
        .chars()
        .take(160)
        .collect::<String>()
        .replace('\n', " ");
    format!("score={score:.3}  [{source}#{cidx}]  {}", snippet.trim())
}
