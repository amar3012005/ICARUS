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

const TOKEN_FILE = 'daemon.token';
const PORT_FILE = 'daemon.port';
const PID_FILE = 'daemon.pid';
const DAEMON_ENTRY = path.join(__dirname, 'daemon.js');

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
        if (res.statusCode >= 400) return reject(new Error(parsed.error || `daemon returned HTTP ${res.statusCode}`));
        resolve(parsed);
      });
    });
    req.once('timeout', () => req.destroy(new Error('daemon request timed out')));
    req.once('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function health(port, token) {
  const result = await request(port, 'GET', '/health', null, token);
  if (result.service !== 'icarus-daemon') throw new Error('unexpected local service');
  return result;
}

async function ensureDaemon() {
  const token = daemonToken();
  let port = Number(fs.existsSync(portPath()) ? fs.readFileSync(portPath(), 'utf8').trim() : 0) || defaultPort();
  try { await health(port, token); return { port, token }; } catch (_) {}

  const env = { ...process.env, ICARUS_DAEMON_PORT: String(port) };
  const child = spawn(process.execPath, [DAEMON_ENTRY, '--run', String(port)], {
    detached: true, stdio: 'ignore', env,
  });
  child.unref();
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
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
  const { port, token } = await ensureDaemon();
  const result = await request(port, 'POST', '/rpc', { operation, args, cfg }, token);
  return result.value;
}

async function stopDaemon() {
  const token = daemonToken();
  const port = Number(fs.existsSync(portPath()) ? fs.readFileSync(portPath(), 'utf8').trim() : 0) || defaultPort();
  try { await request(port, 'POST', '/shutdown', {}, token); } catch (_) { /* already stopped */ }
}

module.exports = { callMemory, ensureDaemon, stopDaemon, defaultPort, daemonToken, TOKEN_FILE, PORT_FILE, PID_FILE };
