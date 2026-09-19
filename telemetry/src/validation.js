export const SCHEMA = 'icarus.telemetry.v1';
export const EVENTS = new Set([
  'installed', 'mcp_registered', 'memory_saved', 'memory_recalled', 'code_memory_saved',
  'harness_initialized', 'knowledge_space_selected',
]);
export const AGENTS = new Set(['claude', 'codex', 'cursor', 'grok', 'other']);
const OS = new Set(['darwin', 'linux', 'win32']);

function shortString(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

export function parseEvents(body) {
  if (!body || body.schema !== SCHEMA || !Array.isArray(body.events) || body.events.length < 1 || body.events.length > 20) {
    return null;
  }
  const events = [];
  for (const raw of body.events) {
    if (!raw || raw.schema !== SCHEMA || !EVENTS.has(raw.event)) return null;
    const installationId = shortString(raw.installation_id, 64);
    const version = shortString(raw.version, 32);
    if (!installationId || !version || !OS.has(raw.os) || !shortString(raw.arch, 32)) return null;
    if (raw.agent !== undefined && !AGENTS.has(raw.agent)) return null;
    if (raw.profile !== undefined && !shortString(raw.profile, 32)) return null;
    events.push({
      installationId, event: raw.event, version, os: raw.os, arch: raw.arch,
      agent: raw.agent || null, profile: raw.profile || null,
    });
  }
  return events;
}

export function dayFor(now) { return now.toISOString().slice(0, 10); }
