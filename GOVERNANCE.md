# Governance

ICARUS is open source under Apache-2.0. This document says who decides what, how a change
gets in, and what the project promises not to break. It exists because the repository is
becoming the canonical home for development (see `HARNESS_V1_PLAN.md`, Phase 0), and outside
contributors need to know the rules before spending time.

## Project scope

ICARUS is two things, deliberately layered:

1. **The `.amr` memory filesystem** — a Rust storage engine: one mmap'd shard per tenant,
   vector + lexical + temporal + graph, no server, no database.
2. **The harness** — a deterministic operating layer around *existing* coding agents,
   supplying trusted context, task state, permissions, verification, resumability, and
   governed learning.

A hard, non-negotiable boundary: **the harness performs no LLM inference.** The coding agent
(Claude Code, Codex, or another) supplies all linguistic reasoning; ICARUS decides what is
authorized and what is proven. A proposal that puts model calls inside harness operations is
out of scope by definition, not by preference — `Phase 9` of the plan requires this to be
provable by network-isolated tests.

## Roles

- **Maintainer** — currently a single maintainer (`@amar3012005`, see `.github/CODEOWNERS`).
  Merges changes, cuts releases, owns the roadmap, and is the approver for high-risk skill
  promotion and any security-relevant change.
- **Contributor** — anyone opening an issue or pull request. No CLA is required.

The project does not pretend to have a committee it does not have. If that changes, this
section changes with it.

## How decisions are made

Small, obvious changes — a bug fix with a regression test, a documentation correction, a test
for existing behaviour — need only a pull request.

Anything that changes an **interface, a schema, a security boundary, or a documented
guarantee** needs an RFC first: open an issue using the RFC template
(`.github/ISSUE_TEMPLATE/rfc.md`) and get maintainer agreement before writing the
implementation. This is not bureaucracy for its own sake; the file format and the harness
schemas are things other people's data and automation depend on, and they are frozen before
v1.0 (`Phase 8`).

Specifically requiring an RFC:

- Any change to the `.amr` slot format or shard file set.
- Any change to a harness schema (manifest, contract, checkpoint, receipt, skill).
- New or renamed CLI commands, MCP tools, or their response shapes.
- Anything touching signing, the audit chain, permissions, or tenant isolation.
- Adding a network call to a code path that currently works offline.

## Pull request requirements

A pull request is mergeable when:

1. **CI is green** on every platform in the matrix. A red or skipped run is not a merge.
2. **Behaviour changes come with tests.** For a bug fix, that means a test which *fails
   against the unfixed code* — a green test that would also have been green before the fix
   proves nothing. Say so in the PR description.
3. **No unexplained suppressions.** No new `eslint-disable`, `@ts-ignore`, `#[allow(...)]`,
   or skipped test without a comment saying why.
4. **Version discipline.** Do not hand-edit the version literal; `VERSION` is the single
   source of truth and `node scripts/version.mjs --check` enforces it.
5. **No secrets, no internal hosts, no customer data** — including in test fixtures.

## What this project promises

- **Your data stays yours and stays local.** Recall runs against the local shard. There is no
  implicit upload of shard contents, embeddings, credentials, or transcripts.
- **The `.amr` format stays compatible.** Existing shards continue to open. Migrations, when
  needed, are additive and explicit (`icarus migrate --dry-run` first).
- **Offline stays first-class.** Every core lifecycle works with no account and no network.
  Organizational features are opt-in and additive, never a prerequisite.
- **After v1.0, public schemas and commands follow semantic versioning.**

## Security

Do not open a public issue for a vulnerability. Follow `SECURITY.md`. Security fixes take
precedence over roadmap work and may ship outside the normal release train.

## Releases

Releases are cut from the public repository. `VERSION` drives the tag, the compiled binary,
and the update check; the release workflow refuses to publish when they disagree, when the
release would remain a draft, or when a cold download does not match what was built.

Release train to v1.0: `v0.4` preview → `v0.5` beta → `v0.9` release candidate → `v1.0`
stable. Gates, not dates, determine readiness — each phase in `HARNESS_V1_PLAN.md` has an
explicit exit gate and does not ship until it passes.

## Agent adapters

An agent adapter is **certified** only when it satisfies the full enforcement contract in
`HARNESS_V1_PLAN.md` (pre-action authorization, post-action capture, seal interception,
stable session identity and resume, event access, tool allow/deny, workspace isolation,
external-write approval interception).

Anything short of that is labelled **compatibility mode**, and the product says so plainly
in its own output. Presenting a partially-enforced agent as governed would be the single most
harmful thing this project could do, because the entire value proposition is that a seal
means something.
