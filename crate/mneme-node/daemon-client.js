'use strict';
// Local RPC client used by MCP sessions. The daemon, not each stdio MCP process, owns the
// native shard handle. This removes cross-session flock contention without weakening the
// storage engine's single-writer safety boundary.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { HOME } = require('./cli-lib.js');

// Keep this in lockstep with daemon.js.  It intentionally lives here too so this client can
// reject an old daemon before issuing any request that carries repository-local memory state.
const DAEMON_PROTOCOL = 2;

const TOKEN_FILE = 'daemon.token';
const PORT_FILE = 'daemon.port';
const PID_FILE = 'daemon.pid';
const DAEMON_ENTRY = path.join(__dirname, 'daemon.js');

/// How to spawn the memory daemon. A Bun-compiled `icarus` binary must NEVER pass a
/// source-tree `daemon.js` path (`__dirname` is the GitHub Actions checkout after compile).
/// Use the same executable plus `daemon --run <port>`. Node/source tests keep spawning
/// `node daemon.js --run`.
function isCompiledIcarusBinary() {
  const exe = path.basename(process.execPath).replace(/\.exe$/i, '');
  return exe === 'icarus' || exe.startsWith('icarus-');
}

function daemonCommand(port) {
  const portStr = String(port);
  if (!isCompiledIcarusBinary() && fs.existsSync(DAEMON_ENTRY)) {
    return [process.execPath, [DAEMON_ENTRY, '--run', portStr]];
  }
  return [process.execPath, ['daemon', '--run', portStr]];
}

function runtimeDir() { return HOME; }
function tokenPath() { return path.join(runtimeDir(), TOKEN_FILE); }
function portPath() { return path.join(runtimeDir(), PORT_FILE); }

function daemonToken() {
  fs.mkdirSync(runtimeDir(), { recursive: true, mode: 0o700 });
  try { return fs.readFileSync(tokenPath(), 'utf8').trim(); } catch (_) {}
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenPath(), token, { mode: 0o600 });
  return token;
}

// Separate ICARUS homes must not contend for one TCP port in tests or multi-profile setups.
// The bearer token still ensures a coincidental collision is never mistaken for our daemon.
function defaultPort() {
  if (process.env.ICARUS_DAEMON_PORT) return Number(process.env.ICARUS_DAEMON_PORT);
  const n = crypto.createHash('sha256').update(runtimeDir()).digest().readUInt16BE(0);
  return 18000 + (n % 8000);
}

function request(port, method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, method, path: pathname, timeout: 1_500,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...(token ? { 'x-icarus-daemon-token': token } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (error) { return reject(error); }
        if (res.statusCode >= 400) {
          const error = new Error(parsed.error || `daemon returned HTTP ${res.statusCode}`);
          error.icarusDaemonResponse = true;
          return reject(error);
        }
        resolve(parsed);
      });
    });
    req.once('timeout', () => req.destroy(new Error('daemon request timed out')));
    req.once('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function rawHealth(port, token) {
  return request(port, 'GET', '/health', null, token);
}

function compatibleHealth(result) {
  return result?.service === 'icarus-daemon' && result.protocol === DAEMON_PROTOCOL;
}

async function health(port, token) {
  const result = await rawHealth(port, token);
  if (result.service !== 'icarus-daemon') throw new Error('unexpected local service');
  if (!compatibleHealth(result)) {
    const error = new Error('incompatible ICARUS daemon protocol');
    error.icarusDaemonIncompatible = true;
    throw error;
  }
  return result;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function stopIncompatibleDaemon(port, token) {
  try { await request(port, 'POST', '/shutdown', {}, token); } catch (_) {}
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(50);
    try { await rawHealth(port, token); } catch (_) { return; }
  }
  const error = new Error('incompatible ICARUS daemon did not stop; run `icarus daemon stop` and retry');
  error.icarusDaemonIncompatible = true;
  throw error;
}

async function ensureDaemon() {
  const token = daemonToken();
  let port = Number(fs.existsSync(portPath()) ? fs.readFileSync(portPath(), 'utf8').trim() : 0) || defaultPort();
  let existing = null;
  try { existing = await rawHealth(port, token); } catch (_) {}
  if (compatibleHealth(existing)) return { port, token };
  if (existing?.service === 'icarus-daemon') await stopIncompatibleDaemon(port, token);

  const env = { ...process.env, ICARUS_DAEMON_PORT: String(port) };
  const [cmd, args] = daemonCommand(port);
  const child = spawn(cmd, args, {
    detached: true, stdio: 'ignore', env,
  });
  child.unref();
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(100);
    try {
      const fromFile = Number(fs.existsSync(portPath()) ? fs.readFileSync(portPath(), 'utf8').trim() : 0);
      if (fromFile) port = fromFile;
      await health(port, token);
      return { port, token };
    } catch (_) { /* another session may still be starting the same daemon */ }
  }
  throw new Error('ICARUS local daemon did not become ready; inspect ~/.icarus/daemon.log or run `icarus daemon status`');
}

async function callMemory(operation, args, cfg) {
  try {
    const { port, token } = await ensureDaemon();
    const result = await request(port, 'POST', '/rpc', { operation, args, cfg }, token);
    return result.value;
  } catch (error) {
    // A daemon that understood the request but rejected the operation must surface that error.
    // Falling back to direct native access in that case races the daemon's open shard handle and
    // turns a useful failure into a misleading `ShardLocked` error.
    if (error?.icarusDaemonResponse || error?.icarusDaemonIncompatible) throw error;
    // Daemon is an optimization for many MCP clients. A single agent session must still
    // read/write the .amr file if spawn/health fails (compiled-path bugs, port fights).
    const { executeMemoryOperation } = require('./daemon.js');
    return executeMemoryOperation(operation, args, cfg);
  }
}

async function stopDaemon() {
  const token = daemonToken();
  const port = Number(fs.existsSync(portPath()) ? fs.readFileSync(portPath(), 'utf8').trim() : 0) || defaultPort();
  try { await request(port, 'POST', '/shutdown', {}, token); } catch (_) { /* already stopped */ }
}

module.exports = {
  callMemory, ensureDaemon, stopDaemon, defaultPort, daemonToken, daemonCommand,
  isCompiledIcarusBinary, compatibleHealth, DAEMON_PROTOCOL, TOKEN_FILE, PORT_FILE, PID_FILE, DAEMON_ENTRY,
};
