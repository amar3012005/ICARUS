#!/usr/bin/env python3
"""
P3 quality reference: Qdrant **float32** (no quantization) HNSW recall@10 vs the exact
float32 brute-force ground truth, on the 100%-real bge-m3 10k corpus. This is the baseline the
mneme int8 HNSW must stay within 3% of (P3 gate `recall10_quality_loss_pct`).

Prints qdrant_f32_recall10 and writes it to bench/.qdrant_quality.txt.

Run: PYTHONNOUSERSITE=1 PYTHONPATH="" bench/.venv/bin/python bench/quality_vs_qdrant.py
"""
from __future__ import annotations

import json
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
QBIN = HERE / "qdrant" / "qdrant"
STORAGE = HERE / "qdrant" / "storage_q"
HOST = "http://127.0.0.1:6333"
COLL = "mneme_p3_quality"
import sys as _sys
TOP_K = int(_sys.argv[1]) if len(_sys.argv)>1 else 10


def load(path: Path, dim: int) -> np.ndarray:
    return np.fromfile(path, dtype="<f4").reshape(-1, dim)


def wait_healthy(t=30.0):
    t0 = time.time()
    while time.time() - t0 < t:
        try:
            if requests.get(f"{HOST}/healthz", timeout=2).status_code == 200:
                return
        except requests.RequestException:
            pass
        time.sleep(0.3)
    raise RuntimeError("qdrant not healthy")


def main() -> int:
    meta = json.loads((DATA / "meta.json").read_text())
    dim = meta["dim"]
    corpus = load(DATA / "corpus_f32.bin", dim)
    queries = load(DATA / "queries_f32.bin", dim)

    # exact float32 ground truth (numpy brute force).
    sims = corpus @ queries.T  # (n_corpus, n_query)
    exact = [set(np.argsort(-sims[:, qi])[:TOP_K].tolist()) for qi in range(queries.shape[0])]

    if STORAGE.exists():
        shutil.rmtree(STORAGE)
    STORAGE.mkdir(parents=True, exist_ok=True)
    env = {"QDRANT__STORAGE__STORAGE_PATH": str(STORAGE), "QDRANT__TELEMETRY_DISABLED": "true",
           "PATH": "/usr/bin:/bin"}
    proc = subprocess.Popen([str(QBIN)], cwd=str(QBIN.parent), env={**env},
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_healthy()
        s = requests.Session()
        s.delete(f"{HOST}/collections/{COLL}", timeout=10)
        # pure float32 HNSW: no quantization, vectors in RAM.
        body = {"vectors": {"size": dim, "distance": "Cosine", "on_disk": False}}
        s.put(f"{HOST}/collections/{COLL}", json=body, timeout=30).raise_for_status()
        n = corpus.shape[0]
        for start in range(0, n, 256):
            end = min(start + 256, n)
            pts = [{"id": i, "vector": corpus[i].tolist()} for i in range(start, end)]
            s.put(f"{HOST}/collections/{COLL}/points",
                  params={"wait": "true" if end >= n else "false"},
                  json={"points": pts}, timeout=120).raise_for_status()
        time.sleep(2.0)

        overlap = 0
        for qi in range(queries.shape[0]):
            r = s.post(f"{HOST}/collections/{COLL}/points/search",
                       json={"vector": queries[qi].tolist(), "limit": TOP_K}, timeout=30)
            got = {p["id"] for p in r.json()["result"]}
            overlap += len(exact[qi] & got)
        recall = overlap / (queries.shape[0] * TOP_K)
        (HERE / ".qdrant_quality.txt").write_text(f"qdrant_f32_recall10={recall:.4f}\n")
        print(f"qdrant_f32_recall10={recall:.4f}")
        return 0
    finally:
        proc.send_signal(signal.SIGINT)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
