#!/usr/bin/env bash
# Kill-condition #1: the append/write path must NOT reach index rebuild/retrain.
# Fails closed: if the append module does not exist where expected, that is a
# fail (a gate that silently finds nothing is a false pass — red-team CRITICAL).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"
cd "$MNEME_ROOT"

APPEND_SRC="$(find crate -path '*mseg/append.rs' -o -name 'append.rs' 2>/dev/null | head -n1)"
[ -n "$APPEND_SRC" ] && [ -f "$APPEND_SRC" ] || { echo "GATE FAIL: append module not found under crate/ (cannot prove isolation)"; exit 1; }

if grep -qE 'rebuild_hnsw|retrain_codebook' "$APPEND_SRC"; then
  echo "GATE FAIL: KILL-COND #1 — append path ($APPEND_SRC) references index rebuild/retrain"; exit 1
fi
have_str '^append_p99_under_concurrent_rebuild=' || { echo "GATE FAIL: missing concurrent-rebuild bench number"; exit 1; }
echo "write-path isolation gate PASS"
