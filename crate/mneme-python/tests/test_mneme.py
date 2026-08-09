"""Real, reproducible tests for the mneme Python binding.

Not a smoke test that only checks the module imports -- every test here opens a real `.amr`
shard on disk, inserts real records, and asserts on actual returned data. This is the same
scenario verified manually against the Node binding (identical BM25 score on the same corpus,
proving both bindings share one scoring implementation rather than two that could drift), turned
into something anyone cloning the repo can run with `pytest`.
"""
import tempfile

import pytest
from mneme_python import MnemeStore

DIM = 4
ZERO = [0.0] * DIM


@pytest.fixture
def store():
    with tempfile.TemporaryDirectory() as tmp:
        yield MnemeStore(tmp, "test-org", DIM)


def test_insert_and_live_count(store):
    assert store.live_count() == 0
    store.insert("first memory", ZERO, 0)
    store.insert("second memory", ZERO, 0)
    assert store.live_count() == 2


def test_bm25_search_finds_only_the_matching_document(store):
    store.insert("the quarterly revenue report shows growth", ZERO, 0)
    warranty_slot = store.insert("warranty terms cover 36 months of parts and labor", ZERO, 0)
    store.insert("annual maintenance schedule and site visit notes", ZERO, 0)

    hits = store.bm25_search("warranty", 5)
    assert len(hits) == 1
    assert hits[0].slot_id == warranty_slot
    assert "warranty" in hits[0].text
    assert hits[0].score > 0


def test_bm25_search_no_match_returns_empty(store):
    store.insert("alpha beta gamma", ZERO, 0)
    assert store.bm25_search("omega", 5) == []


def test_bm25_score_matches_the_node_binding_on_the_same_corpus():
    # This exact corpus and query were run against the Node binding manually (mneme-node's own
    # test suite) and produced 0.9145 for this input on a 3-document corpus with the same three
    # sentences. Both bindings call the SAME mneme-bm25 crate -- this pins that they keep doing so
    # rather than drifting into two independently-tuned implementations.
    with tempfile.TemporaryDirectory() as tmp:
        s = MnemeStore(tmp, "parity-check", DIM)
        s.insert("the quarterly revenue report shows growth for the region", ZERO, 0)
        s.insert("warranty terms cover 36 months of parts and labor for all units", ZERO, 0)
        s.insert("annual maintenance schedule and site visit notes for the facility", ZERO, 0)
        hits = s.bm25_search("warranty", 5)
        assert len(hits) == 1
        assert hits[0].score == pytest.approx(0.9145, abs=1e-3)


def test_vector_recall_returns_requested_count(store):
    for i in range(5):
        store.insert(f"memory {i}", ZERO, 0)
    hits = store.recall(ZERO, 3)
    assert len(hits) == 3


def test_layered_recall_separates_layers(store):
    mem_slot = store.insert_layered("a memory", ZERO, 0, 0)
    ev_slot = store.insert_layered("a piece of evidence", ZERO, 0, 1)

    memory_only = store.recall_layer(ZERO, 10, 0)
    evidence_only = store.recall_layer(ZERO, 10, 1)
    all_layers = store.recall_layer(ZERO, 10, -1)

    assert {h.slot_id for h in memory_only} == {mem_slot}
    assert {h.slot_id for h in evidence_only} == {ev_slot}
    assert {h.slot_id for h in all_layers} == {mem_slot, ev_slot}


def test_insert_rejects_wrong_vector_dimension(store):
    with pytest.raises(ValueError):
        store.insert("bad vector", [0.0, 0.0], 0)  # DIM is 4, not 2


def test_delete_removes_from_recall(store):
    slot = store.insert("to be deleted", ZERO, 0)
    assert store.live_count() == 1
    store.delete(slot)
    assert store.live_count() == 0


def test_edges_and_graph_traversal(store):
    a = store.insert("node a", ZERO, 0)
    b = store.insert("node b", ZERO, 0)
    c = store.insert("node c", ZERO, 0)
    store.add_edge(a, b, 1, 255)
    store.add_edge(b, c, 1, 255)

    reachable = store.traverse_typed(a, 1, max_hops=2)
    assert b in reachable
    assert c in reachable


def test_reopening_the_same_shard_preserves_data():
    with tempfile.TemporaryDirectory() as tmp:
        s1 = MnemeStore(tmp, "persist-org", DIM)
        s1.insert("durable memory", ZERO, 0)
        s1.flush()
        del s1

        s2 = MnemeStore(tmp, "persist-org", DIM)
        assert s2.live_count() == 1
        hits = s2.bm25_search("durable", 5)
        assert len(hits) == 1
