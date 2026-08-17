"""Runnable example: ICARUS as a LlamaIndex vector store.

    pip install maturin && maturin develop --release  # in crate/mneme-python/, not on PyPI yet
    pip install llama-index-core
    python llamaindex_example.py

Zero API key needed — see toy_embed.py for why (swap in a real embedder for production, same
API, see BENCHMARKS.md for what that actually measures).
"""
import tempfile

from llama_index.core.schema import TextNode
from llama_index.core.vector_stores.types import VectorStoreQuery
from mneme_python import MnemeStore
from mneme_integrations.llamaindex import MnemeVectorStore
from toy_embed import toy_embed

DIM = 64

with tempfile.TemporaryDirectory() as tmp:
    vstore = MnemeVectorStore(mneme=MnemeStore(tmp, "llamaindex-demo", DIM))

    memories = [
        "the user prefers dark mode in every app",
        "the warranty on the laptop covers 24 months of parts and labor",
        "the quarterly revenue report shows growth in the EU region",
    ]
    nodes = [TextNode(text=m, embedding=toy_embed(m, DIM)) for m in memories]
    vstore.add(nodes)

    result = vstore.query(VectorStoreQuery(
        query_embedding=toy_embed("laptop warranty coverage", DIM), similarity_top_k=2,
    ))

    print(f"stored {len(memories)} memories, retrieved {len(result.nodes)} via LlamaIndex's VectorStore:\n")
    for node, score in zip(result.nodes, result.similarities):
        print(f"  [{score:.3f}] {node.text}")
