# ICARUS and Agent Bus

ICARUS and Agent Bus solve different problems and should stay separate by default.

| Concern | Authority | Lifetime |
| --- | --- | --- |
| ICARUS | durable project memory: decisions, bugs, invariants, source summaries, test facts, and handoff notes | survives a session and a process restart |
| Agent Bus | bounded operational message: a job, question, lock, cancellation, or receipt between named agent sessions | expires by TTL and must be acknowledged |

The existing local implementation, `SINGULANCE-agent-bus`, is a user-local Unix socket and SQLite
mailbox. It intentionally is not an MCP server, network
service, deployment mechanism, or a replacement for ICARUS memory. That boundary is useful:
MCP is an agent capability surface; the bus is a small, explicit transport; ICARUS is durable
knowledge.

## Proposed optional bridge

An eventual **ICARUS Agent Bus bridge** should be an opt-in adapter to that existing `bus.v1`
protocol, not a new network protocol and not part of `icarus mcp install`.

1. An agent saves a durable handoff with `icarus_save_memory` or
   `icarus_save_conversation`, tagged `memory:task` and with the owning repository org.
2. It sends a compact `bus.v1` envelope containing the worktree, TTL, authority, task scope,
   and the ICARUS memory id(s), never a full transcript or copied shard content.
3. The receiving agent verifies that the worktree and org are in scope, then retrieves the
   referenced ICARUS records through its own local MCP process.
4. It acknowledges the bus envelope only after it has read the memory and independently checked
   any claimed result. Its durable conclusion is saved back to ICARUS.

This preserves both systems' safety contracts. A bus receipt is delivery evidence, not proof of
code correctness; ICARUS memory is context, not permission to write, commit, deploy, or access
another tenant.

## Non-negotiable constraints

- Use only the existing local Unix-socket bus. Do not add TCP, a tunnel, Cloudflare routing, a
  shared-volume mount, or an MCP wrapper around the bus.
- Do not put secrets, customer data, full prompts, or `.amr` bytes into a bus envelope.
- Keep a message small and refer to memory ids instead of duplicating durable material.
- Preserve `bus.v1` TTL, worktree lease, explicit authority, and acknowledgement semantics.
- The bridge must never grant commit, deployment, SSH, or destructive authority.
- A missing bus must not block normal ICARUS memory save/recall. It is an optional coordination
  accelerator.

## What is ready today

ICARUS already provides the durable half: local structured memory, raw saves, lexical recall,
code decision/bug/refactor/test records, and local daemon ownership for multiple MCP clients.
The Agent Bus project already provides the short-lived half: typed envelopes, locks, receipts,
and explicit polling/delivery adapters. The integration itself is deliberately not shipped yet;
it needs a dedicated compatibility test covering two real agent sessions, a shared repo org, an
expired message, and a rejected cross-worktree write before it should become a public ICARUS
feature.
