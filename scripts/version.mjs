#!/usr/bin/env node
// Single source of truth for the ICARUS CLI release version: the root VERSION file.
//
// WHY A PROPAGATION SCRIPT INSTEAD OF READING VERSION AT RUNTIME
//   The shipped artifact is a single self-contained executable produced by
//   `bun build --compile`. A runtime `fs.readFileSync('VERSION')` would look for a file
//   that does not exist next to the installed binary (users get ONE file in
//   ~/.icarus/bin/icarus, no repo), so the version has to be baked in at build time.
//   Keeping the literal in cli-lib.js is therefore required; keeping it in sync BY HAND
//   is what this script removes. VERSION is authoritative, the literal is generated, and
//   `--check` makes drift a CI failure instead of a surprise in a release.
//
//   Historically the literal was the only copy and every release bumped it manually. That
//   is exactly how a tag, a binary, and an update check end up disagreeing.
//
// SCOPE — deliberately does NOT touch crate/mneme-node/package.json.
//   `singulance-amr` is the napi engine package and versions independently of the CLI
//   (HARNESS_V1_PLAN.md Phase 0: "Keep the singulance-amr engine package on its own
//   package version"). Conflating them would force an engine publish for every CLI patch.
//
// USAGE
//   node scripts/version.mjs            # print the authoritative version
//   node scripts/version.mjs --check    # exit 1 if any target has drifted (CI gate)
//   node scripts/version.mjs --write    # rewrite targets from VERSION
//   node scripts/version.mjs --set X.Y.Z  # set VERSION, then write targets

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_FILE = join(ROOT, 'VERSION');

// Each target names the file, a regex capturing the version, and how to rebuild the line.
// Add new consumers here rather than teaching them to parse VERSION at runtime.
const TARGETS = [
  {
    file: join(ROOT, 'crate/mneme-node/cli-lib.js'),
    // Anchored to the exact declaration so a version-shaped string elsewhere in this
    // ~2000-line file can never be rewritten by accident.
    pattern: /^const ICARUS_VERSION = '([^']+)';$/m,
    render: (v) => `const ICARUS_VERSION = '${v}';`,
  },
];

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function readVersion() {
  let raw;
  try {
    raw = readFileSync(VERSION_FILE, 'utf8');
  } catch {
    fail(`missing ${VERSION_FILE} — the CLI version has no source of truth`);
  }
  const v = raw.trim();
  if (!SEMVER.test(v)) {
    fail(`VERSION contains ${JSON.stringify(v)}, which is not a semver string`);
  }
  return v;
}

function fail(msg) {
  process.stderr.write(`version: ${msg}\n`);
  process.exit(1);
}

function inspect(version) {
  return TARGETS.map((t) => {
    let text;
    try {
      text = readFileSync(t.file, 'utf8');
    } catch {
      return { ...t, found: null, ok: false, missing: true };
    }
    const m = text.match(t.pattern);
    return { ...t, text, found: m ? m[1] : null, ok: Boolean(m) && m[1] === version };
  });
}

const args = new Set(process.argv.slice(2));
const setIdx = process.argv.indexOf('--set');

if (setIdx !== -1) {
  const next = process.argv[setIdx + 1];
  if (!next || !SEMVER.test(next)) fail(`--set needs a semver argument, got ${JSON.stringify(next ?? '')}`);
  writeFileSync(VERSION_FILE, `${next}\n`);
  process.stdout.write(`version: VERSION -> ${next}\n`);
  args.add('--write');
}

const version = readVersion();
const results = inspect(version);

if (args.has('--check')) {
  const bad = results.filter((r) => !r.ok);
  if (bad.length === 0) {
    process.stdout.write(`version: ${version} — all ${results.length} target(s) in sync\n`);
    process.exit(0);
  }
  for (const r of bad) {
    if (r.missing) process.stderr.write(`version: MISSING FILE ${r.file}\n`);
    else if (r.found === null) process.stderr.write(`version: no version declaration matched in ${r.file}\n`);
    else process.stderr.write(`version: DRIFT ${r.file}: has ${r.found}, VERSION says ${version}\n`);
  }
  process.stderr.write('version: run `node scripts/version.mjs --write` to resync\n');
  process.exit(1);
}

if (args.has('--write')) {
  let changed = 0;
  for (const r of results) {
    if (r.missing) fail(`cannot write, missing file: ${r.file}`);
    if (r.found === null) fail(`cannot write, no version declaration matched in ${r.file}`);
    if (r.ok) continue;
    writeFileSync(r.file, r.text.replace(r.pattern, r.render(version)));
    process.stdout.write(`version: ${r.file} ${r.found} -> ${version}\n`);
    changed++;
  }
  process.stdout.write(changed ? `version: ${changed} target(s) updated\n` : 'version: already in sync\n');
  process.exit(0);
}

process.stdout.write(`${version}\n`);
