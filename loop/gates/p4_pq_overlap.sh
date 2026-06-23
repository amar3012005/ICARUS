#!/usr/bin/env bash
# P4 gate: PQ recall@10 overlap > 96% vs float32 ground truth.
# (Drift-detect + no-inline-retrain is proven by `cargo test pq_drift_detect`
#  in the GATE_CMD[P4] chain — kill-condition #2.)
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"
overlap="$(read_num pq_recall10_overlap_pct)"
assert_gt "$overlap" "96.0" "PQ recall@10 overlap > 96% vs float32"
echo "P4 gate PASS"
