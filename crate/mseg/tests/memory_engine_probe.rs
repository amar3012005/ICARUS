//! T2-PROBE — the fork between "vector store" and "first single-file memory engine".
//!
//! Builds a typed memory graph + a bi-temporal version chain, FLUSHES, REOPENS the mmap, then
//! answers two queries Postgres would normally serve — entirely from the single `.amr` map: a
//! typed 2-hop traversal (follow only `Mentions`, not other edge types), and a "what did we know
//! on date X" bi-temporal point-in-time over an `Updates` version chain. Each is checked against
//! the reference answer computed in-test. PASS here = the format holds the whole memory, not just
//! embeddings.

use mseg::{MemoryInput, Segment};
use mseg_format::{EDGE_DERIVES, EDGE_MENTIONS, EDGE_UPDATES};
use tempfile::tempdir;

/// Stage 4.1 — edge overflow: a memory with far more than the inline edge slots must spill to the
/// `.edg` region and still traverse correctly after a reopen.
#[test]
fn typed_edges_overflow_to_edg_region() {
    let dir = tempdir().unwrap();
    const N: u32 = 50;
    let hub;
    {
        let mut seg = Segment::create(dir.path(), "g", 4).unwrap();
        hub = seg
            .insert(MemoryInput::new("hub", vec![1.0, 0.0, 0.0, 0.0]))
            .unwrap();
        // 50 Mentions targets via the unbounded add_edge (forces inline -> .edg overflow).
        for i in 0..N {
            let t = seg
                .insert(MemoryInput::new(
                    format!("t{i}"),
                    vec![i as f32, 1.0, 0.0, 0.0],
                ))
                .unwrap();
            seg.add_edge(hub, t, EDGE_MENTIONS, 1).unwrap();
        }
        seg.flush().unwrap();
    }
    // reopen: all 50 typed edges must survive in the .edg region.
    let seg = Segment::open(dir.path(), "g").unwrap();
    let edges = seg.slot_edges(hub).unwrap();
    assert_eq!(
        edges.len(),
        N as usize,
        "all 50 edges must survive overflow+reopen"
    );
    assert!(edges.iter().all(|&(_, ty, _)| ty == EDGE_MENTIONS));
    let reached = seg.traverse_typed(&[hub], EDGE_MENTIONS, 1).unwrap();
    assert_eq!(reached.len(), N as usize, "1-hop must reach all 50 targets");
}

/// `.edg` overflow churns (each edge add to an overflowed slot rewrites the whole block, orphaning
/// the old one). compact() must reclaim those orphans while keeping the edges correct.
#[test]
fn compact_reclaims_orphaned_edg_blocks() {
    let dir = tempdir().unwrap();
    let mut seg = Segment::create(dir.path(), "g", 4).unwrap();
    let hub = seg
        .insert(MemoryInput::new("hub", vec![1.0, 0.0, 0.0, 0.0]))
        .unwrap();
    // create overflow + churn: 40 adds, each (past inline) rewrites the whole block -> orphans.
    for i in 0..40u32 {
        let t = seg
            .insert(MemoryInput::new(
                format!("t{i}"),
                vec![i as f32, 1.0, 0.0, 0.0],
            ))
            .unwrap();
        seg.add_edge(hub, t, EDGE_MENTIONS, 1).unwrap();
    }
    seg.flush().unwrap();
    let edg_path = dir.path().join("g.edg");
    let before = std::fs::metadata(&edg_path).unwrap().len();

    let reclaimed = seg.compact().unwrap();
    let after = std::fs::metadata(&edg_path).unwrap().len();
    assert!(
        after < before,
        "compact must shrink the churned .edg ({after} !< {before})"
    );
    assert!(reclaimed > 0);

    // edges survive compaction + reopen, all 40 reachable.
    seg.flush().unwrap();
    let seg2 = Segment::open(dir.path(), "g").unwrap();
    assert_eq!(seg2.slot_edges(hub).unwrap().len(), 40);
    assert_eq!(
        seg2.traverse_typed(&[hub], EDGE_MENTIONS, 1).unwrap().len(),
        40
    );
}

/// Index persistence: enable_hnsw + flush writes `.mnsw`; a reopen loads it (no rebuild) and
/// recall still returns the right top-1 — turning a minutes-long cold rebuild into a ms load.
#[test]
fn hnsw_index_persists_and_reloads() {
    use mseg::Filter;
    let dir = tempdir().unwrap();
    let target;
    {
        let mut seg = Segment::create(dir.path(), "g", 4).unwrap();
        for i in 0..200u32 {
            seg.insert(MemoryInput::new(
                format!("m{i}"),
                vec![i as f32, 1.0, 0.0, 0.0],
            ))
            .unwrap();
        }
        target = seg
            .insert(MemoryInput::new("needle", vec![999.0, 1.0, 0.0, 0.0]))
            .unwrap();
        seg.enable_hnsw().unwrap();
        seg.index_drain();
        seg.flush().unwrap();
    }
    // .mnsw must exist after flush.
    assert!(
        dir.path().join("g.mnsw").exists(),
        "flush must persist the HNSW index to .mnsw"
    );
    // reopen + enable_hnsw → loads the persisted graph; recall finds the needle.
    let mut seg = Segment::open(dir.path(), "g").unwrap();
    seg.enable_hnsw().unwrap();
    let hits = seg
        .recall(&[999.0, 1.0, 0.0, 0.0], &Filter::default(), 1)
        .unwrap();
    assert_eq!(
        hits[0].slot_id, target,
        "reloaded index must recall the needle"
    );
}

/// 3-layer separation: one shard holds evidence + memory + cognitive; a layer-filtered recall
/// returns ONLY that layer (like Qdrant's `layer` payload filter), default recall = memory only.
#[test]
fn layers_are_separated_and_filtered_per_usage() {
    use mseg::Filter;
    use mseg_format::{LAYER_COGNITIVE, LAYER_EVIDENCE, LAYER_MEMORY};
    let dir = tempdir().unwrap();
    let mut seg = Segment::create(dir.path(), "g", 4).unwrap();
    let mk = |layer: u8| {
        let mut m = MemoryInput::new("x".to_string(), vec![1.0, 0.0, 0.0, 0.0]);
        m.layer = layer;
        m
    };
    let ev = seg.insert(mk(LAYER_EVIDENCE)).unwrap();
    let me = seg.insert(mk(LAYER_MEMORY)).unwrap();
    let co = seg.insert(mk(LAYER_COGNITIVE)).unwrap();
    seg.flush().unwrap();

    let q = [1.0, 0.0, 0.0, 0.0];
    let mut only = |layer: u8| {
        let f = Filter {
            layer: Some(layer),
            ..Default::default()
        };
        seg.recall(&q, &f, 10)
            .unwrap()
            .iter()
            .map(|h| h.slot_id)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        only(LAYER_EVIDENCE),
        vec![ev],
        "evidence filter returns only evidence"
    );
    assert_eq!(
        only(LAYER_MEMORY),
        vec![me],
        "memory filter returns only memory"
    );
    assert_eq!(
        only(LAYER_COGNITIVE),
        vec![co],
        "cognitive filter returns only cognitive"
    );
    // no filter = all 3 layers present
    let all = seg.recall(&q, &Filter::default(), 10).unwrap().len();
    assert_eq!(all, 3, "unfiltered recall sees all layers");
}

fn mem(text: &str, x: f32, created_at: i64) -> MemoryInput {
    let mut m = MemoryInput::new(text.to_string(), vec![x, 1.0, 0.0, 0.0]);
    m.created_at = Some(created_at);
    m
}

/// Stage 4.2 — write-path versioning: `update()` builds the version chain itself; recall returns
/// ONLY the latest version (superseded ones excluded), while `as_of` still reaches every past one.
#[test]
fn update_builds_version_chain_recall_latest_only() {
    use mseg::Filter;
    let dir = tempdir().unwrap();
    let mut seg = Segment::create(dir.path(), "g", 4).unwrap();

    // a distractor memory + a fact that gets updated twice (same vector across versions).
    let _other = seg.insert(mem("other", -1.0, 100)).unwrap();
    let v1 = seg.insert(mem("price=10", 5.0, 100)).unwrap();
    let v2 = seg.update(v1, mem("price=20", 5.0, 200)).unwrap();
    let v3 = seg.update(v2, mem("price=30", 5.0, 300)).unwrap();
    seg.flush().unwrap();

    // recall on the fact vector must return ONLY v3 (latest); v1, v2 are superseded -> excluded.
    let hits = seg
        .recall(&[5.0, 1.0, 0.0, 0.0], &Filter::default(), 10)
        .unwrap();
    let ids: Vec<u32> = hits.iter().map(|h| h.slot_id).collect();
    assert!(
        ids.contains(&v3),
        "recall must return the latest version v3"
    );
    assert!(
        !ids.contains(&v1) && !ids.contains(&v2),
        "superseded versions excluded from recall: {ids:?}"
    );

    // but as_of reaches every past version via the auto-built Updates chain.
    assert_eq!(seg.as_of(v3, 150).unwrap(), Some(v1));
    assert_eq!(seg.as_of(v3, 250).unwrap(), Some(v2));
    assert_eq!(seg.as_of(v3, 350).unwrap(), Some(v3));
    assert_eq!(
        seg.get(v1).unwrap().text,
        "price=10",
        "old versions still readable for as_of"
    );
}

#[test]
fn typed_traversal_and_bitemporal_from_one_mmap() {
    let dir = tempdir().unwrap();

    // --- build the graph + version chain, then flush ---
    let (a, b, c, d, v1, v2, v3);
    {
        let mut seg = Segment::create(dir.path(), "g", 4).unwrap();
        // entity graph: A --Mentions--> B --Mentions--> C ; A --Derives--> D
        a = seg.insert(mem("A", 1.0, 100)).unwrap();
        b = seg.insert(mem("B", 2.0, 100)).unwrap();
        c = seg.insert(mem("C", 3.0, 100)).unwrap();
        d = seg.insert(mem("D", 4.0, 100)).unwrap();
        seg.set_edge(a, 0, b, EDGE_MENTIONS, 200).unwrap();
        seg.set_edge(b, 0, c, EDGE_MENTIONS, 200).unwrap();
        seg.set_edge(a, 1, d, EDGE_DERIVES, 200).unwrap();

        // version chain of one fact: v1@100 -> v2@200 -> v3@300, each Updates the prior.
        v1 = seg.insert(mem("price=10", 9.0, 100)).unwrap();
        v2 = seg.insert(mem("price=20", 9.0, 200)).unwrap();
        v3 = seg.insert(mem("price=30", 9.0, 300)).unwrap();
        seg.set_edge(v2, 0, v1, EDGE_UPDATES, 0).unwrap();
        seg.set_edge(v3, 0, v2, EDGE_UPDATES, 0).unwrap();
        seg.flush().unwrap();
    }

    // --- REOPEN: everything below is served from the persistent mmap, no in-memory state ---
    let mut seg = Segment::open(dir.path(), "g").unwrap();

    // 1) typed 2-hop following ONLY Mentions: A -> {B, C}. D (Derives) must NOT appear.
    let reached = seg.traverse_typed(&[a], EDGE_MENTIONS, 2).unwrap();
    let set: std::collections::HashSet<u32> = reached.iter().copied().collect();
    assert!(
        set.contains(&b) && set.contains(&c),
        "2-hop Mentions must reach B and C: {reached:?}"
    );
    assert!(
        !set.contains(&d),
        "Derives edge must NOT be followed by a Mentions traversal"
    );

    // typed 1-hop: only B.
    let one = seg.traverse_typed(&[a], EDGE_MENTIONS, 1).unwrap();
    assert_eq!(one, vec![b], "1-hop Mentions = [B]");

    // a Derives traversal from A reaches only D.
    let der = seg.traverse_typed(&[a], EDGE_DERIVES, 2).unwrap();
    assert_eq!(der, vec![d], "Derives traversal = [D]");

    // 2) bi-temporal "what did we know on date X" over the Updates chain (head = v3).
    assert_eq!(seg.as_of(v3, 50).unwrap(), None, "nothing known at t=50");
    assert_eq!(
        seg.as_of(v3, 150).unwrap(),
        Some(v1),
        "at t=150 the current version is v1 (price=10)"
    );
    assert_eq!(
        seg.as_of(v3, 250).unwrap(),
        Some(v2),
        "at t=250 -> v2 (price=20)"
    );
    assert_eq!(
        seg.as_of(v3, 350).unwrap(),
        Some(v3),
        "at t=350 -> v3 (price=30)"
    );

    // and the as-of result's TEXT is correct (served from the same map).
    assert_eq!(
        seg.get(seg.as_of(v3, 250).unwrap().unwrap()).unwrap().text,
        "price=20"
    );
}
