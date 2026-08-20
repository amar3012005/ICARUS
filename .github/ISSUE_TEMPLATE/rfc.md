---
name: RFC (design proposal)
about: Propose a change to an interface, schema, security boundary, or documented guarantee
title: 'RFC: '
labels: rfc
---

<!--
Use this for anything that changes an INTERFACE, a SCHEMA, a SECURITY BOUNDARY, or a
documented GUARANTEE — see GOVERNANCE.md for the exact list. Bug fixes and additive tests do
not need an RFC; open a pull request instead.

The reason this template exists: the .amr slot format and the harness schemas are things other
people's data and automation depend on, and they are frozen before v1.0. Getting agreement on
the shape BEFORE the implementation is cheaper for everyone than reverting a merged design.
-->

## Problem

What is actually broken or missing today? Describe the observed behaviour, not the solution.
If it is a bug, include the real reproduction.

## Why the current design cannot absorb this

Which existing mechanism did you consider extending, and why is it not sufficient? Proposals
that duplicate something ICARUS already does are the most common reason an RFC is declined.

## Proposal

What you want to change, concretely.

## Interface impact

Tick everything this touches, and describe how:

- [ ] `.amr` slot format or shard file set
- [ ] A harness schema (manifest / contract / checkpoint / receipt / skill)
- [ ] CLI commands or their output
- [ ] MCP tool names or response shapes
- [ ] Signing, audit chain, permissions, or tenant isolation
- [ ] Adds a network call to a path that currently works offline
- [ ] None of the above

## Compatibility

- Do existing shards still open, unmodified? If not, what is the migration, and is it
  reversible?
- Does anything that works offline today still work offline?
- Is any currently-passing command's output or exit code changing?

## Security considerations

Who could abuse this, and how is that prevented? Consider at minimum: a malicious repository,
prompt injection through ingested content, a compromised skill, path escape, and forged
evidence.

## How it will be proven

Not "I will test it" — what specific evidence will exist?

- What test fails against today's code and passes with the change?
- What failure paths are covered, not just the happy path?
- If it claims a performance or token improvement, what is the measurement and the fixture?

Note the project's standard: a healthy process, an agent's prose, or a passing unrelated test
is not acceptance evidence.

## Alternatives considered

Including "do nothing" — what happens if this is simply not built?
