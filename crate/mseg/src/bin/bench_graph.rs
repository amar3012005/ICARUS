//! Stage 4.3 — typed-graph traversal latency at scale. Build N memories each with `fanout` typed
//! edges (inline when fanout<=4, else `.edg` overflow), then measure typed 2-hop traversal p50/p99
//! served from the single shard. Gate: p50 < 5 ms at 1M. Latency is non-negotiable.
//!
//! Usage: bench-graph <n> <fanout> [hops] [dim]

use std::time::Instant;

use mseg::{MemoryInput, Segment};
use mseg_format::EDGE_MENTIONS;

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let r = (p / 100.0) * ((sorted.len() - 1) as f64);
    let lo = r.floor() as usize;
    let hi = r.ceil() as usize;
    if lo == hi {
        sorted[lo]
    } else {
        let f = r - lo as f64;
        sorted[lo] * (1.0 - f) + sorted[hi] * f
    }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let n: u32 = a.get(1).and_then(|s| s.parse().ok()).unwrap_or(1_000_000);
    let fanout: u32 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(8);
    let hops: u8 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(2);
    let dim: usize = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(8);

    let tmp = std::env::temp_dir().join("mneme_graph_bench");
    let _ = std::fs::remove_dir_all(&tmp);
    let mut seg = Segment::create(&tmp, "g", dim).expect("create");

    // insert N memories (vectors are irrelevant to traversal; keep them tiny).
    let t0 = Instant::now();
    for i in 0..n {
        let v: Vec<f32> = (0..dim).map(|j| ((i as usize + j) % 7) as f32).collect();
        seg.insert(MemoryInput::new(String::new(), v)).expect("insert");
    }
    eprintln!("inserted {n} in {:.1}s", t0.elapsed().as_secs_f64());

    // each node i -> {i+1, i+2, ... i+fanout} (mod n), all Mentions.
    let t1 = Instant::now();
    // spread targets pseudo-randomly so a 2-hop touches ~fanout^2 DISTINCT slots scattered across
    // the whole 1M region (cache-cold pointer-chase — the real worst case, not a dense local cluster).
    for i in 0..n {
        for k in 1..=fanout {
            let target = i
                .wrapping_mul(2_654_435_761)
                .wrapping_add(k.wrapping_mul(40_503_337))
                % n;
            seg.add_edge(i, target, EDGE_MENTIONS, 1).expect("add_edge");
        }
    }
    eprintln!(
        "added {} edges (fanout {fanout}) in {:.1}s",
        n as u64 * fanout as u64,
        t1.elapsed().as_secs_f64()
    );
    seg.flush().expect("flush");

    // warm + timed 2-hop traversal from deterministic, spread-out seeds.
    let seeds: Vec<u32> = (0..500).map(|q| (q * (n / 500).max(1)) % n).collect();
    for &s in seeds.iter().take(50) {
        let _ = seg.traverse_typed(&[s], EDGE_MENTIONS, hops).expect("traverse");
    }
    let mut lat = Vec::new();
    let mut reached_total = 0usize;
    for _ in 0..5 {
        for &s in &seeds {
            let t = Instant::now();
            let r = seg.traverse_typed(&[s], EDGE_MENTIONS, hops).expect("traverse");
            lat.push(t.elapsed().as_secs_f64() * 1e3);
            reached_total += r.len();
        }
    }
    lat.sort_by(|x, y| x.partial_cmp(y).unwrap());
    println!("graph_n={n}");
    println!("graph_fanout={fanout}");
    println!("graph_hops={hops}");
    println!("graph_overflow={}", fanout > 4);
    println!("graph_traverse_p50_ms={:.4}", percentile(&lat, 50.0));
    println!("graph_traverse_p90_ms={:.4}", percentile(&lat, 90.0));
    println!("graph_traverse_p99_ms={:.4}", percentile(&lat, 99.0));
    println!("graph_avg_reached={}", reached_total / lat.len());

    let _ = std::fs::remove_dir_all(&tmp);
}
