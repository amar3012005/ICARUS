import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const INSTALLER = join(ROOT, 'install.sh');

test('installer persists exactly one ICARUS PATH block for each shell startup mode', {
  skip: process.platform === 'win32' ? 'POSIX shell startup files are not present on Windows' : false,
}, () => {
  const fixture = mkdtempSync(join(tmpdir(), 'icarus-installer-path-'));
  try {
    const installerLibrary = join(fixture, 'install-lib.sh');
    writeFileSync(installerLibrary, readFileSync(INSTALLER, 'utf8').replace(/\nmain "\$@"\s*$/, '\n'), { mode: 0o700 });
    const home = join(fixture, 'home');
    const bin = join(home, '.icarus', 'bin');
    const script = `
      set -euo pipefail
      export HOME=${JSON.stringify(home)}
      export ICARUS_HOME=${JSON.stringify(join(home, '.icarus'))}
      export PATH=${JSON.stringify(`${bin}:/usr/bin:/bin`)}
      source ${JSON.stringify(installerLibrary)}
      mkdir -p "$BIN_DIR"
      printf '#!/usr/bin/env bash\\nexit 0\\n' > "$BIN_DIR/icarus"
      chmod +x "$BIN_DIR/icarus"
      ensure_path
      ensure_path
      for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
        test -f "$rc"
        test "$(grep -Fc '# >>> ICARUS PATH >>>' "$rc")" = 1
        grep -Fqx 'export PATH="${bin}:$PATH"' "$rc"
      done
      test ! -e "$HOME/.bash_profile"
      HOME="$HOME" PATH=/usr/bin:/bin bash --noprofile --rcfile "$HOME/.bashrc" -ic 'command -v icarus | grep -Fqx "${bin}/icarus"'
    `;
    execFileSync('bash', ['-c', script], { cwd: ROOT, stdio: 'pipe' });
    for (const rc of ['.profile', '.bashrc', '.zshrc']) assert.ok(existsSync(join(home, rc)));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
