import { parseEvents, dayFor } from './validation.js';

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function hashInstallation(id, salt) {
  const bytes = new TextEncoder().encode(`${salt}:${id}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, '0')).join('');
}

async function tokenMatches(received, expected) {
  if (!received || !expected) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(received)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const aa = new Uint8Array(a); const bb = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < aa.length; i += 1) difference |= aa[i] ^ bb[i];
  return difference === 0;
}

async function receive(request, env) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'invalid_json' }, 400); }
  const events = parseEvents(body);
  if (!events) return json({ error: 'invalid_event_batch' }, 400);
  const now = new Date();
  const receivedAt = now.toISOString();
  const day = dayFor(now);
  const statements = [];
  for (const event of events) {
    const install = await hashInstallation(event.installationId, env.TELEMETRY_SALT);
    statements.push(env.DB.prepare(
      `INSERT INTO installations (installation_hash, first_seen_at, last_seen_at, first_version, last_version)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(installation_hash) DO UPDATE SET last_seen_at = excluded.last_seen_at, last_version = excluded.last_version`,
    ).bind(install, receivedAt, receivedAt, event.version, event.version));
    statements.push(env.DB.prepare(
      'INSERT INTO events (installation_hash, event, occurred_day, version, os, arch, agent, profile, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(install, event.event, day, event.version, event.os, event.arch, event.agent, event.profile, receivedAt));
  }
  await env.DB.batch(statements);
  return json({ accepted: events.length }, 202);
}

async function metrics(request, env) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!(await tokenMatches(token, env.METRICS_ADMIN_TOKEN))) return json({ error: 'unauthorized' }, 401);
  const [totals, funnel, agents, versions] = await env.DB.batch([
    env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM installations) AS installations,
      (SELECT COUNT(DISTINCT installation_hash) FROM events WHERE occurred_day >= date('now', '-7 days')) AS active_7d,
      (SELECT COUNT(DISTINCT installation_hash) FROM events WHERE occurred_day >= date('now', '-30 days')) AS active_30d,
      (SELECT COUNT(*) FROM events WHERE event = 'harness_initialized') AS harness_initializations,
      (SELECT COUNT(DISTINCT installation_hash) FROM events WHERE event = 'harness_initialized') AS harness_agent_installations`).all(),
    env.DB.prepare(`SELECT event, COUNT(DISTINCT installation_hash) AS installations, COUNT(*) AS events
      FROM events WHERE event IN ('installed', 'mcp_registered', 'memory_saved', 'memory_recalled', 'harness_initialized')
      GROUP BY event ORDER BY event`).all(),
    env.DB.prepare(`SELECT agent, COUNT(DISTINCT installation_hash) AS installations, COUNT(*) AS initializations
      FROM events WHERE event = 'harness_initialized' GROUP BY agent ORDER BY initializations DESC`).all(),
    env.DB.prepare(`SELECT last_version AS version, COUNT(*) AS installations
      FROM installations GROUP BY last_version ORDER BY installations DESC LIMIT 25`).all(),
  ]);
  return json({
    generated_at: new Date().toISOString(),
    totals: totals.results[0], funnel: funnel.results, harness_by_agent: agents.results, versions: versions.results,
    note: 'best-effort, opt-in anonymous aggregate telemetry; unauthenticated event ingestion is not a billing or anti-fraud source.',
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/v1/events') return receive(request, env);
    if (request.method === 'GET' && url.pathname === '/v1/metrics') return metrics(request, env);
    return json({ error: 'not_found' }, 404);
  },
};
