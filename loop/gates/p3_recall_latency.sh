#!/usr/bin/env bash
# P3 gate: recall@10 p50 < 5ms @1M AND quality loss < 3% vs Qdrant float32.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"
lat="$(read_num recall10_p50_ms)"
loss="$(read_num recall10_quality_loss_pct)"
assert_lt "$lat"  "5.0" "recall@10 p50 < 5ms @1M"
assert_lt "$loss" "3.0" "recall@10 quality loss < 3% vs Qdrant float32"
echo "P3 gate PASS"
