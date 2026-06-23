#!/usr/bin/env bash
# Shared gate helpers. Source this from every loop/gates/*.sh.
# Single source of truth for number extraction + comparison so no gate
# re-implements parsing (DRY — the dup gate would flag copies).
set -euo pipefail

GATES_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MNEME_ROOT="$(cd "$GATES_LIB_DIR/../.." && pwd)"
RESULTS_FILE="$MNEME_ROOT/bench/RESULTS.md"

# read_num KEY [FILE] -> echoes the number for `KEY=<n>` ; exits 1 if ABSENT.
# A missing number is ALWAYS a fail, never a pass.
read_num() {
  local key="$1" file="${2:-$RESULTS_FILE}" line val
  [ -f "$file" ] || { echo "GATE FAIL: $file missing (cannot read $key)" >&2; exit 1; }
  line="$(grep -E "^${key}=" "$file" | tail -n1 || true)"
  [ -n "$line" ] || { echo "GATE FAIL: number '$key' absent from $file" >&2; exit 1; }
  val="${line#*=}"
  [[ "$val" =~ ^-?[0-9]+(\.[0-9]+)?$ ]] || { echo "GATE FAIL: '$key'='$val' is not numeric" >&2; exit 1; }
  printf '%s' "$val"
}

# assert_lt A B MSG  -> exit 1 unless A < B   (float-aware via awk)
assert_lt() { awk -v a="$1" -v b="$2" 'BEGIN{ exit !(a<b) }' || { echo "GATE FAIL: $3 ($1 !< $2)" >&2; exit 1; }; echo "ok: $3 ($1 < $2)"; }
assert_gt() { awk -v a="$1" -v b="$2" 'BEGIN{ exit !(a>b) }' || { echo "GATE FAIL: $3 ($1 !> $2)" >&2; exit 1; }; echo "ok: $3 ($1 > $2)"; }

have_str() { grep -qE "$1" "${2:-$RESULTS_FILE}" 2>/dev/null; }
