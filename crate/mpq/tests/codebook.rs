//! P4-1 acceptance: PQ train → encode → decode reconstruction + `.mpq` save/load round-trip.

use std::path::PathBuf;

use mpq::{load, save, PqCodebook};
use tempfile::tempdir;

fn load_f32(path: &std::path::Path, dim: usize) -> Vec<Vec<f32>> {
    std::fs::read(path)
        .unwrap()
        .chunks_exact(dim * 4)
        .map(|r| {
            r.chunks_exact(4)
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .collect()
        })
        .collect()
}

fn unit(dim: usize, seed: u64) -> Vec<f32> {
    let mut s = seed | 1;
    let mut v: Vec<f32> = (0..dim)
        .map(|_| {
            s ^= s >> 12;
            s ^= s << 25;
            s ^= s >> 27;
            ((s >> 11) as f64 / (1u64 << 53) as f64) as f32 - 0.5
        })
        .collect();
    let n: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    for x in &mut v {
        *x /= n;
    }
    v
}

fn cos(a: &[f32], b: &[f32]) -> f32 {
    let d: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let na: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    d / (na * nb)
}

#[test]
fn train_encode_decode_is_deterministic_and_bounded() {
    let dim = 64;
    let train: Vec<Vec<f32>> = (0..2000).map(|i| unit(dim, i + 1)).collect();
    let cb1 = PqCodebook::train(&train, 8, 256, 42);
    let cb2 = PqCodebook::train(&train, 8, 256, 42);
    // deterministic: same seed → identical centroids
    assert_eq!(cb1.centroids(), cb2.centroids());

    // encode produces an M-byte code; decode reconstructs with high cosine to the original.
    let mut total_cos = 0.0;
    for v in train.iter().take(200) {
        let code = cb1.encode(v);
        assert_eq!(code.len(), 8);
        let recon = cb1.decode(&code);
        assert_eq!(recon.len(), dim);
        total_cos += cos(v, &recon);
    }
    let mean = total_cos / 200.0;
    assert!(mean > 0.85, "mean reconstruction cosine {mean:.3} too low");
}

#[test]
fn save_load_roundtrip_byte_stable() {
    let dim = 32;
    let train: Vec<Vec<f32>> = (0..600).map(|i| unit(dim, i + 7)).collect();
    let cb = PqCodebook::train(&train, 8, 64, 1);
    let dir = tempdir().unwrap();
    let path = dir.path().join("org.mpq");
    save(&cb, &path, 1_700_000_000_000_000_000).unwrap();

    let loaded = load(&path).unwrap();
    assert_eq!(loaded.params(), cb.params());
    assert_eq!(loaded.centroids(), cb.centroids());
    // encode matches across save/load
    let v = unit(dim, 99999);
    assert_eq!(loaded.encode(&v), cb.encode(&v));
}

#[test]
fn load_rejects_garbage() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("bad.mpq");
    std::fs::write(&path, b"not an mpq file").unwrap();
    assert!(load(&path).is_err());
}

#[test]
fn real_corpus_128x256_32x_compression_reconstructs() {
    // Runs where the real bge-m3 corpus exists. Validates the production M=128/K=256 config:
    // 1024-dim f32 (4096B) → 128-byte code (32×), reconstruction cosine should stay high.
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../bench/data/corpus_f32.bin");
    if !base.exists() {
        eprintln!("skip: real corpus absent");
        return;
    }
    let dim = 1024;
    let corpus = load_f32(&base, dim);
    let train = &corpus[..corpus.len().min(10_000)];
    let cb = PqCodebook::train(train, 128, 256, 2026);
    let mut total = 0.0;
    let n = 500.min(train.len());
    for v in train.iter().take(n) {
        let code = cb.encode(v);
        assert_eq!(
            code.len(),
            128,
            "32x compression: 1024 f32 -> 128 byte code"
        );
        total += cos(v, &cb.decode(&code));
    }
    let mean = total / n as f64 as f32;
    eprintln!("real-corpus PQ reconstruction cosine = {mean:.4}");
    assert!(
        mean > 0.90,
        "real-corpus reconstruction cosine {mean:.3} too low"
    );
}
