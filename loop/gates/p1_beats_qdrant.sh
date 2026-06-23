#!/usr/bin/env bash
# P1 gate: brute-force int8 scan p50 < Qdrant REST p50 at N=10k on REAL memories.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"
mneme="$(read_num mneme_scan_p50_ms)"
qdrant="$(read_num qdrant_rest_p50_ms)"
assert_lt "$mneme" "$qdrant" "mneme scan p50 beats Qdrant REST p50 @10k"
echo "P1 gate PASS"
