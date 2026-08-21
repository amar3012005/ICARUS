// Node's test runner does not expand globs itself. POSIX shells happen to expand these paths,
// while PowerShell passes them through literally. Discover the checked-in unit and smoke files
// here so `npm test` means the same complete suite on macOS, Linux, and Windows.
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const suites = ['unit', 'smoke'];
const tests = suites.flatMap((suite) => readdirSync(join(ROOT, 'tests', suite))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => join('tests', suite, name)));

if (!tests.length) throw new Error('no Node test files found');

const child = spawn(process.execPath, ['--test', ...tests], { cwd: ROOT, stdio: 'inherit' });
child.once('error', (error) => { throw error; });
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
