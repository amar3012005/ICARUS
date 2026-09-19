'use strict';

// ICARUS telemetry is deliberately consent-based and metadata-only.  The memory filesystem is
// useful precisely because it can run locally; no save, recall, source file, shard content,
// repository path, prompt, credential, or memory identifier ever belongs in a usage event.
//
// Events are queued locally first, then sent opportunistically with a short deadline.  A failed
// telemetry endpoint can therefore never delay or fail an agent's actual memory operation.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TELEMETRY_SCHEMA = 'icarus.telemetry.v1';
const DEFAULT_ENDPOINT = 'https://telemetry.icarus.singulancelabs.com/v1/events';
const ALLOWED_EVENTS = new Set([
  'installed', 'mcp_registered', 'memory_saved', 'memory_recalled', 'code_memory_saved',
  'harness_initialized', 'knowledge_space_selected',
]);
const ALLOWED_AGENTS = new Set(['claude', 'codex', 'cursor', 'grok', 'other']);

function endpointFor(cfg) {
  return process.env.ICARUS_TELEMETRY_ENDPOINT || cfg?.telemetry?.endpoint || DEFAULT_ENDPOINT;
}

function enabled(cfg) { return cfg?.telemetry?.enabled === true; }
function queuePath(home) { return path.join(home, 'telemetry-queue.jsonl'); }

function enable(cfg, saveCfg, endpoint) {
  const resolved = endpoint || endpointFor(cfg);
  if (!/^https:\/\//.test(resolved)) throw new Error('telemetry endpoint must use https');
  cfg.telemetry = {
    ...(cfg.telemetry || {}),
    enabled: true,
    endpoint: resolved,
    installationId: cfg.telemetry?.installationId || crypto.randomUUID(),
    consentedAt: cfg.telemetry?.consentedAt || new Date().toISOString(),
  };
  saveCfg(cfg);
  return cfg.telemetry;
}

function disable(cfg, saveCfg) {
  cfg.telemetry = { ...(cfg.telemetry || {}), enabled: false, disabledAt: new Date().toISOString() };
  saveCfg(cfg);
  return cfg.telemetry;
}

function safeEvent(event, fields, cfg) {
  if (!ALLOWED_EVENTS.has(event) || !enabled(cfg) || !cfg.telemetry?.installationId) return null;
  const agent = ALLOWED_AGENTS.has(fields?.agent) ? fields.agent : undefined;
  return {
    schema: TELEMETRY_SCHEMA,
    installation_id: cfg.telemetry.installationId,
    event,
    occurred_at: new Date().toISOString(),
    version: fields?.version,
    os: process.platform,
    arch: process.arch,
    ...(agent ? { agent } : {}),
    ...(typeof fields?.profile === 'string' ? { profile: fields.profile.slice(0, 32) } : {}),
  };
}

function append(home, event) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.appendFileSync(queuePath(home), `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

async function flush(home, cfg) {
  if (!enabled(cfg)) return { sent: 0 };
  const file = queuePath(home);
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch (_) { return { sent: 0 }; }
  let batch;
  try {
    batch = lines.slice(0, 20).map((line) => JSON.parse(line));
  } catch (_) {
    // A corrupt local queue is never a reason to fail ICARUS itself. Keep it in place for
    // inspection rather than discarding potentially useful diagnostic evidence.
    return { sent: 0 };
  }
  if (!batch.length) return { sent: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 750);
  try {
    const response = await fetch(endpointFor(cfg), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema: TELEMETRY_SCHEMA, events: batch }), signal: controller.signal,
    });
    if (!response.ok) return { sent: 0 };
    const remaining = lines.slice(batch.length);
    fs.writeFileSync(file, remaining.length ? `${remaining.join('\n')}\n` : '', { mode: 0o600 });
    return { sent: batch.length };
  } catch (_) {
    return { sent: 0 };
  } finally {
    clearTimeout(timer);
  }
}

function record(home, cfg, event, fields = {}) {
  const payload = safeEvent(event, fields, cfg);
  if (!payload) return false;
  try { append(home, payload); } catch (_) { return false; }
  // Deliberately detached: a bad network must never affect local ICARUS work.
  void flush(home, cfg);
  return true;
}

function status(home, cfg) {
  let queued = 0;
  try { queued = fs.readFileSync(queuePath(home), 'utf8').split('\n').filter(Boolean).length; } catch (_) {}
  return {
    enabled: enabled(cfg), endpoint: endpointFor(cfg), queued,
    installation_id: enabled(cfg) ? cfg.telemetry?.installationId : null,
    data: 'metadata only: event, opaque install id, version, OS/arch, selected profile and agent; never memory or repository content',
  };
}

module.exports = { DEFAULT_ENDPOINT, enable, disable, record, flush, status };
