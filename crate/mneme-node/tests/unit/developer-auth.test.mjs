import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { attemptHivemindOAuth } = require('../../cli-lib.js');
test('terminal exchanges code with PKCE; wrong state is ignored and reusable tokens never enter callback URLs', async () => {
  let start, posted;
  const backend = http.createServer(async (req, res) => {
    assert.equal(req.url, '/auth/developer/cli/exchange');
    let raw = ''; for await (const c of req) raw += c;
    posted = JSON.parse(raw);
    assert.equal(crypto.createHash('sha256').update(posted.code_verifier).digest('base64url'), start.searchParams.get('code_challenge'));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ token: 'test-developer-credential', accountType: 'developer', scope: 'developer:identity', orgId: null, userId: 'person', userEmail: 'dev@example.test' }));
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const signals = process.listenerCount('SIGINT');
  try {
    let browser;
    const grant = await attemptHivemindOAuth(`http://127.0.0.1:${backend.address().port}`, { timeoutMs: 3000, report: () => {}, launchBrowser: value => {
      browser = (async () => {
        start = new URL(value); assert.equal(start.pathname, '/auth/developer/cli/start');
        assert.equal(start.searchParams.has('code_verifier'), false);
        const cb = new URL(start.searchParams.get('callback')); cb.searchParams.set('code', 'one-shot'); cb.searchParams.set('state', 'wrong');
        assert.equal((await fetch(cb)).status, 400);
        cb.searchParams.set('state', start.searchParams.get('state'));
        const response = await fetch(cb); assert.equal(response.status, 200); assert.match(await response.text(), /return to your terminal/);
        assert.equal(cb.searchParams.has('token'), false);
      })();
    } });
    await browser;
    assert.equal(grant.userId, 'person'); assert.equal(posted.code, 'one-shot');
    assert.equal(process.listenerCount('SIGINT'), signals);
  } finally { backend.close(); backend.closeAllConnections(); }
});
test('timeout closes listener and removes signal handlers', async () => {
  let callback; const signals = process.listenerCount('SIGINT');
  assert.equal(await attemptHivemindOAuth('https://api.example.test', { timeoutMs: 30, report: () => {}, launchBrowser: value => { callback = new URL(value).searchParams.get('callback'); } }), null);
  assert.equal(process.listenerCount('SIGINT'), signals);
  await assert.rejects(fetch(callback));
});
test('remote plaintext issuer is refused', async () => {
  assert.equal(await attemptHivemindOAuth('http://evil.test', { launchBrowser: () => assert.fail() }), null);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
test('developer storage preserves customer connection and restricts existing config permissions', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-developer-config-'));
  const file = path.join(home, 'config.json'); fs.writeFileSync(file, '{}', { mode: 0o644 });
  try {
    const lib = require.resolve('../../cli-lib.js');
    const script = `const {saveCfg}=require(process.argv[1]); saveCfg({hivemind:{connected:true,token:'customer-fixture'},developer:{token:'developer-fixture',scope:'developer:identity'}});`;
    const run = spawnSync(process.execPath, ['-e', script, lib], { env: { ...process.env, ICARUS_HOME: home }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const cfg = JSON.parse(fs.readFileSync(file));
    assert.equal(cfg.hivemind.token, 'customer-fixture'); assert.equal(cfg.developer.scope, 'developer:identity');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(run.stdout, '');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});


test('default browser wait covers email validity and explains expired-listener recovery', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reports = [];
  let opened;
  const browserOpened = new Promise(resolve => { opened = resolve; });
  let settled = false;
  const pending = attemptHivemindOAuth('https://api.example.test', {
    report: value => reports.push(value), launchBrowser: opened,
  }).then(value => { settled = true; return value; });
  await browserOpened;
  t.mock.timers.tick(180001);
  await Promise.resolve();
  assert.equal(settled, false, 'the former three-minute deadline must not close the callback');
  t.mock.timers.tick(420000);
  await Promise.resolve();
  assert.equal(settled, false, 'the ten-minute email window must fit inside the browser wait');
  t.mock.timers.tick(300000);
  assert.equal(await pending, null);
  assert.ok(reports.some(value => /Waiting up to 15 minutes/.test(value)));
  assert.ok(reports.some(value => /icarus connect.*no new email code/.test(value)));
});

test('a fresh handoff after timeout rejects the expired state and completes with fresh PKCE', async () => {
  let expiredStart;
  await attemptHivemindOAuth('https://api.example.test', {
    timeoutMs: 20, report: () => {}, launchBrowser: value => { expiredStart = new URL(value); },
  });
  let freshStart, browser;
  const backend = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const posted = JSON.parse(raw);
    assert.equal(crypto.createHash('sha256').update(posted.code_verifier).digest('base64url'), freshStart.searchParams.get('code_challenge'));
    assert.equal(posted.callback, freshStart.searchParams.get('callback'));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ token: 'recovered-fixture', accountType: 'developer', scope: 'developer:identity', orgId: null }));
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  try {
    const grant = await attemptHivemindOAuth(`http://127.0.0.1:${backend.address().port}`, {
      timeoutMs: 3000, report: () => {}, launchBrowser: value => {
        freshStart = new URL(value);
        assert.notEqual(freshStart.searchParams.get('state'), expiredStart.searchParams.get('state'));
        assert.notEqual(freshStart.searchParams.get('code_challenge'), expiredStart.searchParams.get('code_challenge'));
        browser = (async () => {
          const cb = new URL(freshStart.searchParams.get('callback'));
          cb.searchParams.set('code', 'fresh-one-shot');
          cb.searchParams.set('state', expiredStart.searchParams.get('state'));
          assert.equal((await fetch(cb)).status, 400);
          cb.searchParams.set('state', freshStart.searchParams.get('state'));
          assert.equal((await fetch(cb)).status, 200);
        })();
      },
    });
    await browser;
    assert.equal(grant.token, 'recovered-fixture');
  } finally { backend.close(); backend.closeAllConnections(); }
});
