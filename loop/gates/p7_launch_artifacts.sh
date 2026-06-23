#!/usr/bin/env bash
# P7 / terminal gate: all launch artifacts recorded as STRUCTURED keys (not prose).
# Also the run-loop terminal-exit check — one source of truth for "done".
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$DIR/_lib.sh"

# arXiv submission id (basic format check), public repo URL (https), xMEM numbers.
arxiv="$(grep -E '^arxiv_submission_id=' "$RESULTS_FILE" | tail -n1 | cut -d= -f2- || true)"
repo="$(grep -E '^public_repo_url=' "$RESULTS_FILE" | tail -n1 | cut -d= -f2- || true)"
[[ "$arxiv" =~ ^[0-9]{4}\.[0-9]{4,5}$ ]] || { echo "GATE FAIL: arxiv_submission_id absent/malformed ('$arxiv')"; exit 1; }
[[ "$repo"  =~ ^https://github\.com/.+/.+ ]] || { echo "GATE FAIL: public_repo_url absent/malformed ('$repo')"; exit 1; }
have_str '^xmem_' || { echo "GATE FAIL: no xMEM benchmark numbers (xmem_*) recorded"; exit 1; }
echo "P7 launch gate PASS: arxiv=$arxiv repo=$repo xMEM recorded"
