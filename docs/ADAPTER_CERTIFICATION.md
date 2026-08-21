# ICARUS adapter certification

ICARUS is a deterministic harness around coding agents. A model is never certified merely because
it can start, receive context, or write files. Certification means the adapter enforces every
boundary below for the named client version and has reproducible evidence for it.

## Certification contract

An adapter is certified only when it has all eight capabilities:

1. Native pre-action authorization before every managed write.
2. Native post-action event capture for every managed write.
3. Completion interception before a task can be sealed.
4. Stable session identity that binds a resumed attempt to the same task.
5. Structured event access rather than parsing model prose.
6. Tool allow/deny controls that cannot be relaxed by agent arguments.
7. Isolated, contract-scoped workspace execution.
8. External-write approval interception, including revocation before the mutation.

An adapter that lacks one or more items is **compatible**, not certified. Compatible agents can
use local context, contracts, checkpoints, verification, and seal-time scope checks, but their
writes are not described as hard-governed.

## Current public matrix

| Adapter | Tier | Evidence | Missing before certification |
|---|---|---|---|
| Claude Code | Compatible | Native fake-adapter conformance covers task preparation, pre/post hook receipts, a scoped accepted write, rejected out-of-scope write, lifecycle, and handoff. | A supported live-client hook contract with stable session identity and external-write interception. |
| Codex CLI | Compatible / experimental app-server bridge | The Rust bridge has a fake protocol conformance fixture. A local disposable-repository run against Codex CLI `0.149.0` performed one contract-allowed write and one forbidden `README.md` write attempt. The allowed write received a structured Rust authorization before completion; the forbidden attempt received a structured decline before its isolated workspace mutation, and the authoritative `README.md` hash remained unchanged. A fresh Codex process then resumed the persisted exact thread under a new linked ICARUS execution; Rust cleared one-shot approvals before the resumed turn. Both runs recorded native thread, turn, item, approval, completion, and reconciliation/blocked lifecycle receipts. | An external-write approval/revocation run and the remaining certification evidence. |
| Cursor, Grok Build, generic MCP clients | Compatibility | MCP tools expose the local Rust lifecycle/context/verification surface. | The full eight-capability contract. |

No adapter is currently certified. The public release wording and `icarus run` output must retain
the compatibility label until a version-pinned, real-client conformance run proves every item.

## Evidence required for a certification PR

A certification change must include all of the following:

- Exact client version and protocol/schema snapshot.
- A disposable-repository real-client run with one allowed write and one rejected out-of-scope
  write, showing the rejection happened before the filesystem mutation.
- Captured structured thread, turn, action, approval, and completion identifiers bound to the
  Rust task/execution IDs.
- A restart/resume run using the same stable client session identity.
- An external-write approval that is revoked before the attempted mutation and remains rejected.
- A CI fixture that fails if the version's event/approval shape drifts.

The fixture is necessary but not sufficient: it prevents known protocol drift; the observed
real-client run is what establishes that the client actually emits and obeys the boundary.
