#!/usr/bin/env bash
# P0 gate: SPEC.md frozen, versioned, reviewed by a HUMAN, and no code yet.
# The human-freeze is enforced two ways the loop agent cannot satisfy alone:
#   1. loop/APPROVALS/p0.freeze must exist (a human touches it out of band).
#   2. the commit that set Frozen:YES must NOT be authored by the loop identity.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"
cd "$MNEME_ROOT"

grep -qE '^\|?[[:space:]]*Frozen[[:space:]]*\|?[[:space:]]*YES' SPEC.md || { echo "GATE FAIL: SPEC not frozen"; exit 1; }
grep -qE 'FORMAT_VERSION|Format version' SPEC.md || { echo "GATE FAIL: no FORMAT_VERSION"; exit 1; }
grep -qE '^\|?[[:space:]]*Reviewed by[[:space:]]*\|?[[:space:]]*[^—|[:space:]]' SPEC.md || { echo "GATE FAIL: no reviewer"; exit 1; }

# Human-only approval token (agent is forbidden to create this).
[ -f loop/APPROVALS/p0.freeze ] || { echo "GATE FAIL: loop/APPROVALS/p0.freeze missing — awaiting human freeze"; exit 1; }

# The freeze must be signed by a non-loop identity.
LOOP_ID="amarsai3012005@users.noreply.github.com"
last_author="$(git log -1 --format='%ae' -- SPEC.md 2>/dev/null || echo unknown)"
if [ "$last_author" = "$LOOP_ID" ]; then
  echo "GATE FAIL: SPEC.md last touched by the loop identity ($last_author) — freeze must be human-signed"; exit 1
fi

# Spec-before-code: zero Rust sources may exist at P0 freeze.
if find crate -name '*.rs' 2>/dev/null | grep -q .; then echo "GATE FAIL: Rust code exists before freeze"; exit 1; fi

echo "P0 gate PASS: SPEC frozen+versioned+human-reviewed, no code yet"
