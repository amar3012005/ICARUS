// scripts/version.mjs — the single source of truth for the CLI release version.
//
// This matters because the shipped artifact is one self-contained binary: the version has to
// be BAKED IN at build time, so it cannot be read from the VERSION file at runtime. That
// means there are necessarily two copies (VERSION and the literal in cli-lib.js), and the
// only thing standing between that and a release where the git tag, the binary, and the
// update check disagree is this script plus a CI --check gate.
//
// Every case below runs against a COPY of the repo in a temp dir, so a failing test can
// never corrupt the real VERSION file or cli-lib.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// crate/mneme-node/tests/unit -> tests -> mneme-node -> crate -> repo root (four levels).
const REPO = join(HERE, '..', '..', '..', '..');
const SCRIPT = join(REPO, 'scripts', 'version.mjs');

// Build a minimal sandbox with the same layout the script expects.
function sandbox(version, literal = version) {
  const root = mkdtempSync(join(tmpdir(), 'icarus-version-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'crate', 'mneme-node'), { recursive: true });
  copyFileSync(SCRIPT, join(root, 'scripts', 'version.mjs'));
  writeFileSync(join(root, 'VERSION'), `${version}\n`);
  writeFileSync(
    join(root, 'crate', 'mneme-node', 'cli-lib.js'),
    `'use strict';\n// a stand-in for the real 2000-line module\nconst ICARUS_VERSION = '${literal}';\nmodule.exports = { ICARUS_VERSION };\n`,
  );
  return root;
}

function run(root, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [join(root, 'scripts', 'version.mjs'), ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function withSandbox(version, literal, fn) {
  const root = sandbox(version, literal);
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('prints the authoritative version from VERSION', () => {
  withSandbox('1.2.3', '1.2.3', (root) => {
    assert.equal(run(root).stdout.trim(), '1.2.3');
  });
});

test('--check passes when VERSION and the baked literal agree', () => {
  withSandbox('1.2.3', '1.2.3', (root) => {
    const r = run(root, ['--check']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /in sync/);
  });
});

test('--check FAILS on drift, naming both values', () => {
  withSandbox('1.2.3', '9.9.9', (root) => {
    const r = run(root, ['--check']);
    assert.equal(r.code, 1, 'drift must be a non-zero exit so CI blocks the merge');
    assert.match(r.stderr, /DRIFT/);
    assert.match(r.stderr, /9\.9\.9/, 'reports what the file actually has');
    assert.match(r.stderr, /1\.2\.3/, 'reports what VERSION says it should be');
  });
});

test('--write resyncs the literal from VERSION', () => {
  withSandbox('2.0.0', '1.0.0', (root) => {
    assert.equal(run(root, ['--write']).code, 0);
    const text = readFileSync(join(root, 'crate', 'mneme-node', 'cli-lib.js'), 'utf8');
    assert.ok(text.includes("const ICARUS_VERSION = '2.0.0';"));
    assert.equal(run(root, ['--check']).code, 0, '--check must pass immediately after --write');
  });
});

test('--write is idempotent and reports no change when already in sync', () => {
  withSandbox('3.1.4', '3.1.4', (root) => {
    const r = run(root, ['--write']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /already in sync/);
  });
});

test('--set updates VERSION and propagates in one step', () => {
  withSandbox('1.0.0', '1.0.0', (root) => {
    assert.equal(run(root, ['--set', '4.5.6']).code, 0);
    assert.equal(readFileSync(join(root, 'VERSION'), 'utf8').trim(), '4.5.6');
    const text = readFileSync(join(root, 'crate', 'mneme-node', 'cli-lib.js'), 'utf8');
    assert.ok(text.includes("const ICARUS_VERSION = '4.5.6';"));
  });
});

test('--set rejects a non-semver argument instead of writing garbage', () => {
  withSandbox('1.0.0', '1.0.0', (root) => {
    const r = run(root, ['--set', 'not-a-version']);
    assert.equal(r.code, 1);
    assert.equal(readFileSync(join(root, 'VERSION'), 'utf8').trim(), '1.0.0', 'VERSION untouched on rejection');
  });
});

test('--set accepts a prerelease version', () => {
  withSandbox('1.0.0', '1.0.0', (root) => {
    assert.equal(run(root, ['--set', '0.4.0-preview.1']).code, 0);
    assert.equal(readFileSync(join(root, 'VERSION'), 'utf8').trim(), '0.4.0-preview.1');
  });
});

test('a malformed VERSION file fails loudly rather than shipping a bad version', () => {
  withSandbox('1.0.0', '1.0.0', (root) => {
    writeFileSync(join(root, 'VERSION'), 'banana\n');
    const r = run(root, ['--check']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not a semver/);
  });
});

test('a missing version declaration is reported, not silently ignored', () => {
  withSandbox('1.0.0', '1.0.0', (root) => {
    writeFileSync(join(root, 'crate', 'mneme-node', 'cli-lib.js'), "'use strict';\n// literal removed\n");
    const r = run(root, ['--check']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no version declaration matched/);
  });
});

test('trailing whitespace in VERSION is tolerated', () => {
  withSandbox('1.2.3', '1.2.3', (root) => {
    writeFileSync(join(root, 'VERSION'), '  1.2.3  \n\n');
    assert.equal(run(root, ['--check']).code, 0);
  });
});

// ── the real repository ────────────────────────────────────────────────────────────────
test('the REAL repo is in sync — this is the gate CI enforces', () => {
  const r = run(REPO, ['--check']);
  assert.equal(r.code, 0, `real repo version drift:\n${r.stderr}`);
});
