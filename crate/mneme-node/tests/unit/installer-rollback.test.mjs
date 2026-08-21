import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const INSTALLER = join(ROOT, 'install.sh');

test('installer restores a valid CLI after a replacement failure or interrupted handoff', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'icarus-installer-rollback-'));
  try {
    // Source the real installer functions without running its interactive main routine. The
    // installer receives an isolated ICARUS_HOME before it is sourced, so this test can never
    // touch a developer's actual ~/.icarus installation.
    const installerLibrary = join(fixture, 'install-lib.sh');
    writeFileSync(
      installerLibrary,
      readFileSync(INSTALLER, 'utf8').replace(/\nmain "\$@"\s*$/, '\n'),
      { mode: 0o700 },
    );
    const good = join(fixture, 'good-cli');
    const bad = join(fixture, 'bad-cli');
    writeFileSync(good, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o700 });
    writeFileSync(bad, '#!/usr/bin/env bash\nexit 1\n', { mode: 0o700 });
    const home = join(fixture, 'home');
    const script = `
      set -euo pipefail
      export ICARUS_HOME=${JSON.stringify(home)}
      source ${JSON.stringify(installerLibrary)}
      mkdir -p "$BIN_DIR"

      # Successful replacement retains the last known-good executable.
      cp ${JSON.stringify(good)} "$BIN_DIR/icarus"
      cp ${JSON.stringify(bad)} "$BIN_DIR/candidate"
      commit_verified_binary "$BIN_DIR/candidate"
      ! "$BIN_DIR/icarus"
      "$BIN_DIR/icarus.previous"

      # If the process dies after staging the old target, the next installer restores it.
      mv "$BIN_DIR/icarus" "$BIN_DIR/icarus.rollback-tmp"
      recover_interrupted_binary_install
      ! "$BIN_DIR/icarus"
      test ! -e "$BIN_DIR/icarus.rollback-tmp"

      # A failed candidate move puts the already working target back in place immediately.
      cp ${JSON.stringify(good)} "$BIN_DIR/icarus"
      cp ${JSON.stringify(bad)} "$BIN_DIR/candidate"
      mv() {
        if [ "$1" = "$BIN_DIR/candidate" ]; then return 1; fi
        command mv "$@"
      }
      ! commit_verified_binary "$BIN_DIR/candidate"
      "$BIN_DIR/icarus"
    `;
    execFileSync('bash', ['-c', script], { cwd: ROOT, stdio: 'pipe' });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
  assert.ok(true);
});
