#!/usr/bin/env node
// Node's test runner does not expand `*.test.mjs` itself, while PowerShell deliberately leaves
// an unmatched glob literal untouched. Resolve the public native-engine corpus in Node so the
// exact same files run on POSIX shells and Windows runners.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const testDir = join(here, '..', 'tests', 'engine');
// The shared-memory daemon intentionally coordinates separate local agents over loopback.
// The macOS sandbox conformance job denies *all* networking, including localhost, so it runs
// only the engine corpus that is meaningful under that restriction. The regular engine job
// always runs this file too and remains the daemon/cross-agent integration gate.
const networkIsolated = process.env.ICARUS_TEST_NETWORK_ISOLATED === '1';
const tests = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .filter((name) => !networkIsolated || name !== 'mcp-native.test.mjs')
  .sort()
  .map((name) => join(testDir, name));

if (tests.length === 0) {
  console.error(`no native engine tests found in ${testDir}`);
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
  child.on('error', (error) => {
    console.error(`could not start Node's test runner: ${error.message}`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
