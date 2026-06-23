#!/usr/bin/env bash
# P5 gate: bi-temporal + 2-hop adjacency BFS from ONE mmap, p50 < 8ms @1M.
# (Miri UB-freedom is proven by the miri run in the GATE_CMD[P5] chain.)
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"
lat="$(read_num bitemporal_2hop_p50_ms)"
assert_lt "$lat" "8.0" "bi-temporal 2-hop p50 < 8ms @1M"
echo "P5 gate PASS"
