// Flag parsing for the TUI's slash commands.
//
// This file exists because of a real, shipped bug: `parseArgs` treated ANY unrecognized
// `--foo` as a value-taking flag and consumed the next token as its value. A user typed
// `/ingest --amar /Users/.../decision-docs` (a typo for `--org amar`) and the path vanished
// into `out.amar`, leaving no positional argument — so the command reported "no path given"
// and opened a folder picker instead of ingesting the directory that was right there on the
// command line. The fix was an explicit whitelist of flags that actually take a value.
//
// Every assertion below is written against that failure mode staying dead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseArgs } = require('../../tui.js');

test('positional arguments are collected in order', () => {
  const f = parseArgs('alpha beta gamma');
  assert.deepEqual(f._, ['alpha', 'beta', 'gamma']);
});

test('empty input yields no positionals and no flags', () => {
  const f = parseArgs('');
  assert.deepEqual(f._, []);
});

test('known value-flags consume the following token', () => {
  const f = parseArgs('/some/path --org acme');
  assert.equal(f.org, 'acme');
  assert.deepEqual(f._, ['/some/path']);
});

test('every documented value-flag takes a value', () => {
  const f = parseArgs('--org o --name n --kind callers_of --repo /r --k 7');
  assert.equal(f.org, 'o');
  assert.equal(f.name, 'n');
  assert.equal(f.kind, 'callers_of');
  assert.equal(f.repo, '/r');
  assert.equal(f.k, '7');
  assert.deepEqual(f._, [], 'no positional should be consumed by value-flags');
});

test('boolean flags do not consume the following token', () => {
  const f = parseArgs('--local /some/path');
  assert.equal(f.local, true);
  assert.deepEqual(f._, ['/some/path'], 'the path must survive a preceding boolean flag');
});

test('all documented boolean flags parse as true', () => {
  const f = parseArgs('--local --force --pq --no-mirror --keep-cloud --cloud --check');
  for (const k of ['local', 'force', 'pq', 'no-mirror', 'keep-cloud', 'cloud', 'check']) {
    assert.equal(f[k], true, `${k} should be boolean true`);
  }
  assert.deepEqual(f._, []);
});

// ── the actual regression ──────────────────────────────────────────────────────────────
test('REGRESSION: an unknown --flag must NOT swallow the following positional', () => {
  const f = parseArgs('--amar /Users/amar/grok-build/Hivemind-docs/decision-docs');
  assert.deepEqual(
    f._,
    ['/Users/amar/grok-build/Hivemind-docs/decision-docs'],
    'the real path must remain a positional argument, not become the typo flag\'s value',
  );
  assert.equal(f.amar, true, 'an unknown flag degrades to boolean');
});

test('REGRESSION: unknown flag after the path also leaves the path intact', () => {
  const f = parseArgs('/some/path --typo --local');
  assert.deepEqual(f._, ['/some/path']);
  assert.equal(f.typo, true);
  assert.equal(f.local, true);
});

test('quoted values with spaces stay one token', () => {
  const f = parseArgs('--org "two words" /path');
  assert.equal(f.org, 'two words');
  assert.deepEqual(f._, ['/path']);
});

test('single-quoted values are supported too', () => {
  const f = parseArgs("--org 'two words'");
  assert.equal(f.org, 'two words');
});

test('a value-flag at the very end yields undefined rather than throwing', () => {
  const f = parseArgs('--org');
  assert.equal(f.org, undefined);
  assert.deepEqual(f._, []);
});
