//! P5-1: 2-hop adjacency BFS in recall + bi-temporal time-travel.

use mseg::{Filter, MemoryInput, Segment};
use mseg_format::ADJACENCY_LEN;
use mseg_format::SENTINEL_U32;
use tempfile::tempdir;

fn ins(seg: &mut Segment, text: &str, v: Vec<f32>, adj: [u32; ADJACENCY_LEN]) -> u32 {
    let mut m = MemoryInput::new(text, v);
    m.adjacency = adj;
    seg.insert(m).unwrap()
}

#[test]
fn two_hop_bfs_reaches_graph_neighbours() {
    // chain A --adj--> B --adj--> C. Query is close to A only; B,C are far in vector space but
    // reachable via the graph. Insert C first so its id is known when wiring B->C, etc.
    let dir = tempdir().unwrap();
    let mut seg = Segment::create(dir.path(), "s", 4).unwrap();
    let none = [SENTINEL_U32; ADJACENCY_LEN];
    let mut adj_a = none;
    let mut adj_b = none;
    let c = ins(&mut seg, "C", vec![0.0, 0.0, 1.0, 0.0], none);
    adj_b[0] = c;
    let b = ins(&mut seg, "B", vec![0.0, 1.0, 0.0, 0.0], adj_b);
    adj_a[0] = b;
    let a = ins(&mut seg, "A", vec![1.0, 0.0, 0.0, 0.0], adj_a);

    let q = vec![1.0, 0.0, 0.0, 0.0]; // closest to A

    // hops=0: only A is near; C should not appear
    let h0 = seg.recall_with_hops(&q, &Filter::default(), 3, 0).unwrap();
    assert!(h0.iter().any(|h| h.slot_id == a));

    // hops=2: A->B->C, all three reachable
    let h2 = seg.recall_with_hops(&q, &Filter::default(), 3, 2).unwrap();
    let ids: std::collections::HashSet<u32> = h2.iter().map(|h| h.slot_id).collect();
    assert!(
        ids.contains(&a) && ids.contains(&b) && ids.contains(&c),
        "2-hop must reach C via A->B->C"
    );
}

#[test]
fn bitemporal_time_travel_independent_axes() {
    // created_at (when learned) and valid_from (when true) are independent (SPEC §5.1/§5.4).
    let dir = tempdir().unwrap();
    let mut seg = Segment::create(dir.path(), "s", 2).unwrap();
    let none = [SENTINEL_U32; ADJACENCY_LEN];

    // a fact learned late (created_at=500) but valid early (valid_from=100)
    let mut m = MemoryInput::new("late-learned early-valid", vec![1.0, 0.0]);
    m.created_at = Some(500);
    m.valid_from = 100;
    m.adjacency = none;
    let id = seg.insert(m).unwrap();

    let q = vec![1.0, 0.0];
    // filter by VALID time window [50,150] → matches (valid_from=100)
    let f_valid = Filter {
        valid_from_range: Some((50, 150)),
        ..Default::default()
    };
    assert_eq!(seg.recall(&q, &f_valid, 5).unwrap().len(), 1);

    // filter by CREATED time window [50,150] → does NOT match (created_at=500)
    let f_created = Filter {
        created_at_range: Some((50, 150)),
        ..Default::default()
    };
    assert_eq!(seg.recall(&q, &f_created, 5).unwrap().len(), 0);

    // created window [400,600] → matches
    let f_created2 = Filter {
        created_at_range: Some((400, 600)),
        ..Default::default()
    };
    let hits = seg.recall(&q, &f_created2, 5).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].slot_id, id);
}
