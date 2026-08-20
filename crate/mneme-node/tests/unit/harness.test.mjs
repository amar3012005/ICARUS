import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { initHarness, loadManifest, appendRuntimeEvent, verifyEventChain, doctor } = require('../../harness.js');

function tmpRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'icarus-harness-'));
  writeFileSync(join(repo, '.git'), 'gitdir: fake\n');
  return repo;
}

test('harness init creates the tracked contract and ignores only runtime state', () => {
  const repo = tmpRepo();
  try {
    const first = initHarness(repo, { agents: ['claude', 'codex'] });
    assert.equal(first.created, true);
    assert.ok(existsSync(join(repo, '.icarus', 'manifest.yaml')));
    assert.ok(existsSync(join(repo, '.icarus', 'policies', 'default.yaml')));
    assert.ok(existsSync(join(repo, '.icarus', 'schemas', 'manifest.schema.json')));
    assert.ok(existsSync(join(repo, '.icarus', 'runtime')));
    assert.match(readFileSync(join(repo, '.gitignore'), 'utf8'), /^\.icarus\/runtime\/$/m);

    const manifest = loadManifest(repo);
    assert.equal(manifest.schema_version, 1);
    assert.match(manifest.repo_id, /^repo-[a-f0-9]{16}$/);
    assert.deepEqual(manifest.agents, ['claude', 'codex']);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('harness init is idempotent and never changes an established repo identity', () => {
  const repo = tmpRepo();
  try {
    initHarness(repo, { agents: ['claude'] });
    const before = loadManifest(repo);
    const again = initHarness(repo, { agents: ['codex'] });
    const after = loadManifest(repo);
    assert.equal(again.created, false);
    assert.equal(after.repo_id, before.repo_id);
    assert.deepEqual(after.agents, ['claude'], 'a repeat init must not silently alter policy');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('harness init safely copies an existing graph into runtime without deleting the legacy graph', () => {
  const repo = tmpRepo();
  try {
    mkdirSync(join(repo, '.icarus-graph'), { recursive: true });
    writeFileSync(join(repo, '.icarus-graph', 'graph.db'), 'legacy graph bytes');
    const result = initHarness(repo);
    assert.equal(result.graph_migrated, true);
    assert.equal(readFileSync(join(repo, '.icarus', 'runtime', 'graph', 'graph.db'), 'utf8'), 'legacy graph bytes');
    assert.equal(readFileSync(join(repo, '.icarus-graph', 'graph.db'), 'utf8'), 'legacy graph bytes');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('runtime events form a tamper-evident hash chain', () => {
  const repo = tmpRepo();
  try {
    const { manifest } = initHarness(repo);
    appendRuntimeEvent(repo, { execution_id: 'exec-1', task_id: 'TASK-1', event_type: 'created', payload: { objective: 'ship it' } });
    appendRuntimeEvent(repo, { execution_id: 'exec-1', task_id: 'TASK-1', event_type: 'checkpoint', payload: { phase: 'recon' } });
    assert.deepEqual(verifyEventChain(repo, manifest.repo_id), { valid: true, events: 2, issues: [] });

    const path = join(repo, '.icarus', 'runtime', 'logs', 'events.jsonl');
    writeFileSync(path, readFileSync(path, 'utf8').replace('ship it', 'ship them'));
    const result = verifyEventChain(repo, manifest.repo_id);
    assert.equal(result.valid, false);
    assert.match(result.issues[0], /hash mismatch/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('doctor reports an actionable healthy baseline, then exposes tampered runtime history', () => {
  const repo = tmpRepo();
  try {
    const { manifest } = initHarness(repo);
    const clean = doctor(repo);
    assert.equal(clean.healthy, true);
    assert.equal(clean.repo_id, manifest.repo_id);
    assert.ok(clean.checks.some((check) => check.id === 'runtime_writable' && check.status === 'pass'));

    appendRuntimeEvent(repo, { execution_id: 'exec-1', task_id: 'TASK-1', event_type: 'created' });
    const eventFile = join(repo, '.icarus', 'runtime', 'logs', 'events.jsonl');
    writeFileSync(eventFile, readFileSync(eventFile, 'utf8').replace('exec-1', 'exec-2'));
    const tampered = doctor(repo);
    assert.equal(tampered.healthy, false);
    assert.ok(tampered.checks.some((check) => check.id === 'event_chain' && check.status === 'fail'));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
