import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');

function workflow(name) {
  return readFileSync(join(ROOT, '.github', 'workflows', name), 'utf8');
}

test('CLI releases use v* tags', () => {
  assert.match(workflow('release-cli.yml'), /tags:\s*\['v\*'\]/);
});

test('REGRESSION: npm engine releases use a distinct engine-v* tag namespace', () => {
  const engine = workflow('release.yml');
  assert.match(engine, /tags:\s*\['engine-v\*'\]/);
  assert.doesNotMatch(engine, /tags:\s*\['v\*'\]/);
});

test('REGRESSION: Node CI installs declared dependencies before running unit tests', () => {
  const ci = workflow('ci.yml');
  assert.match(ci, /working-directory: crate\/mneme-node\n\s+run: npm ci\n\n\s+- name: Node tests/);
});
