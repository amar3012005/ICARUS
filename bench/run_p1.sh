#!/usr/bin/env bash
# =============================================================================
# mneme P1 benchmark orchestrator.
#
# Runs BOTH sides of the proof-of-physics race on the SAME real bge-m3 vectors:
#   1. Qdrant 1.18.2 REST baseline   (bench/qdrant_bench.py -> .qdrant_numbers.txt)
#   2. mneme int8 mmap brute scan    (cargo run -p mneme-probe --bin mneme-bench)
# then appends both p50 numbers to bench/RESULTS.md (with the producing git sha) and
# runs the P1 gate (loop/gates/p1_beats_qdrant.sh).
#
# The numbers are produced by real runs; the gate, not this script, decides pass.
#
# Run:  bash bench/run_p1.sh
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DATA="$HERE/data"
VENV="$HERE/.venv/bin/python"
RESULTS="$HERE/RESULTS.md"
GATE="$ROOT/loop/gates/p1_beats_qdrant.sh"

[ -f "$DATA/corpus_f32.bin" ] || { echo "FATAL: $DATA/corpus_f32.bin missing — run gen_vectors.py first" >&2; exit 1; }
[ -f "$DATA/meta.json" ] || { echo "FATAL: meta.json missing" >&2; exit 1; }

DIM="$("$VENV" -c "import json;print(json.load(open('$DATA/meta.json'))['dim'])")"
TOPK=10
SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)"
echo "P1 bench: dim=$DIM top_k=$TOPK sha=$SHA"

# ---- 1. Qdrant baseline -----------------------------------------------------
echo "=== Qdrant REST baseline ==="
PYTHONNOUSERSITE=1 PYTHONPATH="" LITELLM_API_KEY="${LITELLM_API_KEY:-}" "$VENV" "$HERE/qdrant_bench.py"
QNUM="$HERE/.qdrant_numbers.txt"
[ -f "$QNUM" ] || { echo "FATAL: qdrant numbers not produced" >&2; exit 1; }
QP50="$(grep '^qdrant_rest_p50_ms=' "$QNUM" | cut -d= -f2)"
QREC="$(grep '^qdrant_recall_at_k=' "$QNUM" | cut -d= -f2)"

# ---- 2. mneme int8 scan -----------------------------------------------------
echo "=== mneme int8 mmap scan ==="
( cd "$ROOT/crate" && cargo build --release -q --bin mneme-bench )
MOUT="$("$ROOT/crate/target/release/mneme-bench" "$DATA/corpus_f32.bin" "$DATA/queries_f32.bin" "$DIM" "$TOPK")"
echo "$MOUT"
MP50="$(echo "$MOUT" | grep '^mneme_scan_p50_ms=' | cut -d= -f2)"
MREC="$(echo "$MOUT" | grep '^mneme_recall_at_k=' | cut -d= -f2)"

# ---- 3. Write the gate numbers (append-only) --------------------------------
{
  echo "mneme_scan_p50_ms=$MP50"
  echo "qdrant_rest_p50_ms=$QP50"
} >> "$RESULTS"
{
  echo ""
  echo "## P1 run $(date -u +%FT%TZ) sha=$SHA"
  echo "- vectors: real bge-m3 (blaiq), dim=$DIM, 10k corpus / 200 queries (LongMemEval)"
  echo "- mneme_scan_p50_ms=$MP50  (int8 mmap brute scan, recall@$TOPK=$MREC)"
  echo "- qdrant_rest_p50_ms=$QP50  (Qdrant 1.18.2 REST, int8 quant, recall@$TOPK=$QREC)"
} >> "$RESULTS"

echo "=== P1 GATE ==="
bash "$GATE"
