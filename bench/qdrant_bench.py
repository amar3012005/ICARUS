#!/usr/bin/env python3
"""
mneme P1 — Qdrant REST baseline harness.

Starts a local Qdrant 1.18.2, loads the SAME real bge-m3 corpus + queries mneme uses,
and measures per-query recall@10 latency over the REST API — the number the P1 gate
compares mneme's int8 scan against.

Fairness / steelman the baseline (we want to BEAT the real thing, not a strawman):
  * Persistent keep-alive HTTP session (no per-request TCP/TLS handshake).
  * Config mirrors HIVEMIND prod: scalar int8 quantization, always_ram=true (quantized
    vectors in RAM), originals on_disk=true. This is the exact tradeoff HIVEMIND runs.
  * Same warmup + repeat schedule as the mneme bench (apples-to-apples sample count).
  * recall@10 measured vs the exact f32 oracle so quality is on the record too.

Output: writes key=value lines to bench/.qdrant_numbers.txt:
  qdrant_rest_p50_ms=, qdrant_rest_p90_ms=, qdrant_rest_mean_ms=, qdrant_recall_at_k=

Run:
  PYTHONNOUSERSITE=1 PYTHONPATH="" bench/.venv/bin/python bench/qdrant_bench.py
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import requests

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
QDIR = HERE / "qdrant"
QBIN = QDIR / "qdrant"
STORAGE = QDIR / "storage"
HOST = "http://127.0.0.1:6333"
COLL = "mneme_p1"
TOP_K = 10
WARMUP = 50
REPEATS = 5
UPSERT_BATCH = 256
NUMBERS_OUT = HERE / ".qdrant_numbers.txt"


def load_matrix(path: Path, dim: int) -> np.ndarray:
    raw = np.fromfile(path, dtype="<f4")
    assert raw.size % dim == 0, f"{path} size {raw.size} not divisible by dim {dim}"
    return raw.reshape(-1, dim)


def percentile(samples: list[float], p: float) -> float:
    return float(np.percentile(np.asarray(samples), p))


def wait_healthy(timeout: float = 30.0) -> None:
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            r = requests.get(f"{HOST}/healthz", timeout=2)
            if r.status_code == 200:
                return
        except requests.RequestException:
            pass
        time.sleep(0.3)
    raise RuntimeError("qdrant did not become healthy in time")


def main() -> int:
    meta = json.loads((DATA / "meta.json").read_text())
    dim = meta["dim"]
    corpus = load_matrix(DATA / "corpus_f32.bin", dim)
    queries = load_matrix(DATA / "queries_f32.bin", dim)
    print(f"corpus={corpus.shape} queries={queries.shape} dim={dim}", flush=True)

    if not QBIN.exists():
        print(f"FATAL: qdrant binary missing at {QBIN}", file=sys.stderr)
        return 1

    # fresh storage each run (deterministic)
    if STORAGE.exists():
        shutil.rmtree(STORAGE)
    STORAGE.mkdir(parents=True, exist_ok=True)

    env = dict(os.environ)
    env["QDRANT__STORAGE__STORAGE_PATH"] = str(STORAGE)
    env["QDRANT__TELEMETRY_DISABLED"] = "true"
    proc = subprocess.Popen(
        [str(QBIN)],
        cwd=str(QDIR),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        wait_healthy()
        print("qdrant healthy", flush=True)
        sess = requests.Session()

        # (re)create collection: 1024-dim cosine, on_disk originals + int8 scalar quant in RAM.
        sess.delete(f"{HOST}/collections/{COLL}", timeout=10)
        body = {
            "vectors": {"size": dim, "distance": "Cosine", "on_disk": True},
            "quantization_config": {
                "scalar": {"type": "int8", "quantile": 0.99, "always_ram": True}
            },
        }
        r = sess.put(f"{HOST}/collections/{COLL}", json=body, timeout=30)
        r.raise_for_status()

        # upsert the 10k corpus (wait=true on the last batch so the index is ready)
        n = corpus.shape[0]
        t0 = time.time()
        for start in range(0, n, UPSERT_BATCH):
            end = min(start + UPSERT_BATCH, n)
            points = [
                {"id": i, "vector": corpus[i].tolist()} for i in range(start, end)
            ]
            last = end >= n
            r = sess.put(
                f"{HOST}/collections/{COLL}/points",
                params={"wait": "true" if last else "false"},
                json={"points": points},
                timeout=120,
            )
            r.raise_for_status()
        print(f"upserted {n} points in {time.time() - t0:.1f}s", flush=True)

        # let the HNSW index settle
        time.sleep(2.0)

        def search(qvec: np.ndarray) -> list[int]:
            payload = {"vector": qvec.tolist(), "limit": TOP_K, "with_payload": False}
            rr = sess.post(
                f"{HOST}/collections/{COLL}/points/search", json=payload, timeout=30
            )
            rr.raise_for_status()
            return [p["id"] for p in rr.json()["result"]]

        # warmup
        for i in range(min(WARMUP, queries.shape[0])):
            search(queries[i])

        # timed: per-query REST latency, REPEATS passes (same schedule as mneme bench)
        samples: list[float] = []
        for _ in range(REPEATS):
            for i in range(queries.shape[0]):
                t = time.time()
                _ = search(queries[i])
                samples.append((time.time() - t) * 1000.0)

        p50 = percentile(samples, 50)
        p90 = percentile(samples, 90)
        mean = float(np.mean(samples))

        # recall@10 vs exact f32 oracle (numpy brute force)
        sims = corpus @ queries.T  # (n_corpus, n_query)
        overlap = 0
        denom = 0
        for qi in range(queries.shape[0]):
            exact = set(np.argsort(-sims[:, qi])[:TOP_K].tolist())
            got = set(search(queries[qi]))
            overlap += len(exact & got)
            denom += TOP_K
        recall = overlap / denom

        NUMBERS_OUT.write_text(
            f"qdrant_rest_p50_ms={p50:.4f}\n"
            f"qdrant_rest_p90_ms={p90:.4f}\n"
            f"qdrant_rest_mean_ms={mean:.4f}\n"
            f"qdrant_recall_at_k={recall:.4f}\n"
            f"qdrant_n_corpus={n}\n"
            f"qdrant_n_query={queries.shape[0]}\n"
            f"qdrant_version=1.18.2\n"
        )
        print(
            f"DONE qdrant_rest_p50_ms={p50:.4f} p90={p90:.4f} mean={mean:.4f} "
            f"recall@{TOP_K}={recall:.4f}",
            flush=True,
        )
        print(f"wrote {NUMBERS_OUT}")
        return 0
    finally:
        proc.send_signal(signal.SIGINT)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
