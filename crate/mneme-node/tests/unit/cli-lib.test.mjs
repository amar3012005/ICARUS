// Pure-logic helpers from cli-lib.js — org naming, repo-local shard discovery, ingestable
// file scanning, chunking. Deliberately NO native addon and NO shard here: cli-lib.js loads
// the Rust addon lazily precisely so these paths stay testable without a Cargo build, and
// keeping that property honest is itself worth a test run.
//
// Real bugs behind these cases:
//   - repoOrgName feeds every agent's project instruction file. If Claude Code, Codex and
//     Cursor derive different names from the same folder they silently write to three
//     different shards instead of one shared project memory.
//   - findRepoIcarusDataRoot must stop at the repository root; walking past it would adopt
//     an unrelated ancestor's .icarus/ directory and read another project's memories.
//   - scanIngestable reporting zero without explanation produced a confusing
//     "ingested 0 files" success message on directories full of unsupported formats.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  repoOrgName, findRepoIcarusDataRoot, scanIngestable, noIngestableFilesReason, chunk,
  INGESTABLE_EXTS, REL_TYPE, REL_WORD_TO_TYPE, harnessSafeGitignore, cfgForMemoryScope, userOrgName,
  localOnly, hivemindConfigured,
} = require('../../cli-lib.js');
const { daemonCommand, isCompiledIcarusBinary } = require('../../daemon-client.js');

function tmp() {
  return mkdtempSync(join(tmpdir(), 'icarus-test-'));
}

// ── repoOrgName ────────────────────────────────────────────────────────────────────────
test('repoOrgName lowercases the folder name', () => {
  assert.equal(repoOrgName('/tmp/MyProject'), 'myproject');
});

test('repoOrgName replaces runs of invalid characters with a single dash', () => {
  assert.equal(repoOrgName('/tmp/my project!!name'), 'my-project-name');
});

test('repoOrgName keeps underscores and dashes, which the shard charset allows', () => {
  assert.equal(repoOrgName('/tmp/my_repo-2'), 'my_repo-2');
});

test('repoOrgName trims leading and trailing dashes', () => {
  assert.equal(repoOrgName('/tmp/...weird...'), 'weird');
});

test('repoOrgName falls back to "default" when nothing usable survives', () => {
  assert.equal(repoOrgName('/tmp/!!!'), 'default');
});

test('repoOrgName is deterministic — the property every agent adapter depends on', () => {
  const a = repoOrgName('/some/path/Shared Repo');
  const b = repoOrgName('/some/path/Shared Repo');
  assert.equal(a, b);
});

test('repoOrgName output always matches the shard org charset [a-zA-Z0-9_-]{1,64}', () => {
  for (const p of ['/tmp/Wild Name!', '/tmp/a.b.c', '/tmp/über-repo', '/tmp/x'.repeat(3)]) {
    assert.match(repoOrgName(p), /^[a-zA-Z0-9_-]{1,64}$/, `bad org name from ${p}`);
  }
});

// ── findRepoIcarusDataRoot ─────────────────────────────────────────────────────────────
test('findRepoIcarusDataRoot finds a .icarus directory in the starting folder', () => {
  const root = tmp();
  try {
    mkdirSync(join(root, '.icarus'), { recursive: true });
    assert.equal(findRepoIcarusDataRoot(root), join(root, '.icarus', 'data'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('findRepoIcarusDataRoot walks upward to find it', () => {
  const root = tmp();
  try {
    mkdirSync(join(root, '.icarus'), { recursive: true });
    const deep = join(root, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    assert.equal(findRepoIcarusDataRoot(deep), join(root, '.icarus', 'data'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('findRepoIcarusDataRoot returns null when there is no .icarus anywhere', () => {
  const root = tmp();
  try {
    const deep = join(root, 'x', 'y');
    mkdirSync(deep, { recursive: true });
    // A .git at the top stops the walk before it can escape into the real filesystem and
    // accidentally match some ancestor of the temp directory.
    writeFileSync(join(root, '.git'), 'gitdir: fake\n');
    assert.equal(findRepoIcarusDataRoot(deep), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('findRepoIcarusDataRoot stops at the repo root and ignores an ancestor .icarus', () => {
  // The isolation property: another project's memories must never be adopted just because
  // it happens to sit above this repository on disk.
  const outer = tmp();
  try {
    mkdirSync(join(outer, '.icarus'), { recursive: true });   // an unrelated project's shard
    const repo = join(outer, 'inner-repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, '.git'), 'gitdir: fake\n');       // this repo's root marker
    assert.equal(
      findRepoIcarusDataRoot(join(repo, 'src')), null,
      'the walk must stop at inner-repo/.git, not reach outer/.icarus',
    );
  } finally { rmSync(outer, { recursive: true, force: true }); }
});

test('project memory gitignore tracks .amr data and ignores only runtime/graph', () => {
  const result = harnessSafeGitignore('# project rules\n.icarus/\n.icarus/data/\n');
  assert.ok(!/^\.icarus\/?\s*$/m.test(result), 'legacy broad ignore must be removed');
  assert.ok(!/^\.icarus\/data\/?\s*$/m.test(result), 'durable .amr shards must not be gitignored');
  assert.match(result, /^\.icarus\/runtime\/$/m);
  assert.match(result, /^\.icarus-graph\/$/m);
  assert.match(result, /# project rules/, 'unrelated gitignore content survives');
});

test('project memory gitignore migration is idempotent', () => {
  const once = harnessSafeGitignore('.icarus/runtime/\n.icarus-graph/\n');
  assert.equal(harnessSafeGitignore(once), once);
});

test('cfgForMemoryScope user lane writes the global data root', () => {
  const cfg = { dataRoot: '/tmp/repo/.icarus/data', dim: 1024 };
  const resolved = cfgForMemoryScope(cfg, 'default', { scope: 'user' });
  const normalized = String(resolved.cfg.dataRoot).replace(/\\/g, '/');
  assert.match(normalized, /\.icarus\/data$/);
  assert.equal(resolved.org, userOrgName());
});

test('localOnly is on by default so a connected HIVEMIND token is not the memory store', () => {
  const prev = process.env.ICARUS_LOCAL_ONLY;
  try {
    delete process.env.ICARUS_LOCAL_ONLY;
    const connected = { hivemind: { connected: true, token: 'tok', apiUrl: 'https://example.invalid' } };
    assert.equal(localOnly(connected), true);
    assert.equal(hivemindConfigured(connected), false);
    process.env.ICARUS_LOCAL_ONLY = '0';
    assert.equal(localOnly(connected), false);
    assert.equal(hivemindConfigured(connected), true);
  } finally {
    if (prev === undefined) delete process.env.ICARUS_LOCAL_ONLY;
    else process.env.ICARUS_LOCAL_ONLY = prev;
  }
});

test('daemonCommand uses source daemon.js when it exists on this checkout', () => {
  const [cmd, args] = daemonCommand(23269);
  assert.ok(cmd);
  assert.ok(args.includes('--run'));
  assert.ok(args.includes('23269'));
  if (!isCompiledIcarusBinary()) {
    assert.ok(args.some((a) => String(a).endsWith('daemon.js')));
  }
});

// ── scanIngestable / noIngestableFilesReason ───────────────────────────────────────────
test('scanIngestable finds supported files and counts skipped extensions', () => {
  const root = tmp();
  try {
    writeFileSync(join(root, 'a.md'), 'hello');
    writeFileSync(join(root, 'b.txt'), 'hello');
    writeFileSync(join(root, 'c.pdf'), 'binary-ish');
    writeFileSync(join(root, 'd.png'), 'binary-ish');
    const { files, skippedByExt } = scanIngestable(root);
    assert.equal(files.length, 2, 'only .md and .txt are ingestable by the local engine');
    assert.equal(skippedByExt.get('.pdf'), 1);
    assert.equal(skippedByExt.get('.png'), 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scanIngestable recurses into subdirectories', () => {
  const root = tmp();
  try {
    mkdirSync(join(root, 'nested', 'deeper'), { recursive: true });
    writeFileSync(join(root, 'nested', 'deeper', 'x.md'), 'hello');
    assert.equal(scanIngestable(root).files.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('noIngestableFilesReason explains a real zero-result instead of reporting silent success', () => {
  const root = tmp();
  try {
    writeFileSync(join(root, 'a.pdf'), 'x');
    writeFileSync(join(root, 'b.pdf'), 'x');
    writeFileSync(join(root, 'c.png'), 'x');
    const reason = noIngestableFilesReason(root);
    assert.ok(reason, 'a directory with only unsupported files must produce an explanation');
    assert.match(reason, /2 \.pdf/, 'the real per-extension counts belong in the message');
    assert.match(reason, /1 \.png/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('noIngestableFilesReason returns null when ingestable files exist', () => {
  const root = tmp();
  try {
    writeFileSync(join(root, 'a.md'), 'hello');
    writeFileSync(join(root, 'b.pdf'), 'x');
    assert.equal(noIngestableFilesReason(root), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('noIngestableFilesReason returns null for an empty directory — nothing to explain', () => {
  const root = tmp();
  try {
    assert.equal(noIngestableFilesReason(root), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('INGESTABLE_EXTS covers the documented local set', () => {
  for (const ext of ['.txt', '.md', '.json', '.csv', '.log']) {
    assert.ok(INGESTABLE_EXTS.has(ext), `${ext} should be locally ingestable`);
  }
});

// ── chunk ──────────────────────────────────────────────────────────────────────────────
// `size` counts WORDS, not characters. Every non-whitespace word must survive chunking: short
// whole documents remain recallable, while a short final tail is folded into the previous chunk
// instead of becoming a low-value standalone fragment.
test('chunk splits on word count, not character count', () => {
  const text = Array.from({ length: 2500 }, (_, i) => `word${i}`).join(' ');
  const parts = chunk(text, 900);
  assert.equal(parts.length, 3, '2500 words at 900 words/chunk = 3 pieces');
});

test('chunk preserves every word across the split', () => {
  const words = Array.from({ length: 2500 }, (_, i) => `word${i}`);
  const parts = chunk(words.join(' '), 900);
  assert.deepEqual(parts.join(' ').split(' '), words, 'no word may be lost or duplicated');
});

test('chunk treats whitespace-free text as a single word, so it does not split', () => {
  const parts = chunk('abcdefghij'.repeat(300), 900); // 3000 chars, ZERO spaces
  assert.equal(parts.length, 1, 'no whitespace means one word means one chunk');
});

test('REGRESSION: chunk preserves a short non-whitespace document', () => {
  assert.deepEqual(chunk('short', 900), ['short']);
  assert.deepEqual(chunk('tiny bit of text', 900), ['tiny bit of text']);
});

test('REGRESSION: chunk merges a short final tail instead of discarding it', () => {
  const words = [...Array.from({ length: 900 }, (_, i) => `word${i}`), 'tail'];
  const parts = chunk(words.join(' '), 900);
  assert.equal(parts.length, 1, 'the tiny tail should not become a standalone index fragment');
  assert.deepEqual(parts.join(' ').split(' '), words, 'the tail must remain present');
});

test('chunk ignores content that is only whitespace', () => {
  assert.deepEqual(chunk('  \n\t  ', 900), []);
});

// ── relationship enum ──────────────────────────────────────────────────────────────────
test('REL_WORD_TO_TYPE maps agent-facing verbs onto real edge types', () => {
  // 'update' -> 'Updates' is why a capitalize-first-letter heuristic cannot be used here.
  assert.equal(REL_WORD_TO_TYPE.update, REL_TYPE.Updates);
  assert.equal(REL_WORD_TO_TYPE.extend, REL_TYPE.Extends);
  assert.equal(REL_WORD_TO_TYPE.derive, REL_TYPE.Derives);
  assert.equal(REL_WORD_TO_TYPE.contradict, REL_TYPE.Contradicts);
  assert.equal(REL_WORD_TO_TYPE.partof, REL_TYPE.PartOf);
  assert.equal(REL_WORD_TO_TYPE.mentions, REL_TYPE.Mentions);
});

test('REL_TYPE values are the stable wire numbers the native engine expects', () => {
  assert.deepEqual(REL_TYPE, {
    Mentions: 1, Updates: 2, Derives: 3, Contradicts: 4, PartOf: 5, Extends: 6,
  });
});
