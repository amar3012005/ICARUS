import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { build, buildAndStore, sourceFingerprint } = require('../../graph-native.js');

test('graph source fingerprint is deterministic and changes with supported source', () => {
  const repo = mkdtempSync(join(tmpdir(), 'icarus-graph-fingerprint-'));
  try {
    writeFileSync(join(repo, 'app.js'), 'export const value = 1;\n');
    const first = sourceFingerprint(repo);
    assert.equal(sourceFingerprint(repo), first);
    mkdirSync(join(repo, 'target'));
    writeFileSync(join(repo, 'target', 'ignored.rs'), 'fn ignored() {}\n');
    assert.equal(sourceFingerprint(repo), first, 'ignored build output cannot stale a graph');
    mkdirSync(join(repo, '.claude', 'worktrees', 'other'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'worktrees', 'other', 'copied.js'), 'export const stale = true;\n');
    assert.equal(sourceFingerprint(repo), first, 'nested agent worktrees cannot alter the repository graph');
    writeFileSync(join(repo, 'app.js'), 'export const value = 2;\n');
    assert.notEqual(sourceFingerprint(repo), first);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('graph build reports parse progress and wraps failures with the current stage', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'icarus-graph-progress-'));
  const invalidTarget = join(repo, 'not-a-directory');
  try {
    for (let index = 0; index < 30; index += 1) {
      writeFileSync(join(repo, `file-${index}.js`), `export function value${index}() { return ${index}; }\n`);
    }
    writeFileSync(invalidTarget, 'not a repository directory');

    const progress = [];
    const result = await build(repo, (update) => progress.push(update));
    assert.equal(result.files, 30);
    assert.deepEqual(progress[0], { stage: 'parsing', completed: 0, total: 30 });
    assert.equal(progress.at(-1).stage, 'resolving');
    assert.equal(progress.at(-1).completed, 30);

    await assert.rejects(
      buildAndStore(invalidTarget),
      /graph build failed during opening graph database for .*not-a-directory/,
    );
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
