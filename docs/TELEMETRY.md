# ICARUS telemetry

ICARUS is local-first. Anonymous product telemetry is **off by default** and does not alter
memory, recall, knowledge ingestion, MCP, or Harness behavior.

## Consent and controls

The installer asks once on an interactive terminal. A user can inspect or change the decision at
any time:

```bash
icarus telemetry status
icarus telemetry enable
icarus telemetry disable
```

Enabling generates a random local installation UUID and queues a small lifecycle event. Disabling
stops all future sending; existing queued entries remain local and are not transmitted unless the
user enables telemetry again.

## What is collected

Every event contains only:

- a random opaque installation identifier;
- event type, CLI version, operating-system family, and CPU architecture;
- a coarse product profile, and for Harness initialization only the selected agent name
  (`claude`, `codex`, `cursor`, `grok`, or `other`).

The permitted events are `installed`, `mcp_registered`, `memory_saved`, `memory_recalled`,
`code_memory_saved`, `knowledge_space_selected`, and `harness_initialized`.

ICARUS never sends repository paths or names, source files, prompts, memories, document contents,
memory IDs, credentials, account IDs, or git metadata. The public collector salts and hashes the
random identifier before storage. It retains no IP address in its database.

## Metrics available to maintainers

The optional Cloudflare Worker in [`telemetry/`](../telemetry/) uses D1 to report:

- total opt-in installations and 7/30-day active installations;
- install → MCP registration → first memory write/recall funnel;
- total Harness initializations, unique installations that initialized Harness, and a breakdown by
  coding agent;
- active installed versions.

`GET /v1/metrics` requires a separate `METRICS_ADMIN_TOKEN` Worker secret. The collector accepts
only a bounded metadata schema and batches at most 20 events. Because intake is anonymous and
unauthenticated, the output is product-directional analytics, never a billing, licensing, or
anti-fraud record.

## Deploying the collector

The production collector is deployed at
`https://telemetry.icarus.singulancelabs.com/v1/events` with its dedicated D1 database. To deploy
an isolated staging collector, create a separate D1 database, change the `database_id` in
[`telemetry/wrangler.jsonc`](../telemetry/wrangler.jsonc), apply migrations, and configure fresh
secrets outside source control:

```bash
cd telemetry
npx wrangler d1 migrations apply icarus-telemetry --remote
npx wrangler secret put TELEMETRY_SALT
npx wrangler secret put METRICS_ADMIN_TOKEN
npx wrangler deploy
```

Only point `ICARUS_TELEMETRY_ENDPOINT` (or the documented default endpoint) at the deployed,
HTTPS collector after a request-level canary passes.
