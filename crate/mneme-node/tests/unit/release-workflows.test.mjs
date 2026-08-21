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

test('REGRESSION: native MCP shard round-trip has its own addon-build CI gate', () => {
  const ci = workflow('ci.yml');
  assert.match(ci, /node-native-mcp:/, 'the real MCP shard test must not be confused with the toolchain-free framing suite');
  assert.match(ci, /name: Build the local native addon\n\s+working-directory: crate\/mneme-node\n\s+run: npm run build:debug/);
  assert.match(ci, /name: Native MCP shard round-trip\n\s+working-directory: crate\/mneme-node\n\s+run: npm run test:engine/);
});

test('REGRESSION: normal CI independently exercises the compiled CLI with a native shard', () => {
  const ci = workflow('ci.yml');
  assert.match(ci, /compiled-cli:/, 'compiled artifact verification must not exist only in the release workflow');
  assert.match(ci, /bun build --compile \.\/mneme-cli\.js --outfile/);
  assert.match(ci, /ICARUS_HOME="\$HOME_DIR" "\$BIN" save "compiled binary native shard round trip" --org ci-e2e/);
  assert.match(ci, /ICARUS_HOME="\$HOME_DIR" "\$BIN" recall "compiled binary native shard" --org ci-e2e/);
});

test('REGRESSION: CLI releases publish signed provenance for every platform binary', () => {
  const release = workflow('release-cli.yml');
  assert.match(release, /id-token: write/);
  assert.match(release, /attestations: write/);
  assert.match(release, /uses: actions\/attest@v4/);
  assert.match(release, /subject-path: crate\/mneme-node\/\$\{\{ matrix\.asset \}\}/);
});

test('REGRESSION: every CLI release binary carries a published SPDX SBOM and SBOM attestation', () => {
  const release = workflow('release-cli.yml');
  assert.match(release, /uses: anchore\/sbom-action@e22c389904149dbc22b58101806040fa8d37a610/);
  assert.match(release, /format: spdx-json/);
  assert.match(release, /output-file: crate\/mneme-node\/\$\{\{ matrix\.asset \}\}\.spdx\.json/);
  assert.match(release, /sbom-path: crate\/mneme-node\/\$\{\{ matrix\.asset \}\}\.spdx\.json/);
  assert.match(release, /icarus-linux-x64\.spdx\.json/);
});
