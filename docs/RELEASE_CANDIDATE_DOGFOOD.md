# Release-candidate dogfood evidence

Phase 9 requires an observed release-candidate window of at least 30 full days and 100 managed
task starts, with no unresolved data-loss, scope-escape, false-seal, or cross-tenant incident.
This is a release gate, not a counter that can be reset from a dashboard.

## Start once, for the candidate under evaluation

```bash
icarus task dogfood start --release v1.0.0-rc.1
```

ICARUS writes the start marker under `.icarus/runtime/` through the Rust authority. Repeating the
same release id is idempotent. A different release id is refused so a newer checkout cannot
overwrite or back-date an existing candidate's evidence window.

## Observe the gate

```bash
icarus task dogfood status
```

The report reads the hash-chained runtime event log and counts distinct `task_created` events on
or after the recorded start time. It reports blocked and failed task IDs for review, but does not
silently erase them or guess whether they were critical incidents. `ready` remains false unless:

- the event chain is valid;
- 30 complete days have elapsed;
- at least 100 managed task starts are present; and
- a named owner has recorded the final incident-free attestation.

## Complete the operator-only incident statement

After reviewing the release window and only after the automatic gates pass:

```bash
icarus task dogfood attest --approval RC-2026-001 --approver "Release owner"
```

The attestation statement is fixed: no unresolved data-loss, scope-escape, false-seal, or
cross-tenant incident is known for that exact dogfood window. ICARUS records the approval ID,
approver, and timestamp in the Rust-owned runtime state and appends a hash-chained event.

This command cannot bypass the time, task-count, or event-chain checks. It also cannot turn a
client adapter from compatible into certified; the separate real-client adapter certification
requirements remain in [ADAPTER_CERTIFICATION.md](ADAPTER_CERTIFICATION.md).
