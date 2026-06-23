#!/usr/bin/env python3
"""
Cross-encoder rerank stage for the mneme SOLVIS recall demo — the accuracy lever HIVEMIND's
live recall lacks (its RERANK_ENABLED is off by default).

Reads candidates.bin (wide candidate pool per query, emitted by solvis-demo), reranks each
query's candidates with `jinaai/jina-reranker-v2-base-multilingual` (a multilingual cross
encoder via fastembed/ONNX — handles the German Solvis docs), and prints the reranked top-k
next to the vector-only order, with timing.

Pipeline mirror: mneme HNSW retrieve-wide (sub-ms, local) → cross-encoder rerank → narrow.

Run:
  PYTHONNOUSERSITE=1 PYTHONPATH="" bench/.venv/bin/python bench/rerank_solvis.py [top_k]
"""
from __future__ import annotations

import os
import struct
import sys
import time
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
SOLVIS = HERE / "solvis"
MODEL = "jinaai/jina-reranker-v2-base-multilingual"
OR_MODEL = "cohere/rerank-4-fast"


def rerank_openrouter(query: str, docs: list[str]) -> list[float]:
    """Fast hosted rerank via OpenRouter (cohere/rerank-4-fast). Returns a score per doc,
    in input order. Needs OPENROUTER_API_KEY with credits."""
    key = os.environ.get("OPENROUTER_API_KEY", "")
    r = requests.post(
        "https://openrouter.ai/api/v1/rerank",
        headers={"Authorization": f"Bearer {key}", "content-type": "application/json"},
        json={"model": OR_MODEL, "query": query, "documents": docs, "top_n": len(docs)},
        timeout=30,
    )
    if r.status_code != 200:
        raise RuntimeError(f"OpenRouter rerank {r.status_code}: {r.text[:160]}")
    scores = [0.0] * len(docs)
    for res in r.json()["results"]:
        scores[res["index"]] = res["relevance_score"]
    return scores


def read_candidates(path: Path):
    """Yield (per query) a list of (vector_score, record_text)."""
    data = path.read_bytes()
    off = 0
    (nq,) = struct.unpack_from("<I", data, off)
    off += 4
    per_query = []
    for _ in range(nq):
        (n,) = struct.unpack_from("<I", data, off)
        off += 4
        cands = []
        for _ in range(n):
            (score,) = struct.unpack_from("<f", data, off)
            off += 4
            (ln,) = struct.unpack_from("<I", data, off)
            off += 4
            text = data[off : off + ln].decode("utf-8", "replace")
            off += ln
            cands.append((score, text))
        per_query.append(cands)
    return per_query


def short(record: str, n: int = 150) -> str:
    parts = record.split("\t", 2)
    src = parts[0] if parts else "?"
    idx = parts[1] if len(parts) > 1 else "?"
    body = (parts[2] if len(parts) > 2 else "").replace("\n", " ")[:n]
    return f"[{src}#{idx}]  {body.strip()}"


def main() -> int:
    use_or = "--openrouter" in sys.argv
    pos = [a for a in sys.argv[1:] if not a.startswith("--")]
    top_k = int(pos[0]) if pos else 5
    queries = (SOLVIS / "queries.txt").read_text().splitlines()
    per_query = read_candidates(SOLVIS / "candidates.bin")
    assert len(queries) == len(per_query), "queries/candidates misaligned"

    encoder = None
    if use_or:
        print(f"reranking via OpenRouter {OR_MODEL} (hosted, fast)", flush=True)
    else:
        from fastembed.rerank.cross_encoder import TextCrossEncoder

        print(f"loading local cross-encoder {MODEL} ...", flush=True)
        encoder = TextCrossEncoder(model_name=MODEL, cache_dir=str(HERE / ".fastembed_cache"))

    total_rerank_ms = 0.0
    for q, cands in zip(queries, per_query):
        docs = [c[1] for c in cands]
        # the cross-encoder reads the full chunk text (its first ~512 tokens)
        doc_texts = [d.split("\t", 2)[-1] for d in docs]
        t = time.time()
        if use_or:
            scores = rerank_openrouter(q, doc_texts)
        else:
            scores = list(encoder.rerank(q, doc_texts))  # type: ignore
        dt = (time.time() - t) * 1e3
        total_rerank_ms += dt
        order = sorted(range(len(docs)), key=lambda i: scores[i], reverse=True)

        print("─────────────────────────────────────────────────────────────")
        print(f"QUERY: {q}")
        print(f"  reranked top-{top_k}  (cross-encoder {dt:.0f} ms over {len(docs)} cands):")
        for rank, i in enumerate(order[:top_k]):
            print(f"    {rank + 1}. ce={scores[i]:+.3f}  {short(docs[i])}")
        # show what plain vector order had at #1 for contrast
        print(f"  vector-only #1 was: {short(docs[0])}")
        print()

    print(
        f"rerank: {len(queries)} queries, mean {total_rerank_ms / len(queries):.0f} ms/query "
        f"(local ONNX cross-encoder, CPU). Retrieval was sub-ms in mneme."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
