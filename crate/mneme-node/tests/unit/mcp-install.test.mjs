// Project-instruction installers — the marked-block writers behind `/setup` and
// `icarus mcp install <agent>`.
//
// These edit files that belong to the USER's repository (CLAUDE.md, AGENTS.md, a Cursor
// .mdc rule), which makes their failure modes unusually expensive: clobbering a
// hand-written CLAUDE.md, or appending a duplicate block on every run, is real damage to
// someone else's project. The marker-delimited block exists so a re-run REPLACES its own
// block and leaves every surrounding line untouched — that idempotency is what these tests
// pin down.
//
// Everything runs against a temp directory. No global config, no ~/.claude.json, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const mi = require('../../mcp-install.js');

const MARK_START = '<!-- icarus:project-instructions -->';
const MARK_END = '<!-- /icarus:project-instructions -->';

function tmp() { return mkdtempSync(join(tmpdir(), 'icarus-setup-')); }
function withRepo(fn) {
  const repo = tmp();
  try { return fn(repo); } finally { rmSync(repo, { recursive: true, force: true }); }
}

// ── CLAUDE.md ──────────────────────────────────────────────────────────────────────────
test('installProjectClaude creates CLAUDE.md with a delimited block', () => {
  withRepo((repo) => {
    const r = mi.installProjectClaude(repo);
    assert.equal(r.installed, true);
    const text = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
    assert.ok(text.includes(MARK_START), 'start marker present');
    assert.ok(text.includes(MARK_END), 'end marker present');
  });
});

test('the written block names the derived org for this repo', () => {
  withRepo((repo) => {
    const r = mi.installProjectClaude(repo);
    const text = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
    assert.ok(r.orgName && r.orgName.length > 0);
    assert.ok(text.includes(r.orgName), 'the org name agents must pass has to appear in the block');
    assert.equal(r.orgName, mi.repoOrgName(repo), 'must match the shared derivation, not a local variant');
  });
});

test('the project block makes bootstrap and durable memory use explicit without universal task gating', () => {
  withRepo((repo) => {
    mi.installProjectAgents(repo);
    const text = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    assert.ok(text.includes('every new agent session'));
    assert.ok(text.includes('icarus mcp install codex'));
    assert.ok(text.includes('icarus harness init --agent codex --repo .'));
    assert.ok(text.includes('.icarus/manifest.yaml'));
    assert.ok(text.includes('icarus_harness_init'));
    assert.ok(text.includes('Treat an initialization failure as a blocker'));
    assert.ok(text.includes('Risk-based operating policy'));
    assert.ok(text.includes('Fast/read-only lane'));
    assert.ok(text.includes('Full governed lifecycle'));
    assert.ok(text.includes('icarus_recall_bugs'));
    assert.ok(text.includes('icarus_why_code'));
    assert.ok(text.includes('icarus_log_decision'));
    assert.ok(text.includes('icarus_track_refactor'));
    assert.ok(text.includes('icarus_save_memory'));
    assert.ok(text.includes('icarus_graph_build'));
    assert.ok(text.includes('icarus_context_get'));
    assert.ok(text.includes('icarus_task_transition'));
    assert.ok(text.includes('planned → executing'));
    assert.ok(text.includes('icarus_task_verify'));
    assert.ok(text.includes('icarus_harness_skill_authoring_brief'));
    assert.ok(text.includes('without an LLM, embedding key, or reachable remote provider'));
    assert.ok(text.includes('memory:fact'));
    assert.ok(text.includes('memory:decision'));
    assert.ok(text.includes('memory:instruction'));
    assert.ok(text.includes('memory:event'));
    assert.ok(text.includes('memory:task'));
    assert.ok(!text.includes('For every coding task, call `icarus_context_get`'));
  });
});

test('global agent skills contain self-bootstrap and risk-based memory guidance', () => {
  for (const agent of ['codex', 'claude']) {
    const text = mi.globalSkillBody(agent);
    assert.ok(text.includes(`icarus mcp install ${agent}`));
    assert.ok(text.includes(`icarus harness init --agent ${agent} --repo .`));
    assert.ok(text.includes('icarus_recall_bugs'));
    assert.ok(text.includes('Use full task governance only for'));
    assert.ok(text.includes('no LLM key, embedding key, or remote service'));
    assert.ok(text.includes('memory:fact'));
  }
  assert.equal(mi.globalSkillPath('cursor'), null, 'do not invent a Cursor global skill location');
});

test('installProjectClaude PRESERVES pre-existing user content', () => {
  withRepo((repo) => {
    const original = '# My Project\n\nHand-written rules that must survive.\n';
    writeFileSync(join(repo, 'CLAUDE.md'), original);
    mi.installProjectClaude(repo);
    const text = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
    assert.ok(text.includes('# My Project'), 'user heading must survive');
    assert.ok(text.includes('Hand-written rules that must survive.'), 'user prose must survive');
    assert.ok(text.includes(MARK_START), 'and the block is added');
  });
});

test('re-running is IDEMPOTENT — exactly one block, never a duplicate append', () => {
  withRepo((repo) => {
    mi.installProjectClaude(repo);
    mi.installProjectClaude(repo);
    mi.installProjectClaude(repo);
    const text = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
    const starts = text.split(MARK_START).length - 1;
    const ends = text.split(MARK_END).length - 1;
    assert.equal(starts, 1, `expected exactly 1 start marker, found ${starts}`);
    assert.equal(ends, 1, `expected exactly 1 end marker, found ${ends}`);
  });
});

test('re-running refreshes an older managed block while preserving surrounding user content', () => {
  withRepo((repo) => {
    const original = `USER PROLOGUE\n${MARK_START}\nold ICARUS instructions\n${MARK_END}\nUSER EPILOGUE\n`;
    writeFileSync(join(repo, 'AGENTS.md'), original);
    const result = mi.installProjectAgents(repo);
    const text = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    assert.equal(result.reason, 'updated');
    assert.ok(text.includes('USER PROLOGUE'));
    assert.ok(text.includes('USER EPILOGUE'));
    assert.ok(text.includes('icarus_harness_skill_authoring_brief'));
    assert.equal(text.split(MARK_START).length - 1, 1);
  });
});

test('re-running preserves user content added AROUND the block', () => {
  withRepo((repo) => {
    mi.installProjectClaude(repo);
    const withUserEdits = `PROLOGUE\n${readFileSync(join(repo, 'CLAUDE.md'), 'utf8')}\nEPILOGUE\n`;
    writeFileSync(join(repo, 'CLAUDE.md'), withUserEdits);
    mi.installProjectClaude(repo);
    const text = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
    assert.ok(text.includes('PROLOGUE'), 'content before the block must survive a re-run');
    assert.ok(text.includes('EPILOGUE'), 'content after the block must survive a re-run');
    assert.equal(text.split(MARK_START).length - 1, 1, 'still exactly one block');
  });
});

test('detectProjectClaude reports absence and then presence', () => {
  // Note the shape: detect* returns { found, path } — NOT { installed } like install* does.
  // Asserting the wrong field passes vacuously (undefined is falsy), so this pins the field name.
  withRepo((repo) => {
    const before = mi.detectProjectClaude(repo);
    assert.equal(before.found, false, 'nothing installed in a fresh repo');
    mi.installProjectClaude(repo);
    const after = mi.detectProjectClaude(repo);
    assert.equal(after.found, true);
    assert.ok(after.path.endsWith('CLAUDE.md'), 'detect reports which file it inspected');
  });
});

test('removeProjectClaude removes the block and leaves user content intact', () => {
  withRepo((repo) => {
    writeFileSync(join(repo, 'CLAUDE.md'), '# Keep me\n');
    mi.installProjectClaude(repo);
    mi.removeProjectClaude(repo);
    const text = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
    assert.ok(!text.includes(MARK_START), 'block markers gone');
    assert.ok(text.includes('# Keep me'), 'user content retained after removal');
  });
});

// ── AGENTS.md (Codex) and the Cursor rule ──────────────────────────────────────────────
test('installProjectAgents writes AGENTS.md for Codex', () => {
  withRepo((repo) => {
    const r = mi.installProjectAgents(repo);
    assert.equal(r.installed, true);
    assert.ok(existsSync(join(repo, 'AGENTS.md')));
    assert.ok(readFileSync(join(repo, 'AGENTS.md'), 'utf8').includes(MARK_START));
  });
});

test('installProjectCursor writes a .mdc rule with alwaysApply frontmatter', () => {
  withRepo((repo) => {
    const r = mi.installProjectCursor(repo);
    assert.equal(r.installed, true);
    const p = join(repo, '.cursor', 'rules', 'icarus.mdc');
    assert.ok(existsSync(p), 'rule file created at the nested Cursor path');
    const text = readFileSync(p, 'utf8');
    assert.ok(text.includes('alwaysApply: true'), 'without this Cursor would not load the rule every request');
  });
});

test('all three agents derive the SAME org for one repo — the shared-memory guarantee', () => {
  withRepo((repo) => {
    const a = mi.installProjectClaude(repo).orgName;
    const b = mi.installProjectAgents(repo).orgName;
    const c = mi.installProjectCursor(repo).orgName;
    assert.equal(a, b, 'Claude Code and Codex must agree');
    assert.equal(b, c, 'Codex and Cursor must agree');
    // If these diverged, three agents in one repo would silently write to three shards.
  });
});

test('each agent writes only its own file', () => {
  withRepo((repo) => {
    mi.installProjectClaude(repo);
    assert.ok(existsSync(join(repo, 'CLAUDE.md')));
    assert.ok(!existsSync(join(repo, 'AGENTS.md')), 'Claude install must not create Codex files');
    assert.ok(!existsSync(join(repo, '.cursor')), 'Claude install must not create Cursor files');
  });
});

test('installers work in a nested subdirectory path that does not exist yet', () => {
  withRepo((repo) => {
    const nested = join(repo, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    const r = mi.installProjectCursor(nested);
    assert.equal(r.installed, true);
    assert.ok(existsSync(join(nested, '.cursor', 'rules', 'icarus.mdc')));
  });
});

// ── registry shape ─────────────────────────────────────────────────────────────────────
test('AGENT_INSTALLERS exposes the three v1-relevant agents with an mcp step each', () => {
  for (const name of ['claude', 'codex', 'cursor']) {
    const entry = mi.AGENT_INSTALLERS[name];
    assert.ok(entry, `${name} must be registered`);
    assert.equal(typeof entry.mcp, 'function', `${name}.mcp must be callable`);
    assert.equal(typeof entry.project, 'function', `${name}.project must be callable`);
  }
});

test('resolveIcarusCommand returns a non-empty command string', () => {
  const cmd = mi.resolveIcarusCommand();
  assert.equal(typeof cmd, 'string');
  assert.ok(cmd.length > 0, 'agents need a real command to launch the MCP server');
});
