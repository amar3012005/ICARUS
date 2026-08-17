"""Runnable example: ICARUS as a LangChain retriever.

    pip install maturin && maturin develop --release  # in crate/mneme-python/, not on PyPI yet
    pip install langchain-core
    python langchain_example.py

Zero API key needed — see toy_embed.py for why (swap in a real embedder for production, same
API, see BENCHMARKS.md for what that actually measures).
"""
import tempfile

from mneme_python import MnemeStore
from mneme_integrations.langchain import MnemeRetriever
from toy_embed import toy_embed

DIM = 64

with tempfile.TemporaryDirectory() as tmp:
    store = MnemeStore(tmp, "langchain-demo", DIM)

    memories = [
        "the user prefers dark mode in every app",
        "the warranty on the laptop covers 24 months of parts and labor",
        "the quarterly revenue report shows growth in the EU region",
    ]
    for m in memories:
        store.insert(m, toy_embed(m, DIM), 0)

    retriever = MnemeRetriever(store=store, embed_query=lambda q: toy_embed(q, DIM), top_k=2)
    docs = retriever.invoke("laptop warranty coverage")

    print(f"stored {len(memories)} memories, retrieved {len(docs)} via LangChain's BaseRetriever:\n")
    for d in docs:
        print(f"  [{d.metadata['score']:.3f}] {d.page_content}")
