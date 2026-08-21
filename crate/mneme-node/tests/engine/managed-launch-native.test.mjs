// A fake coding-agent process lets CI exercise the real managed-launch boundary without a
// Claude/Codex subscription or network call. It is intentionally not adapter certification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE_DIR = join(HERE, '..', '..');
const CLI = join(NODE_DIR, 'mneme-cli.js');

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: NODE_DIR,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...options.env },
  });
  return { ...result, output: `${result.stdout || ''}${result.stderr || ''}` };
}

function requireSuccess(args, options) {
  const result = run(args, options);
  assert.equal(result.status, 0, `${args.join(' ')} failed:\n${result.output}`);
  return result;
}

test('fake Claude adapter proves governed launch, hook receipts, scope, and handoff end-to-end', () => {
  const root = mkdtempSync(join(tmpdir(), 'icarus-managed-agent-'));
  const shimDir = join(root, 'bin');
  const repo = join(root, 'repo');
  const contractPath = join(root, 'contract.json');
  try {
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(repo, 'README.md'), 'fake agent conformance fixture\n');
    const git = (args) => {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'icarus-test@example.invalid']);
    git(['config', 'user.name', 'ICARUS Test']);
    git(['add', '.']);
    git(['commit', '-qm', 'fixture']);

    writeFileSync(contractPath, JSON.stringify({
      allowed_paths: ['src/**'], forbidden_paths: ['secrets/**'], acceptance_criteria: [],
      risk: 'low', budgets: {}, authority: 'local', external_write_policy: 'approval_required',
    }));
    const env = { ICARUS_HOME: join(root, 'home') };
    requireSuccess(['harness', 'init', '--agent', 'claude', '--repo', repo], { env });
    // The harness contract is deliberately tracked. Commit it before exercising the
    // current-workspace mode, whose Rust gate rejects a dirty repository by default.
    git(['add', '.icarus']);
    git(['commit', '-qm', 'add harness contract']);
    const started = requireSuccess(['task', 'start', '--objective', 'fake agent hook conformance', '--contract', contractPath, '--repo', repo], { env });
    const taskId = started.output.match(/started\s+(TASK-[A-Z0-9]+)/)?.[1];
    assert.ok(taskId, `task id missing from: ${started.output}`);
    for (const state of ['orienting', 'contracted', 'planned']) {
      requireSuccess(['task', 'transition', taskId, state, '--repo', repo], { env });
    }

    // This shim extracts the Rust-generated task id from Claude settings, obtains a pre-write
    // authorization, writes the scoped file, and records a post-write receipt.
    const shim = join(shimDir, 'claude');
    writeFileSync(shim, `#!/bin/sh
set -eu
settings=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --settings) settings="$2"; shift 2 ;;
    *) shift ;;
  esac
done
task=$(grep -o -- '--task [^ ]*' "$settings" | head -n 1 | sed 's/--task //')
[ -n "$task" ]
printf '%s\\n' '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"'"$PWD"'/src/fake-agent.txt"}}' | node "$ICARUS_TEST_CLI" harness hook --task "$task" --event pre-tool --repo "$PWD"
printf 'adapter edit was authorized\\n' > src/fake-agent.txt
printf '%s\\n' '{"hook_event_name":"PostToolUse","tool_name":"Write","tool_input":{"file_path":"'"$PWD"'/src/fake-agent.txt"}}' | node "$ICARUS_TEST_CLI" harness hook --task "$task" --event post-tool --repo "$PWD"
`);
    chmodSync(shim, 0o755);
    const launched = requireSuccess(['run', '--task', taskId, '--agent', 'claude', '--workspace', 'current', '--acknowledge-dirty-current', '--repo', repo], {
      env: { ...env, PATH: `${shimDir}:${process.env.PATH}`, ICARUS_TEST_CLI: CLI },
    });
    assert.match(launched.output, /compatibility mode/);
    assert.match(launched.output, /→ verifying/);
    assert.equal(readFileSync(join(repo, 'src/fake-agent.txt'), 'utf8'), 'adapter edit was authorized\n');

    const status = requireSuccess(['task', 'status', taskId, '--repo', repo], { env });
    assert.match(status.output, new RegExp(`${taskId}\\s+verifying`));
    const events = readFileSync(join(repo, '.icarus/runtime/logs/events.jsonl'), 'utf8');
    for (const eventType of ['adapter_session_started', 'adapter_pre_action_authorized', 'adapter_post_action_observed', 'adapter_session_ended', 'current_workspace_scope_checked']) {
      assert.match(events, new RegExp(eventType));
    }
    const doctor = requireSuccess(['doctor', '--repo', repo], { env });
    assert.match(doctor.output, /event_chain.*verified/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
