#!/usr/bin/env bash
# =============================================================================
# mneme/loop/run-loop.sh — autonomous two-tier phase-gate orchestrator
#
# Drives an unattended Claude Code agent through the mneme P0..P7 build.
#   OUTER tier: walk the phase DAG; advance ONLY when a phase milestone gate
#               (loop/PHASE_GATES.md → GATE_CMD[Pn]) exits 0.
#   INNER tier: per work-unit run recon→implement→review→verify, run the FULL
#               always-on gate stack, the SCRIPT marks [x] (never the agent),
#               one unit = one commit, loop.
#
# Design contract (every line below is here to satisfy it):
#   - The gates are the truth. The agent's self-report is never trusted.
#   - The agent NEVER advances state. Only this script flips [ ]→[x], bumps the
#     phase, and resets caps — and only after a machine gate proves the artifact.
#   - Forward progress is mechanically required: if a "successful" iteration did
#     not actually shrink the open-unit queue, that is a no-progress event and is
#     capped. Three independent caps (iter, gate-failures, no-progress) + a
#     human-gate state guarantee the loop converges or parks — it cannot spin.
#   - State lives outside context (STATE.json/GOALS.md/PROGRESS.md/NOTES.md/git)
#     so the loop survives context compaction. Every agent turn is re-hydrated
#     with the full durable cursor.
#
# Reuses the existing HIVEMIND Stop-hook loop pattern (state-outside-context,
# verify-before-ship, idempotency, cheap honest verification) — see
# /Users/amar/HIVE-MIND/.claude/loop/LOOP.md. Do not reinvent those mechanisms.
#
# Run from anywhere:  bash /path/to/mneme/loop/run-loop.sh
# Pause:  touch <mneme>/loop/PAUSE      Resume:  rm <mneme>/loop/PAUSE
# Clear a park: fix the cause, set STATE.blocked=false (and awaiting_human=null).
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# 0. Locate ourselves from $BASH_SOURCE so the loop is CWD-independent (it runs
#    unattended from launchd/cron). REPO_ROOT = the mneme project root.
# -----------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

LOOP_DIR="$REPO_ROOT/loop"
PROMPTS_DIR="$LOOP_DIR/prompts"
GATES_DIR="$LOOP_DIR/gates"
APPROVALS_DIR="$LOOP_DIR/APPROVALS"
STATE="$LOOP_DIR/STATE.json"
GOALS="$LOOP_DIR/GOALS.md"
NOTES="$LOOP_DIR/NOTES.md"
PROGRESS="$LOOP_DIR/PROGRESS.md"          # FIX: canonical path is loop/PROGRESS.md (the prompts read this one)
GATES_DOC="$LOOP_DIR/PHASE_GATES.md"
RECON_FILE="$LOOP_DIR/.recon-current.md"  # recon block for the active unit → folded into the commit body
RESULTS="$REPO_ROOT/bench/RESULTS.md"
CRATE_DIR="$REPO_ROOT/crate"              # all Rust lives under crate/ (workspace); docs/loop live at root
PAUSE="$LOOP_DIR/PAUSE"
LOG_DIR="$LOOP_DIR/logs"
GIT_NAME="amarsai3012005"
GIT_EMAIL="amarsai3012005@users.noreply.github.com"

mkdir -p "$LOG_DIR" "$REPO_ROOT/bench" "$APPROVALS_DIR"
RUN_LOG="$LOG_DIR/run-$(date +%Y%m%d-%H%M%S).log"

# Mandatory tools. A missing declared-mandatory tool is a HARD STOP, never a
# silent skip (red-team: a missing linter must not become a silent pass).
REQUIRED_BINS=(jq cargo claude git rg)
# Gate tools that may be absent before their phase installs them. When a unit is
# at/after the phase that needs one, absence PARKS (it does not skip).
OPTIONAL_GATE_BINS=(cargo-llvm-cov cargo-machete similarity-rs gitleaks critcmp)

# -----------------------------------------------------------------------------
# 1. Logging. Timestamped + tagged, to a run log AND stdout. No bare echoes.
# -----------------------------------------------------------------------------
log() { printf '%s [%s] %s\n' "$(date -u +%FT%TZ)" "$1" "${*:2}" | tee -a "$RUN_LOG" >&2; }

# -----------------------------------------------------------------------------
# 2. Typed, validated state accessors. STATE.json is the single source of
#    runaway/dedup/human-gate truth, so a corrupt write must never silently
#    disable a cap (red-team HIGH). Numbers are asserted integer; strings are
#    always stored as JSON strings (never coerced via fromjson); every write is
#    validated with `jq empty`; numeric reads fail closed.
# -----------------------------------------------------------------------------
_state_write() {                          # internal: atomic write + validate
  local tmp; tmp="$(mktemp)"
  cat > "$tmp"
  jq empty "$tmp" 2>/dev/null || { rm -f "$tmp"; log FATAL "STATE.json write would corrupt JSON"; exit 1; }
  mv "$tmp" "$STATE"
}
state_get() { jq -r ".$1" "$STATE"; }
state_get_num() {                         # fail closed: null/non-int → park for inspection
  local v; v="$(jq -r ".$1" "$STATE")"
  if ! [[ "$v" =~ ^-?[0-9]+$ ]]; then
    log FATAL "state key '$1' is not an integer (='$v') — refusing to compare"
    state_set_str blocked_reason "corrupt numeric state key $1=$v"; _flag_blocked
    exit 2
  fi
  printf '%s' "$v"
}
state_set_num() {                         # value MUST be an integer
  local key="$1" val="$2"
  [[ "$val" =~ ^-?[0-9]+$ ]] || { log FATAL "state_set_num $key got non-int '$val'"; exit 1; }
  jq --argjson v "$val" ".$key = \$v" "$STATE" | _state_write
}
state_set_str() {                         # always stored as a JSON string
  local key="$1" val="$2"
  jq --arg v "$val" ".$key = \$v" "$STATE" | _state_write
}
state_set_bool() {
  local key="$1" val="$2"                 # "true"/"false"
  jq --argjson v "$val" ".$key = \$v" "$STATE" | _state_write
}
state_set_null() { jq ".$1 = null" "$STATE" | _state_write; }
_flag_blocked() { jq '.blocked = true' "$STATE" | _state_write; }

# -----------------------------------------------------------------------------
# 3. Park / human-gate / pause. The ONLY non-terminal exits. A park sets
#    blocked=true + a reason and stops for a human (exit 2). A human-gate is a
#    DISTINCT stop that does NOT consume any failure cap (red-team CRITICAL:
#    waiting on a human signature must not look like a runaway).
# -----------------------------------------------------------------------------
park() {
  local reason="$1"
  state_set_bool blocked true
  state_set_str blocked_reason "$reason"
  log BLOCK "PARKED for human: $reason"
  exit 2
}
await_human() {
  local what="$1" how="$2"
  state_set_str awaiting_human "$what"
  log HUMAN "AWAITING HUMAN: $what"
  log HUMAN "TO PROCEED: $how"
  exit 3                                  # distinct exit code; not a failure, not done
}
check_pause() { [ -f "$PAUSE" ] && { log PAUSE "PAUSE present — halting (rm $PAUSE to resume)"; exit 0; }; }

# -----------------------------------------------------------------------------
# 4. Preflight. Fail fast and LOUD listing every missing dependency/path before
#    the loop runs a single iteration (red-team CRITICAL: the loop must not
#    discover missing files mid-flight and burn caps on them).
# -----------------------------------------------------------------------------
preflight() {
  local missing=0
  for bin in "${REQUIRED_BINS[@]}"; do
    command -v "$bin" >/dev/null 2>&1 || { log FATAL "required tool not on PATH: $bin"; missing=1; }
  done
  for f in "$STATE" "$GATES_DOC" "$GOALS"; do
    [ -f "$f" ] || { log FATAL "missing required file: $f"; missing=1; }
  done
  [ -d "$PROMPTS_DIR" ] || { log FATAL "missing prompts dir: $PROMPTS_DIR"; missing=1; }
  [ -d "$GATES_DIR" ]   || { log FATAL "missing gates dir: $GATES_DIR"; missing=1; }
  for p in recon implement review verify; do
    [ -f "$PROMPTS_DIR/$p.md" ] || { log FATAL "missing prompt: $PROMPTS_DIR/$p.md"; missing=1; }
  done
  jq empty "$STATE" 2>/dev/null || { log FATAL "STATE.json is not valid JSON"; missing=1; }
  [ "$missing" -eq 0 ] || { log FATAL "preflight failed — fix the above before running"; exit 1; }
  touch "$NOTES" "$PROGRESS"
  log RUN "preflight OK"
}

# -----------------------------------------------------------------------------
# 5. The Claude invocation. Composes: stage prompt + the FULL durable cursor
#    (STATE.json + PROGRESS CURRENT block + recent git log + GOALS + NOTES) so
#    every turn self-rehydrates after compaction (red-team MEDIUM). We do NOT
#    trust its exit code for code stages (gates are the truth); but turns whose
#    REQUIRED side effect is a file mutation are checked by run_claude_mutating.
# -----------------------------------------------------------------------------
_compose() {
  local prompt_file="$1" extra="${2:-}"
  cat "$prompt_file"
  printf '\n\n---\n## DURABLE CURSOR (rehydrate from this — do not trust memory)\n'
  printf '### STATE.json\n```json\n'; cat "$STATE"; printf '\n```\n'
  printf '### PROGRESS.md (current cursor)\n'; sed -n '1,40p' "$PROGRESS" 2>/dev/null || true
  printf '\n### recent commits\n```\n'; git -C "$REPO_ROOT" log --oneline -10 2>/dev/null || true; printf '\n```\n'
  printf '### GOALS.md\n'; cat "$GOALS" 2>/dev/null || true
  printf '\n### NOTES.md (prior findings)\n'; cat "$NOTES" 2>/dev/null || true
  printf '\n### EXTRA\n%s\n' "$extra"
}
run_claude() {
  local prompt_file="$1" extra="${2:-}"
  [ -f "$prompt_file" ] || park "missing prompt file $prompt_file"
  log CLAUDE "invoke $(basename "$prompt_file") (phase=$(state_get phase) task=$(state_get task))"
  _compose "$prompt_file" "$extra" | claude -p --dangerously-skip-permissions 2>&1 | tee -a "$RUN_LOG" || \
    log WARN "claude -p exited non-zero (code stages: gates are the truth)"
}
# A turn that MUST mutate a file. Hash target before/after; "no change" is a
# no-op turn → increment noop_turns, park at the cap (red-team HIGH: silent
# abandonment via repeated no-op agent turns).
run_claude_mutating() {
  local prompt_file="$1" target="$2" extra="${3:-}" before after
  before="$( [ -f "$target" ] && shasum "$target" | cut -d' ' -f1 || echo absent )"
  run_claude "$prompt_file" "$extra"
  after="$( [ -f "$target" ] && shasum "$target" | cut -d' ' -f1 || echo absent )"
  if [ "$before" = "$after" ]; then
    state_set_num noop_turns "$(( $(state_get_num noop_turns) + 1 ))"
    log WARN "no-op turn: $(basename "$prompt_file") did not change $(basename "$target") (noop_turns=$(state_get_num noop_turns))"
    [ "$(state_get_num noop_turns)" -ge "$(state_get_num max_noop_turns)" ] && \
      park "agent produced $(state_get_num noop_turns) consecutive no-op turns on $(basename "$target")"
    return 1
  fi
  state_set_num noop_turns 0
  return 0
}

# -----------------------------------------------------------------------------
# 6. The always-on gate stack. Every unit must pass ALL of these before [x]
#    (red-team CRITICAL: the anti-dup/anti-deadcode/coverage/secret gates were
#    documented but NEVER wired — they are wired here). Each tool is guarded:
#    if a tool that is mandatory at the current phase is absent, PARK.
# -----------------------------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }
need() { have "$1" || park "required gate tool '$1' not installed at phase $(state_get phase) — install it (cargo install $1) and clear the park"; }

# Cargo gates are N/A before the crate exists (P0 is docs-only). Once we are at
# P2+ a Cargo manifest MUST exist or we park (no silent skip).
crate_exists() { [ -f "$CRATE_DIR/Cargo.toml" ] || [ -f "$REPO_ROOT/Cargo.toml" ]; }
phase_num() { state_get phase | tr -dc '0-9'; }

gate_fmt()      { log GATE fmt;      cargo fmt --all -- --check; }
gate_clippy()   { log GATE clippy;   cargo clippy --all-targets --all-features -- -D warnings; }
gate_test()     { log GATE test;     cargo test --all-features; }
gate_coverage() { need cargo-llvm-cov; log GATE coverage; cargo llvm-cov --fail-under-lines 80; }
gate_machete()  { need cargo-machete; log GATE machete;  cargo machete; }
gate_dup()      { need similarity-rs; log GATE dup;      similarity-rs --threshold 0.85 "$CRATE_DIR/src" 2>/dev/null || similarity-rs --threshold 0.85 "$CRATE_DIR"; }
gate_debug()    { log GATE no-debug; ! grep -rnE 'println!|eprintln!|dbg!' "$CRATE_DIR" --include='*.rs' 2>/dev/null | grep -v 'cfg(test)' | grep -q . ; }
gate_unsafe()   { log GATE unsafe; ! grep -rL 'forbid(unsafe_code)' "$CRATE_DIR" --include='*.rs' 2>/dev/null | grep -vE '/(mmap|unsafe)[^/]*\.rs$' | grep -q . ; }
gate_secrets()  { need gitleaks;    log GATE secrets;    gitleaks detect --no-git --redact --source "$REPO_ROOT"; }
# Bench regression: distinguish "no bench" (ok) from "bench regressed" (block).
gate_bench_no_regress() {
  [ "$(phase_num)" -lt 2 ] && return 0    # perf gating starts at P2
  have critcmp || { log WARN "critcmp absent — bench-no-regress skipped (install at P2)"; return 0; }
  local base="$LOG_DIR/bench-baseline.json"
  [ -f "$base" ] || { log INFO "no bench baseline yet — recording, not gating"; return 0; }
  log GATE bench-no-regress
  critcmp --threshold 5 "$base" <(cargo bench --no-fail-fast -- --save-baseline pr 2>/dev/null; echo) || return 1
}
# recon-before-write: any NEW crate source file >30 LOC in the staged diff must
# be backed by a RECON block in the recon file (red-team HIGH: recon unenforceable).
gate_recon() {
  local newbig
  newbig="$(git -C "$REPO_ROOT" diff --cached --name-only --diff-filter=A 2>/dev/null | grep -E '^crate/.*\.rs$' || true)"
  [ -z "$newbig" ] && return 0
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    local loc; loc="$(git -C "$REPO_ROOT" show ":$f" 2>/dev/null | wc -l | tr -d ' ')"
    if [ "${loc:-0}" -gt 30 ]; then
      grep -qE '^RECON:' "$RECON_FILE" 2>/dev/null || { log GATE "recon-block MISSING for new file $f ($loc LOC)"; return 1; }
    fi
  done <<< "$newbig"
  return 0
}
# Meta-gate: forbid editing a phase gate script in the same commit as the code it
# gates (red-team MEDIUM: no editing the exam during the test).
gate_no_exam_tampering() {
  local staged; staged="$(git -C "$REPO_ROOT" diff --cached --name-only 2>/dev/null || true)"
  if grep -q '^loop/gates/' <<< "$staged" && grep -qE '^crate/' <<< "$staged"; then
    log GATE "exam-tampering: gate script and gated code modified in the same commit"
    return 1
  fi
  return 0
}

run_inner_gates() {
  # Non-cargo gates always apply (catch secrets/debug-noise even in docs phases).
  gate_no_exam_tampering || return 1
  if ! crate_exists; then
    if [ "$(phase_num)" -ge 2 ]; then park "phase $(state_get phase) but no Cargo manifest exists — crate must exist by P2"; fi
    log INFO "no crate yet (P$(phase_num) docs/spec phase) — cargo gates N/A this unit"
    return 0
  fi
  gate_fmt && gate_clippy && gate_test && gate_coverage \
    && gate_machete && gate_dup && gate_debug && gate_unsafe \
    && gate_recon && gate_secrets && gate_bench_no_regress
}

# -----------------------------------------------------------------------------
# 7. Verify with auto-fix. On RED, route by failing class: a test/logic failure
#    goes to implement.md (re-implement to green); a style/dup/lint failure goes
#    to review.md. Guard against the agent deleting a failing test to "go green":
#    snapshot the acceptance-test name list before/after and reject if any named
#    test disappeared (red-team HIGH). Detect flaky tests by isolated re-run.
# -----------------------------------------------------------------------------
_test_list() { crate_exists && cargo test --all-features -- --list 2>/dev/null | sort || true; }
verify_with_autofix() {
  local max_fix=3 attempt=0 failout before_tests after_tests
  before_tests="$(_test_list)"
  while :; do
    if failout="$(run_inner_gates 2>&1 | tee -a "$RUN_LOG")"; then
      after_tests="$(_test_list)"
      # Test-deletion guard: a named test that existed must not have vanished.
      if [ -n "$before_tests" ] && [ -n "$after_tests" ]; then
        local gone; gone="$(comm -23 <(printf '%s\n' "$before_tests") <(printf '%s\n' "$after_tests") || true)"
        [ -n "$gone" ] && park "autofix removed test(s) to go green: $gone"
      fi
      log GATE "all inner gates GREEN"; return 0
    fi
    attempt=$((attempt + 1))
    state_set_num iter "$(( $(state_get_num iter) + 1 ))"
    [ "$(state_get_num iter)" -ge "$(state_get_num max_iter)" ] && park "inner max_iter hit during autofix"
    [ "$attempt" -ge "$max_fix" ] && return 1
    # Route the fix by failure class.
    local tail120; tail120="$(tail -n 120 "$RUN_LOG")"
    if grep -qiE 'test result: FAILED|assertion|panicked|left ==|right ==' <<< "$tail120"; then
      log WARN "RED=logic/test (fix attempt $attempt/$max_fix) → implement.md"
      run_claude "$PROMPTS_DIR/implement.md" "GATE RED — a test/logic check failed. Re-implement to green WITHOUT deleting or weakening any acceptance test. Failing output:
$tail120"
    else
      log WARN "RED=style/dup/lint (fix attempt $attempt/$max_fix) → review.md"
      run_claude "$PROMPTS_DIR/review.md" "GATE RED — fmt/clippy/dup/coverage/secret/debug failure. Fix it (do not touch acceptance tests). Failing output:
$tail120"
    fi
  done
}

# -----------------------------------------------------------------------------
# 8. Idempotent commit. One unit = one commit. Commit TYPE is derived from the
#    unit text (fix:/refactor:/feat:) so the bugfix-has-test gate can fire
#    (red-team HIGH). The RECON block is folded into the commit body so the
#    recon-block requirement is satisfiable and auditable. Fixed author identity.
# -----------------------------------------------------------------------------
commit_unit() {
  local unit_text="$1" type="feat"
  case "$unit_text" in
    *fix:*|*bug*|*regression*) type="fix";;
    *refactor:*|*rename*|*extract*) type="refactor";;
    *doc:*|*spec*|*README*) type="docs";;
  esac
  if git -C "$REPO_ROOT" diff --quiet && git -C "$REPO_ROOT" diff --cached --quiet; then
    log SHIP "working tree clean — nothing to commit (idempotent skip)"; return 0
  fi
  git -C "$REPO_ROOT" add -A
  local subj body; subj="$type($(state_get phase)): $(printf '%s' "$unit_text" | sed -E 's/^- \[[ ~x]\] //' | cut -c1-60)"
  body="$( [ -f "$RECON_FILE" ] && cat "$RECON_FILE" || echo 'RECON: (none recorded)' )"
  git -C "$REPO_ROOT" -c user.name="$GIT_NAME" -c user.email="$GIT_EMAIL" commit -m "$subj" -m "$body" >/dev/null
  local sha; sha="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  state_set_str last_shipped_sha "$sha"
  : > "$RECON_FILE"                       # consume the recon block
  log SHIP "committed $sha — $subj"
}

# -----------------------------------------------------------------------------
# 9. PROGRESS cursor stamp. Append to loop/PROGRESS.md (the file the prompts and
#    bootstrap actually read).
# -----------------------------------------------------------------------------
update_progress() {
  printf '\n- `%s` — phase=%s task=%s sha=%s\n' \
    "$(date +%F)" "$(state_get phase)" "$(state_get task)" "$(state_get last_shipped_sha)" >> "$PROGRESS"
  log PROGRESS "stamped phase=$(state_get phase) task=$(state_get task)"
}

# -----------------------------------------------------------------------------
# 10. Unit selection + SCRIPT-controlled completion. The agent NEVER writes [x].
#     We select the first open unit, run the pipeline, gate it, and only THEN
#     the script flips that exact line to [x] via sed (red-team CRITICAL).
# -----------------------------------------------------------------------------
OPEN_RE='^- \[[ ~]\] '
first_open_unit() { grep -nE "$OPEN_RE" "$GOALS" 2>/dev/null | head -n1; }   # "LINENO:- [ ] text"
mark_unit_done() {                        # $1 = line number in GOALS.md
  local ln="$1" tmp; tmp="$(mktemp)"
  awk -v n="$ln" 'NR==n{ sub(/\[[ ~]\]/, "[x]") } { print }' "$GOALS" > "$tmp" && mv "$tmp" "$GOALS"
  log UNIT "marked GOALS.md:$ln done [x]"
}
unit_hash() { printf '%s' "$1" | shasum | cut -d' ' -f1; }

# -----------------------------------------------------------------------------
# 11. Phase milestone gate. Extract GATE_CMD[Pn] from PHASE_GATES.md and run it.
#     A MISSING gate helper script is a DISTINCT park ("gate not yet authored"),
#     NOT a gate failure that consumes the runaway budget (red-team CRITICAL).
# -----------------------------------------------------------------------------
run_phase_gate() {
  local phase="$1" cmd
  cmd="$(grep -E "^GATE_CMD\[$phase\]:" "$GATES_DOC" | head -n1 | sed -E "s/^GATE_CMD\[$phase\]:[[:space:]]*//")"
  [ -n "$cmd" ] || park "no GATE_CMD[$phase] in PHASE_GATES.md"
  # If the command references a helper script that does not exist yet, that is a
  # not-yet-authored condition, not a failure.
  local scr; for scr in $(grep -oE 'loop/gates/[A-Za-z0-9_./-]+\.sh' <<< "$cmd" | sort -u); do
    [ -f "$REPO_ROOT/$scr" ] || park "phase gate references missing helper $scr — author it as a unit (distinct from gate failure)"
  done
  log GATE "phase gate $phase: $cmd"
  ( cd "$REPO_ROOT" && bash -c "$cmd" ) 2>&1 | tee -a "$RUN_LOG" && { log GATE "phase gate $phase PASSED"; return 0; }
  log GATE "phase gate $phase FAILED"; return 1
}

next_phase() {
  case "$(state_get phase)" in
    P0) echo P1;; P1) echo P2;; P2) echo P3;; P3) echo P4;;
    P4) echo P5;; P5) echo P6;; P6) echo P7;; P7) echo DONE;; *) echo UNKNOWN;;
  esac
}
advance_phase() {
  local nxt; nxt="$(next_phase)"
  [ "$nxt" = "UNKNOWN" ] && park "unknown phase $(state_get phase)"
  state_set_num phases_done "$(( $(state_get_num phases_done) + 1 ))"
  state_set_num consecutive_gate_failures 0
  state_set_num consecutive_no_progress 0
  state_set_num iter 0
  state_set_str phase "$nxt"
  state_set_str task "decompose-$nxt"
  state_set_null last_unit_hash
  log PHASE "ADVANCED to $nxt"
}

# =============================================================================
# MAIN
# =============================================================================
preflight

log RUN "mneme loop start — phase=$(state_get phase) iter=$(state_get_num iter)"

# A prior park requires a human to clear blocked=false before we run.
[ "$(state_get blocked)" = "true" ] && { log BLOCK "STATE.blocked=true: $(state_get blocked_reason) — clear it to resume"; exit 2; }

while :; do
  check_pause

  PHASE="$(state_get phase)"

  # ---- Terminal exit: P7 + the real launch-artifact gate (NOT a prose grep). ----
  if [ "$PHASE" = "P7" ] && [ -f "$GATES_DIR/p7_launch_artifacts.sh" ] \
     && bash "$GATES_DIR/p7_launch_artifacts.sh" >/dev/null 2>&1; then
    log DONE "P7 launch artifacts verified by p7_launch_artifacts.sh — PROGRAM COMPLETE"
    exit 0
  fi

  # ---- Caps: gate-failures and no-progress each independently park. ----
  [ "$(state_get_num consecutive_gate_failures)" -ge "$(state_get_num max_consecutive_gate_failures)" ] && \
    park "phase $PHASE gate failed $(state_get_num consecutive_gate_failures)x — needs a human"
  [ "$(state_get_num consecutive_no_progress)" -ge "$(state_get_num max_consecutive_no_progress)" ] && \
    park "no forward progress for $(state_get_num consecutive_no_progress) iterations on phase $PHASE — needs a human"

  # ---- No open units → decompose the phase, or run its milestone gate. ----
  if ! grep -qE "$OPEN_RE" "$GOALS" 2>/dev/null; then

    if [[ "$(state_get task)" == decompose-* ]]; then
      log PHASE "decomposing $PHASE → GOALS.md (RFC→DAG)"
      run_claude_mutating "$PROMPTS_DIR/recon.md" "$GOALS" \
        "DECOMPOSE phase $PHASE: read frozen SPEC.md + the $PHASE row of loop/PHASE_GATES.md. Append dependency-ordered work-units to loop/GOALS.md, each a checkbox line '- [ ] <id>: <scope>' followed by an indented spec block {depends_on, acceptance_tests, risk_tier, rollback}. Out-of-SPEC ideas go to FUTURE.md, never GOALS.md." || true
      # Decomposition MUST yield at least one open unit, else park (no silent fall-through).
      grep -qE "$OPEN_RE" "$GOALS" 2>/dev/null || park "decomposition of $PHASE produced no parseable '- [ ] ' units"
      state_set_str task "execute-units"
      continue
    fi

    # Decomposed and all units [x] → milestone gate.
    log PHASE "all units [x] — running $PHASE milestone gate"
    if run_phase_gate "$PHASE"; then
      advance_phase; update_progress; continue
    else
      state_set_num consecutive_gate_failures "$(( $(state_get_num consecutive_gate_failures) + 1 ))"
      log PHASE "gate miss — appending ONE narrowed recovery unit"
      run_claude_mutating "$PROMPTS_DIR/recon.md" "$GOALS" \
        "PHASE GATE $PHASE FAILED. Snapshot the failure in loop/NOTES.md, then append exactly ONE narrowed '- [ ] ' recovery unit to loop/GOALS.md that closes the exact gap. Do not expand scope." || true
      continue
    fi
  fi

  # ---- Human-gate interception: P0 freeze can only be cleared by a human. ----
  if [ "$PHASE" = "P0" ] && grep -qiE 'freeze|frozen' <<< "$(first_open_unit)"; then
    if [ ! -f "$APPROVALS_DIR/p0.freeze" ]; then
      await_human "P0 spec freeze" "review mneme/SPEC.md; if correct, set 'Frozen: YES' + 'Reviewed by: <your name>' in SPEC.md, create loop/APPROVALS/p0.freeze (touch it), commit as yourself (NOT the loop identity), then clear awaiting_human and rerun."
    fi
  fi

  # ---- Select the first open unit. Detect no-progress (same unit again). ----
  SEL="$(first_open_unit)"
  LN="${SEL%%:*}"
  UNIT="${SEL#*:}"
  H="$(unit_hash "$UNIT")"
  log UNIT "executing GOALS.md:$LN — $UNIT"

  # recon → implement(TDD) → review(de-sloppify + adversarial self-review).
  # recon.md writes the RECON block to .recon-current.md (folded into commit).
  run_claude "$PROMPTS_DIR/recon.md"     "Work the FIRST open unit (GOALS.md:$LN): $UNIT. Write your RECON: block to loop/.recon-current.md (EXISTS/PARTIAL/GAP + the crate to reuse, or 'no-reuse-found because <reason>'). Do NOT write code in this stage."
  run_claude "$PROMPTS_DIR/implement.md" "Implement the unit TDD RED→GREEN, reusing what recon chose. Never write code without a failing test first. Unit: $UNIT"
  run_claude "$PROMPTS_DIR/review.md"    "De-sloppify + adversarial self-review (kill-conditions, dup, dead code, DRY) for: $UNIT"

  # ---- Verify with auto-fix. Park if it cannot reach green honestly. ----
  if ! verify_with_autofix; then
    park "unit failed to reach green after autofix retries (GOALS.md:$LN): $UNIT"
  fi

  # ---- P6 ONLY: heavyweight live verification (eval ≥ baseline + soak). ----
  if [ "$PHASE" = "P6" ]; then
    log GATE "P6 live verify (eval ≥ Qdrant baseline + 72h soak)"
    run_claude "$PROMPTS_DIR/verify.md" "P6 live verify: deploy the napi binding into HIVEMIND core/src/ingestion/indexer.js, run the eval-harness, confirm ≥ the recorded Qdrant baseline, start/confirm the 72h soak. Record numbers in bench/RESULTS.md. The gate scripts p6_eval_ge_baseline.sh and p6_soak_72h.sh decide pass — do not assert pass yourself."
  fi

  # ---- Record bench number(s); distinguish "no bench" from "regressed". ----
  if crate_exists; then
    cargo bench --no-fail-fast 2>&1 | tee -a "$RUN_LOG" || log WARN "bench run failed/none for this unit"
  fi

  # ---- Ship one commit, then journal/memory (agent does NOT mark [x]). ----
  commit_unit "$UNIT"
  run_claude "$PROMPTS_DIR/verify.md" "Unit GREEN and committed. (1) Append a line to bench/RESULTS.md with the proven number + sha. (2) HIVEMIND memory: hivemind_ingest_code on touched files + hivemind_log_decision on any choice. (3) Append 'what worked / what failed / reusable fixtures' to loop/NOTES.md. Do NOT edit GOALS.md — the orchestrator marks [x]."

  # ---- SCRIPT marks the unit done, only now that verify+ship are proven. ----
  mark_unit_done "$LN"

  # ---- Forward-progress check: the queue MUST have shrunk this iteration. ----
  if grep -qE "$OPEN_RE" "$GOALS" 2>/dev/null && [ "$(unit_hash "$(first_open_unit | cut -d: -f2-)")" = "$H" ]; then
    state_set_num consecutive_no_progress "$(( $(state_get_num consecutive_no_progress) + 1 ))"
    log WARN "no forward progress — same unit still first-open (consecutive_no_progress=$(state_get_num consecutive_no_progress))"
  else
    state_set_num consecutive_no_progress 0
    state_set_num iter 0                   # reset inner cap ONLY on a real completion
  fi
  state_set_str last_unit_hash "$H"
  update_progress
  log UNIT "unit complete — next"
done
