#!/usr/bin/env bash
# P6 gate: HIVEMIND eval-harness on the mneme-backed indexer.js >= Qdrant baseline.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"
mneme="$(read_num mneme_eval_score)"
qdrant="$(read_num qdrant_eval_score)"
awk -v a="$mneme" -v b="$qdrant" 'BEGIN{ exit !(a>=b) }' \
  || { echo "GATE FAIL: mneme eval $mneme < Qdrant baseline $qdrant"; exit 1; }
echo "P6 eval gate PASS: mneme $mneme >= Qdrant $qdrant"
