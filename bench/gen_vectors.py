#!/usr/bin/env python3
"""
mneme P1 — real test-vector generator (production-fidelity).

Streams real conversational memories from the LongMemEval haystack and embeds them with
**bge-m3 via the blaiq LiteLLM gateway** — the *exact* embedding model + endpoint HIVE-MIND
uses in production (core/src/ingestion/embedder.js -> embeddings/factory.js, model 'bge-m3',
1024-dim, normalized). Using the same model means the P1 benchmark corpus has the same vector
distribution mneme will actually store, so the comparison vs Qdrant is true-to-prod, not a
lookalike.

Output (bench/data/):
  corpus_f32.bin   N_CORPUS * DIM float32 LE, row-major   (the 10k memories)
  queries_f32.bin  N_QUERY  * DIM float32 LE, row-major    (200 held-out queries)
  meta.json        {dim, n_corpus, n_query, model, endpoint, source_sha, normalized:true}

Determinism: memories are taken in stream order (no RNG); bge-m3 is deterministic, so a
re-run reproduces the vectors. Real text only — every vector is a real LongMemEval turn.

Auth: reads LITELLM_API_KEY (falls back to OPENAI_API_KEY) from the environment. No secret
is written to disk. Endpoint overridable via LITELLM_BASE_URL (default the blaiq gateway).

Run:
  PYTHONNOUSERSITE=1 PYTHONPATH="" bench/.venv/bin/python bench/gen_vectors.py
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import ijson
import numpy as np
import requests

# --- config (frozen for P1 reproducibility) -------------------------------------
DIM = 1024
N_CORPUS = 10_000
N_QUERY = 200
MODEL = os.environ.get("LITELLM_EMBED_MODEL", "bge-m3")
BASE_URL = os.environ.get("LITELLM_BASE_URL", "https://api.blaiq.ai/v1").rstrip("/")
API_KEY = os.environ.get("LITELLM_API_KEY") or os.environ.get("OPENAI_API_KEY") or ""
BATCH = 96
WORKERS = 4
RETRIES = 4
TIMEOUT = 60
MIN_CHARS = 40
MAX_CHARS = 2_000

HERE = Path(__file__).resolve().parent
SOURCE = Path(
    "/Users/amar/HIVE-MIND/benchmarks/LongMemEval/data/longmemeval_s_cleaned.json"
)
OUT = HERE / "data"


def iter_memories(path: Path):
    """Yield real memory texts (haystack conversation turns) in deterministic order."""
    seen: set[str] = set()
    with open(path, "rb") as fh:
        for rec in ijson.items(fh, "item"):
            for session in rec.get("haystack_sessions", []):
                if not isinstance(session, list):
                    continue
                for turn in session:
                    if not isinstance(turn, dict):
                        continue
                    content = (turn.get("content") or "").strip()
                    if len(content) < MIN_CHARS:
                        continue
                    content = content[:MAX_CHARS]
                    key = content[:160]
                    if key in seen:
                        continue
                    seen.add(key)
                    yield content


def embed_batch(texts: list[str]) -> list[list[float]]:
    """Embed one batch via the LiteLLM /embeddings endpoint, with retry/backoff."""
    url = f"{BASE_URL}/embeddings"
    headers = {
        "authorization": f"Bearer {API_KEY}",
        "content-type": "application/json",
    }
    payload = {"model": MODEL, "input": texts}
    last_err = None
    for attempt in range(RETRIES):
        try:
            r = requests.post(url, headers=headers, json=payload, timeout=TIMEOUT)
            if r.status_code == 200:
                data = r.json()["data"]
                # reorder by 'index' to guarantee alignment with `texts`
                data.sort(key=lambda d: d["index"])
                return [d["embedding"] for d in data]
            last_err = f"HTTP {r.status_code}: {r.text[:160]}"
        except (requests.RequestException, ValueError, KeyError) as e:
            last_err = repr(e)
        time.sleep(min(2 ** attempt, 8))
    raise RuntimeError(f"embed_batch failed after {RETRIES} attempts: {last_err}")


def source_sha(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        h.update(fh.read(8 * 1024 * 1024))
    return h.hexdigest()[:16]


def write_f32(path: Path, arr: np.ndarray) -> None:
    assert arr.dtype == np.float32 and arr.ndim == 2 and arr.shape[1] == DIM
    with open(path, "wb") as fh:
        fh.write(arr.astype("<f4", copy=False).tobytes(order="C"))


def main() -> int:
    if not API_KEY:
        print("FATAL: LITELLM_API_KEY/OPENAI_API_KEY not set", file=sys.stderr)
        return 1
    if not SOURCE.exists():
        print(f"FATAL: source corpus missing: {SOURCE}", file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)

    need = N_CORPUS + N_QUERY
    print(f"collecting {need} real memory texts from LongMemEval...", flush=True)
    texts: list[str] = []
    for t in iter_memories(SOURCE):
        texts.append(t)
        if len(texts) >= need:
            break
    if len(texts) < need:
        print(f"FATAL: only {len(texts)} memories, need {need}", file=sys.stderr)
        return 1
    print(f"collected {len(texts)}. embedding via {MODEL} @ {BASE_URL} ...", flush=True)

    # batches in order; embed concurrently but reassemble by batch index.
    batches = [texts[i : i + BATCH] for i in range(0, need, BATCH)]
    results: list[list[list[float]] | None] = [None] * len(batches)
    done = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(embed_batch, b): bi for bi, b in enumerate(batches)}
        for fut in futs:
            pass  # submitted
        for fut in list(futs):
            bi = futs[fut]
            results[bi] = fut.result()
            done += 1
            if done % 10 == 0 or done == len(batches):
                print(
                    f"  batch {done}/{len(batches)}  ({time.time() - t0:.1f}s)",
                    flush=True,
                )

    vecs = np.zeros((need, DIM), dtype=np.float32)
    w = 0
    for bi, batch_vecs in enumerate(results):
        assert batch_vecs is not None, f"batch {bi} missing"
        for emb in batch_vecs:
            v = np.asarray(emb, dtype=np.float32)
            if v.shape[0] != DIM:
                print(f"FATAL: model dim {v.shape[0]} != {DIM}", file=sys.stderr)
                return 1
            n = np.linalg.norm(v)
            vecs[w] = v / n if n > 0 else v  # unit L2 -> cosine == dot
            w += 1
    assert w == need, f"got {w} vectors, expected {need}"

    corpus = vecs[:N_CORPUS]
    queries = vecs[N_CORPUS : N_CORPUS + N_QUERY]
    write_f32(OUT / "corpus_f32.bin", corpus)
    write_f32(OUT / "queries_f32.bin", queries)

    meta = {
        "dim": DIM,
        "n_corpus": N_CORPUS,
        "n_query": N_QUERY,
        "model": MODEL,
        "endpoint": f"{BASE_URL}/embeddings",
        "source": str(SOURCE),
        "source_sha": source_sha(SOURCE),
        "normalized": True,
        "endianness": "little",
        "dtype": "float32",
        "layout": "row-major",
        "note": "same bge-m3 model+gateway HIVE-MIND uses in production",
    }
    (OUT / "meta.json").write_text(json.dumps(meta, indent=2))

    q0 = queries[0]
    sims = corpus @ q0
    print(
        f"done in {time.time() - t0:.1f}s. corpus={corpus.shape} queries={queries.shape} "
        f"q0_max_cos={float(sims.max()):.3f} q0_mean_cos={float(sims.mean()):.3f}",
        flush=True,
    )
    print(f"wrote {OUT}/corpus_f32.bin, queries_f32.bin, meta.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
