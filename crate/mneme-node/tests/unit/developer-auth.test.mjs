import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const root = join(import.meta.dirname, '..', '..', '..', '..');
const cliLib = readFileSync(join(root, 'crate/mneme-node/cli-lib.js'), 'utf8');
const cli = readFileSync(join(root, 'crate/mneme-node/mneme-cli.js'), 'utf8');
const installer = readFileSync(join(root, 'install.sh'), 'utf8');
const windowsInstaller = readFileSync(join(root, 'install.ps1'), 'utf8');
const require = createRequire(import.meta.url);
const { hivemindConfigured } = require('../../cli-lib.js');

test('browser auth explicitly requests ICARUS developer mode', () => {
  assert.match(cliLib, /client: 'icarus', mode: 'developer'/);
  assert.match(cli, /mode: 'developer'/);
  assert.match(cli, /orgId: oauth\.orgId \|\| null/);
});

test('developer authentication never opts local memory into remote storage', () => {
  assert.equal(hivemindConfigured({
    hivemind: { connected: true, token: 'developer-token', apiUrl: 'https://core.example', mode: 'developer' },
  }), false);
  assert.equal(hivemindConfigured({
    hivemind: { connected: true, token: 'legacy-platform-token', apiUrl: 'https://core.example' },
  }), true);
});

test('public installers require developer authentication', () => {
  assert.match(installer, /HIVEMIND developer identity \(required\)/);
  assert.match(installer, /HIVEMIND developer authentication is required to finish installation/);
  assert.doesNotMatch(installer, /HIVEMIND account \(optional\)/);
  assert.match(windowsInstaller, /connect --oauth-only/);
  assert.match(windowsInstaller, /developer authentication is required to finish installation/);
});
