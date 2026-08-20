// Real-subprocess smoke tests for the CLI entrypoint.
//
// Unit tests import functions; these run `node mneme-cli.js ...` as an actual process, which
// is the only way to catch a whole class of shipped failures that import-level tests cannot:
//   - a top-level throw in the entrypoint,
//   - a missing/renamed require path,
//   - the interactive TUI being launched (and hanging forever) in a non-TTY context. That
//     last one is real: the TUI needs raw mode, so a piped/CI invocation MUST fail loudly
//     with guidance instead of blocking. A hang in CI is far worse than a red test.
//
// Deliberately limited to commands that do NOT require the native addon or a built shard, so
// this file runs on a bare checkout with no Cargo toolchain. Shard-backed behaviour belongs
// in tests/engine/, gated on a real `napi build`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'mneme-cli.js');   // tests/smoke -> tests -> mneme-node

// Every invocation gets a hard timeout: if the CLI ever regresses into waiting on stdin, the
// test fails in seconds instead of wedging the whole CI run.
function cli(args, { input = '' } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      input,
      timeout: 20_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    if (e.killed || e.signal) {
      throw new Error(`CLI hung or was killed (signal ${e.signal}) for args: ${args.join(' ')}`);
    }
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

test('REGRESSION: an unknown subcommand exits 2, not 0', () => {
  // This used to print the help text and exit 0, so a typo in a script or CI step silently
  // "succeeded" while doing nothing at all. Exit 2 is the wrong-usage convention, kept
  // distinct from 1 ("ran, and failed") so callers can tell the two apart.
  const r = cli(['definitely-not-a-real-subcommand']);
  assert.equal(r.code, 2);
});

test('an unknown subcommand names the offending command on STDERR', () => {
  const r = cli(['definitely-not-a-real-subcommand']);
  assert.match(r.stderr, /unknown command/i, 'the diagnostic belongs on stderr');
  assert.match(r.stderr, /definitely-not-a-real-subcommand/, 'and must quote what was actually typed');
});

test('help still goes to STDOUT so `icarus --help | less` works', () => {
  const r = cli(['definitely-not-a-real-subcommand']);
  assert.match(r.stdout, /memory filesystem CLI/, 'usage text is stdout, not stderr');
});

test('explicitly asking for help is NOT an error', () => {
  for (const arg of ['--help', '-h', 'help']) {
    assert.equal(cli([arg]).code, 0, `${arg} must exit 0`);
  }
});

test('a bare invocation under a pipe prints help and exits 0 (documented behaviour)', () => {
  // On a real TTY this launches the interactive shell; under a pipe there is no terminal to
  // type into, so falling through to plain-text help is correct — and must not hang. If it
  // ever does, cli()'s timeout turns that into a fast failure instead of a wedged CI run.
  const r = cli([]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /memory filesystem CLI/);
});

test('--version prints ONLY the bare version, matching VERSION exactly', async () => {
  const { readFileSync } = await import('node:fs');
  const expected = readFileSync(join(HERE, '..', '..', '..', '..', 'VERSION'), 'utf8').trim();
  for (const arg of ['--version', '-v', 'version']) {
    const r = cli([arg]);
    assert.equal(r.code, 0, `${arg} must exit 0`);
    assert.equal(
      r.stdout.trim(), expected,
      `${arg} must print exactly the version so release automation can compare it to the tag`,
    );
  }
});

test('the entrypoint parses and loads without a native addon present', () => {
  // cli-lib.js loads the Rust addon LAZILY on purpose, so commands that never touch a shard
  // work on a checkout with no Cargo build. If someone converts that to a top-level require,
  // every no-toolchain install breaks — this catches it.
  const r = cli(['definitely-not-a-real-subcommand']);
  const text = r.stderr + r.stdout;
  assert.ok(
    !/Cannot find module|\.node|napi/i.test(text),
    `addon loading must not be required for basic dispatch, got: ${JSON.stringify(text.slice(0, 300))}`,
  );
});
