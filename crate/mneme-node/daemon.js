'use strict';
// icarus daemon — a persistent local HTTP service, the foundation for everything past the CLI:
// a shared process multiple tools (editors, scripts, a future local web panel, a future LLM-call
// proxy) can all talk to instead of each spawning their own short-lived `icarus` process. Plain
// Node `http`, zero new dependencies — same "zero npm deps beyond the native addon" philosophy
// as the rest of this CLI. Calls straight into cli-lib.js, the SAME module the CLI and the MCP
// server use — one implementation, not a third copy that can drift.
//
// This is deliberately NOT the MCP server: `icarus mcp serve` is a stdio process an AGENT
// launches itself, one per agent session — meaningless to run detached in the background (stdio
// isn't there to talk to). This daemon is the opposite shape: one long-running process, reached
// over a local HTTP port, that anything can call. They can run side by side; neither replaces
// the other.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { loadCfg, ingestDir, recallQuery, statusReport, openStore } = require('./cli-lib.js');

const DEFAULT_PORT = Number(process.env.ICARUS_DAEMON_PORT || 8137);

function paths(cfg) {
  const dir = path.dirname(require('./cli-lib.js').CFG_PATH);
  return {
    pidFile: path.join(dir, 'daemon.pid'),
    logFile: path.join(dir, 'daemon.log'),
    portFile: path.join(dir, 'daemon.port'),
  };
}

function readPid(pidFile) {
  try { return Number(fs.readFileSync(pidFile, 'utf8').trim()) || null; } catch (_) { return null; }
}

/** True if `pid` names a live process we can signal (not just "the file has a number in it"). */
function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/** The actual server — routes mirror the MCP tool set 1:1 (icarus_status -> GET /status, etc.)
 * on purpose: an agent talking HTTP and one talking MCP get the identical operation set. */
function createServer(cfg) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/status') {
        return send(res, 200, statusReport(cfg));
      }
      if (req.method === 'POST' && url.pathname === '/ingest') {
        const { dir, org } = await readJsonBody(req);
        if (!dir) return send(res, 400, { error: 'dir is required' });
        return send(res, 200, await ingestDir(dir, org || 'default', cfg));
      }
      if (req.method === 'POST' && url.pathname === '/recall') {
        const { query, org, topK, usePq } = await readJsonBody(req);
        if (!query) return send(res, 400, { error: 'query is required' });
        return send(res, 200, await recallQuery(query, org || 'default', cfg, topK || 5, !!usePq));
      }
      if (req.method === 'POST' && url.pathname === '/train-pq') {
        const { org, seed } = await readJsonBody(req);
        const store = openStore(cfg, org || 'default');
        const live = store.liveCount();
        if (!live) return send(res, 400, { error: `org "${org || 'default'}" has no memories yet` });
        store.trainPq(seed ?? 42);
        return send(res, 200, { org: org || 'default', liveVectors: live });
      }
      if (req.method === 'POST' && url.pathname === '/compact') {
        const { org } = await readJsonBody(req);
        const store = openStore(cfg, org || 'default');
        return send(res, 200, { org: org || 'default', reclaimedBytes: Number(store.compact()) || 0 });
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 500, { error: e.message || String(e) });
    }
  });
}

/** Foreground: what `start` actually spawns detached. Never call this directly if you want a
 * background daemon — use start(). */
function run(port) {
  const cfg = loadCfg();
  const server = createServer(cfg);
  const p = paths(cfg);
  // A real, demonstrated collision on a real machine: port 8125 (the first default tried,
  // chosen to mirror TencentDB's own convention) turned out ambiguous with Docker's IPv6
  // wildcard listener on this box — curl to 127.0.0.1:8125 kept getting a 200 even after this
  // daemon's own process had exited. Moved the default to 8137, confirmed clean; --port still
  // overrides either way. Without an 'error' handler here, a real EADDRINUSE would throw an
  // uncaught 'error' event and crash the child silently — start() would still print "✓
  // started" (it never checked), leaving a dead daemon nobody knows is dead. Fail loud instead.
  server.on('error', (err) => {
    console.error(`icarus daemon: failed to bind 127.0.0.1:${port} — ${err.message}`);
    if (err.code === 'EADDRINUSE') console.error(`  port already in use — try: icarus daemon start --port <other>`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`icarus daemon listening on http://127.0.0.1:${port}`);
    fs.writeFileSync(p.portFile, String(port)); // only written on a CONFIRMED successful bind
  });
  const shutdown = () => { try { fs.unlinkSync(p.portFile); } catch (_) {} server.close(() => process.exit(0)); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function start(flags) {
  const cfg = loadCfg();
  const p = paths(cfg);
  const existing = readPid(p.pidFile);
  if (isAlive(existing)) {
    console.log(`already running (pid ${existing}) — try: icarus daemon status`);
    return;
  }
  const port = Number(flags.port || DEFAULT_PORT);
  fs.mkdirSync(path.dirname(p.pidFile), { recursive: true });
  try { fs.unlinkSync(p.portFile); } catch (_) {} // stale from a previous crashed run, if any
  const log = fs.openSync(p.logFile, 'a');
  const child = spawn(process.execPath, [__filename, '--run', String(port)], {
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  fs.writeFileSync(p.pidFile, String(child.pid));
  // Wait for the CHILD to confirm a real, successful bind (writes daemon.port only on
  // server.listen's callback) rather than declaring success the instant spawn() returns —
  // spawn() succeeding only means "a process started", not "it bound the port".
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(p.portFile)) {
      console.log(`✓ icarus daemon started (pid ${child.pid}), http://127.0.0.1:${port}`);
      console.log(`  logs: ${p.logFile}`);
      return;
    }
    if (!isAlive(child.pid)) break; // child already died — e.g. EADDRINUSE
    await sleep(100);
  }
  try { fs.unlinkSync(p.pidFile); } catch (_) {}
  console.error(`✗ daemon failed to start — check the log: ${p.logFile}`);
  try { console.error('  ' + fs.readFileSync(p.logFile, 'utf8').trim().split('\n').slice(-3).join('\n  ')); } catch (_) {}
}

function stop() {
  const cfg = loadCfg();
  const p = paths(cfg);
  const pid = readPid(p.pidFile);
  if (!isAlive(pid)) {
    console.log('not running.');
    try { fs.unlinkSync(p.pidFile); } catch (_) {}
    return;
  }
  process.kill(pid, 'SIGTERM');
  try { fs.unlinkSync(p.pidFile); } catch (_) {}
  console.log(`✓ stopped (pid ${pid})`);
}

function status() {
  const cfg = loadCfg();
  const p = paths(cfg);
  const pid = readPid(p.pidFile);
  if (!isAlive(pid)) {
    console.log('icarus daemon: not running');
    return;
  }
  let port = null;
  try { port = fs.readFileSync(p.portFile, 'utf8').trim(); } catch (_) {}
  console.log(`icarus daemon: running (pid ${pid})${port ? `, http://127.0.0.1:${port}` : ''}`);
  console.log(`  logs: ${p.logFile}`);
}

// Invoked directly (as the detached child) with `--run <port>`, not through the normal CLI
// dispatch — this is the ONE place a bare `require('./daemon.js')` also has to work standalone.
if (require.main === module && process.argv[2] === '--run') {
  run(Number(process.argv[3]) || DEFAULT_PORT);
}

module.exports = { start, stop, status, run };
