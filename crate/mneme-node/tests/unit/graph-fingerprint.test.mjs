import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sourceFingerprint } = require('../../graph-native.js');

test('graph source fingerprint is deterministic and changes with supported source', () => {
  const repo = mkdtempSync(join(tmpdir(), 'icarus-graph-fingerprint-'));
  try {
    writeFileSync(join(repo, 'app.js'), 'export const value = 1;\n');
    const first = sourceFingerprint(repo);
    assert.equal(sourceFingerprint(repo), first);
    mkdirSync(join(repo, 'target'));
    writeFileSync(join(repo, 'target', 'ignored.rs'), 'fn ignored() {}\n');
    assert.equal(sourceFingerprint(repo), first, 'ignored build output cannot stale a graph');
    writeFileSync(join(repo, 'app.js'), 'export const value = 2;\n');
    assert.notEqual(sourceFingerprint(repo), first);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
