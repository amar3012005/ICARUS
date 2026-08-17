"""Runnable example: the smallest possible agent-with-memory loop — no framework, just the
storage engine. This is what every LangChain/LlamaIndex/custom integration is doing underneath:
recall before responding, store what mattered after.

    pip install maturin && maturin develop --release  # in crate/mneme-python/, not on PyPI yet
    python minimal_agent_loop.py

Zero API key needed — see toy_embed.py for why (swap in a real embedder + real LLM call for
production, same shape).
"""
import tempfile

from mneme_python import MnemeStore
from toy_embed import toy_embed

DIM = 64


def fake_llm_respond(user_message: str, recalled_memories: list) -> str:
    """Stands in for a real LLM call — a real agent would put `recalled_memories` in the
    system prompt as grounding context. This just proves the plumbing: memory recalled before
    responding actually reaches the "model"."""
    if recalled_memories:
        context = "; ".join(m.text for m in recalled_memories)
        return f'(grounded in: "{context}") -> got it, noted.'
    return "(no relevant memory found) -> noted, first time hearing this."


def agent_turn(store: MnemeStore, user_message: str) -> str:
    # 1. Recall whatever's relevant BEFORE responding.
    recalled = store.recall(toy_embed(user_message, DIM), top_k=2)
    # 2. Respond (a real agent calls an LLM here, with `recalled` as grounding context).
    reply = fake_llm_respond(user_message, recalled)
    # 3. Store the new turn as a memory for future turns to recall.
    store.insert(user_message, toy_embed(user_message, DIM), 0)
    return reply


with tempfile.TemporaryDirectory() as tmp:
    store = MnemeStore(tmp, "agent-loop-demo", DIM)

    conversation = [
        "I prefer dark mode in every app I use",
        "what UI theme do I like",              # should recall turn 1
        "my laptop's warranty covers 24 months",
        "how long is my laptop covered for",     # should recall turn 3, not turn 1
    ]
    for turn in conversation:
        print(f"user: {turn}")
        print(f"agent: {agent_turn(store, turn)}\n")

    print(f"final live memory count: {store.live_count()}")
