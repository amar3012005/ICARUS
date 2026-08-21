import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { releaseAssetChecksum, verifyReleaseAsset, windowsUpdateHandoffScript } = require('../../cli-lib.js');

const asset = 'icarus-darwin-arm64';
const bytes = Buffer.from('ICARUS release update integrity fixture');
const digest = createHash('sha256').update(bytes).digest('hex');

test('release update accepts only the checksum explicitly bound to its platform asset', () => {
  const sidecar = `${digest}  ${asset}\n`;
  assert.equal(releaseAssetChecksum(sidecar, asset), digest);
  assert.equal(verifyReleaseAsset(asset, bytes, sidecar), digest);
});

test('release update rejects a digest for another asset rather than trusting any valid checksum', () => {
  assert.throws(
    () => releaseAssetChecksum(`${digest}  icarus-linux-x64\n`, asset),
    /does not contain exactly one digest/,
  );
});

test('release update rejects altered bytes before the current executable can be replaced', () => {
  assert.throws(
    () => verifyReleaseAsset(asset, Buffer.from('altered binary'), `${digest}  ${asset}\n`),
    /failed SHA-256 verification/,
  );
});

test('release update rejects ambiguous duplicate entries for one asset', () => {
  assert.throws(
    () => releaseAssetChecksum(`${digest}  ${asset}\n${digest}  ${asset}\n`, asset),
    /exactly one digest/,
  );
});

test('Windows self-update handoff waits for exit, uses literal paths, and restores a rollback on failure', () => {
  const script = windowsUpdateHandoffScript();
  assert.match(script, /Wait-Process -Id \$ParentPid/);
  assert.match(script, /Move-Item -LiteralPath \$Target -Destination \$Previous -Force/);
  assert.match(script, /Move-Item -LiteralPath \$Candidate -Destination \$Target -Force/);
  assert.match(script, /-not \(Test-Path -LiteralPath \$Target\)/);
  assert.match(script, /Remove-Item -LiteralPath \$Helper -Force/);
  assert.doesNotMatch(script, /Invoke-Expression|& \$Target/);
});
