//! P2-5 acceptance: multi-tenant shard isolation + advisory lock (SPEC §4).

use mseg::{Filter, MemoryInput, MsegError, Shard};
use tempfile::tempdir;

#[test]
fn second_open_of_same_org_is_locked() {
    let root = tempdir().unwrap();
    let a = Shard::open(root.path(), "acme", 4).unwrap();
    // a second handle to the same org must fail to acquire the lock.
    let b = Shard::open(root.path(), "acme", 4);
    assert!(
        matches!(b, Err(MsegError::ShardLocked)),
        "second open should be ShardLocked"
    );
    drop(a);
    // once the first is dropped (lock released), reopening succeeds.
    let c = Shard::open(root.path(), "acme", 4);
    assert!(c.is_ok());
}

#[test]
fn different_orgs_are_independent() {
    let root = tempdir().unwrap();
    let mut a = Shard::open(root.path(), "org-a", 4).unwrap();
    let mut b = Shard::open(root.path(), "org-b", 4).unwrap();
    let ia = a
        .segment()
        .insert(MemoryInput::new("a-memory", vec![1.0, 0.0, 0.0, 0.0]))
        .unwrap();
    let ib = b
        .segment()
        .insert(MemoryInput::new("b-memory", vec![0.0, 1.0, 0.0, 0.0]))
        .unwrap();
    assert_eq!(a.segment().get(ia).unwrap().text, "a-memory");
    assert_eq!(b.segment().get(ib).unwrap().text, "b-memory");
    // a's recall never sees b's data (separate files).
    let hits = a
        .segment()
        .recall(&[1.0, 0.0, 0.0, 0.0], &Filter::default(), 10)
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].text, "a-memory");
}

#[test]
fn data_persists_across_shard_reopen() {
    let root = tempdir().unwrap();
    let id;
    {
        let mut s = Shard::open(root.path(), "acme", 3).unwrap();
        id = s
            .segment()
            .insert(MemoryInput::new("durable", vec![0.3, 0.4, 0.5]))
            .unwrap();
    } // drop releases lock + flushes
    let mut s = Shard::open(root.path(), "acme", 3).unwrap();
    assert_eq!(s.segment().get(id).unwrap().text, "durable");
}

#[test]
fn bad_org_id_rejected_before_touching_fs() {
    let root = tempdir().unwrap();
    assert!(matches!(
        Shard::open(root.path(), "../escape", 4),
        Err(MsegError::InvalidOrgId(_))
    ));
    assert!(matches!(
        Shard::open(root.path(), "a/b", 4),
        Err(MsegError::InvalidOrgId(_))
    ));
}
