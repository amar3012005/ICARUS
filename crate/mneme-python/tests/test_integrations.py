"""Real tests for the optional LangChain/LlamaIndex integrations -- each opens a real shard,
inserts real (fake-embedded) records, and asserts on real returned data through the actual
framework interfaces, not a mock of them."""
import hashlib
import tempfile

import pytest

DIM = 4


def fake_embed(text: str) -> list:
    """Deterministic, dependency-free stand-in for a real embedding model: same text always
    produces the same vector, different text produces a different one -- enough to prove the
    plumbing is correct without needing a real model or network call in CI."""
    h = hashlib.md5(text.encode()).digest()
    return [b / 255.0 for b in h[:DIM]]


def test_langchain_retriever_returns_documents_from_a_real_store():
    langchain_core = pytest.importorskip("langchain_core")
    from mneme_python import MnemeStore
    from mneme_integrations.langchain import MnemeRetriever

    with tempfile.TemporaryDirectory() as tmp:
        store = MnemeStore(tmp, "lc-test", DIM)
        warranty_text = "warranty terms cover parts and labor for 36 months"
        store.insert(warranty_text, fake_embed(warranty_text), 0)
        store.insert("quarterly revenue growth report", fake_embed("quarterly revenue growth report"), 0)

        retriever = MnemeRetriever(store=store, embed_query=fake_embed, top_k=2)
        docs = retriever.invoke(warranty_text)

        assert len(docs) == 2
        assert docs[0].page_content == warranty_text
        assert docs[0].metadata["score"] == pytest.approx(1.0, abs=1e-4)


def test_llamaindex_vector_store_add_query_delete():
    pytest.importorskip("llama_index.core")
    from mneme_python import MnemeStore
    from mneme_integrations.llamaindex import MnemeVectorStore
    from llama_index.core.schema import TextNode
    from llama_index.core.vector_stores.types import VectorStoreQuery

    with tempfile.TemporaryDirectory() as tmp:
        vstore = MnemeVectorStore(mneme=MnemeStore(tmp, "li-test", DIM))

        warranty_text = "warranty terms cover parts and labor"
        node_a = TextNode(text=warranty_text, embedding=fake_embed(warranty_text))
        node_b = TextNode(text="quarterly revenue report", embedding=fake_embed("quarterly revenue report"))
        vstore.add([node_a, node_b])

        result = vstore.query(VectorStoreQuery(query_embedding=fake_embed(warranty_text), similarity_top_k=2))
        assert len(result.nodes) == 2
        assert result.similarities[0] == pytest.approx(1.0, abs=1e-4)

        vstore.delete(node_a.node_id)
        after = vstore.query(VectorStoreQuery(query_embedding=fake_embed(warranty_text), similarity_top_k=2))
        assert len(after.nodes) == 1
