#!/usr/bin/env bash
# P6 gate: a COMPLETED 72h soak — full duration, zero crashes, no RSS leak,
# p99 recall never breached 5ms. A soak still running is a fail.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"
hours="$(read_num soak_hours_completed)"
crashes="$(read_num soak_crashes)"
rss_growth="$(read_num soak_rss_growth_pct)"
p99="$(read_num soak_recall_p99_ms)"
assert_gt "$hours"      "71.9" "soak ran a full 72h"
awk -v c="$crashes" 'BEGIN{ exit !(c==0) }' || { echo "GATE FAIL: soak crashes=$crashes"; exit 1; }
assert_lt "$rss_growth" "5.0"  "soak RSS growth < 5% (no leak)"
assert_lt "$p99"        "5.0"  "soak recall p99 < 5ms throughout"
echo "P6 soak gate PASS"
