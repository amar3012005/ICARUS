"""Shared toy embedding for the examples/ scripts — deliberately dependency-free and API-key-free
so every example here runs on a completely clean machine with zero setup. Bag-of-words hashing,
NOT a real semantic model: it catches word-overlap similarity, not paraphrase/synonym similarity.
Swap in a real embedding model (bge-m3, OpenAI, ...) for production — same API either way, see
BENCHMARKS.md for what a real model actually measures on real data.
"""
import re


def toy_embed(text: str, dim: int = 64) -> list:
    vec = [0.0] * dim
    for word in re.split(r"\W+", text.lower()):
        if not word:
            continue
        h = 2166136261
        for ch in word:
            h = ((h ^ ord(ch)) * 16777619) & 0xFFFFFFFF
        vec[h % dim] += 1.0
    norm = sum(x * x for x in vec) ** 0.5 or 1.0
    return [x / norm for x in vec]
