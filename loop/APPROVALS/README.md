# Human approval tokens

Files here are **human-only gates**. The autonomous loop is forbidden (by prompt
and by gate logic) from creating them. They are how a human unblocks a step that
must not be self-cleared.

| Token file | Unblocks | How the human creates it |
|---|---|---|
| `p0.freeze` | P0 spec freeze (`loop/gates/p0_spec_frozen.sh`) | Review `mneme/SPEC.md`. If correct: set `Frozen: YES` + `Reviewed by: <your name>` in SPEC.md, then `touch loop/APPROVALS/p0.freeze`, then commit **as yourself** (not the loop identity `amarsai3012005`). Finally clear `STATE.json.awaiting_human` and rerun the loop. |
| `p6.golive` | P6 production swap into HIVEMIND (optional gate) | Confirm the eval ≥ baseline and soak are real, then `touch loop/APPROVALS/p6.golive`. |
| `p7.launch` | P7 public open-source launch (optional gate) | Confirm the repo + paper are ready to be public, then `touch loop/APPROVALS/p7.launch`. |

The P0 gate additionally asserts the SPEC freeze commit was authored by a **non-loop
identity** — so even if a token leaked, an agent-authored freeze fails the gate.

> If a token file appears that no human created, treat it as a security incident:
> the autonomous agent breached its boundary. Revoke and investigate.
