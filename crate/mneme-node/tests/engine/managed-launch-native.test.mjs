// A fake coding-agent process lets CI exercise the real managed-launch boundary without a
// Claude/Codex subscription or network call. It is intentionally not adapter certification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
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

// The production launcher resolves adapters through the host's normal command lookup. Windows
// does not consider an extensionless POSIX script executable through PATHEXT, so expose the same
// fixture through a tiny .cmd bridge there rather than weakening the real adapter lookup.
function makeAgentShimExecutable(shim) {
  chmodSync(shim, 0o755);
  if (process.platform === 'win32') {
    writeFileSync(`${shim}.cmd`, '@echo off\r\n"%ProgramFiles%\\Git\\bin\\bash.exe" "%~dp0' + shim.split(/[\\/]/).pop() + '" %*\r\n');
  }
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
    const inspection = requireSuccess(['context', 'inspect', '--task', taskId, '--repo', repo], { env });
    assert.match(inspection.output, new RegExp(`context inspection.*${taskId}`));
    assert.match(inspection.output, /Rust-selected item\(s\)/);
    assert.match(inspection.output, /source: .*contract/);

    // This shim extracts the Rust-generated task id from Claude settings, obtains a pre-write
    // authorization, writes the scoped file, and records a post-write receipt.
    const shim = join(shimDir, 'claude');
    writeFileSync(shim, `#!/bin/sh
set -eu
if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then
  printf 'fake claude 0.0.0\\n'
  exit 0
fi
settings=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --settings) settings="$2"; shift 2 ;;
    *) shift ;;
  esac
done
task=$(grep -o -- '--task [^ ]*' "$settings" | head -n 1 | sed 's/--task //')
[ -n "$task" ]
repo=$(pwd -W 2>/dev/null || pwd)
# Adapter tool events may use a workspace-relative path. That avoids leaking Git Bash's `/c/...`
# presentation into the Windows-native Rust authority while exercising the same scoped write.
printf '%s\\n' '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"src/fake-agent.txt"}}' | node "$ICARUS_TEST_CLI" harness hook --task "$task" --event pre-tool --repo "$repo"
if printf '%s\\n' '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"README.md"}}' | node "$ICARUS_TEST_CLI" harness hook --task "$task" --event pre-tool --repo "$repo"; then
  exit 74
fi
printf 'adapter edit was authorized\\n' > src/fake-agent.txt
printf '%s\\n' '{"hook_event_name":"PostToolUse","tool_name":"Write","tool_input":{"file_path":"src/fake-agent.txt"}}' | node "$ICARUS_TEST_CLI" harness hook --task "$task" --event post-tool --repo "$repo"
`);
    makeAgentShimExecutable(shim);
    const launched = requireSuccess(['run', '--task', taskId, '--agent', 'claude', '--workspace', 'current', '--acknowledge-dirty-current', '--repo', repo], {
      env: { ...env, PATH: `${shimDir}${delimiter}${process.env.PATH}`, ICARUS_TEST_CLI: CLI },
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
    const denialFiles = readdirSync(join(repo, '.icarus/runtime/denials'));
    assert.equal(denialFiles.length, 1);
    const denialId = denialFiles[0].replace(/\.json$/, '');
    const explanation = requireSuccess(['policy', 'explain', denialId, '--repo', repo], { env });
    assert.match(explanation.output, new RegExp(`policy denial.*${denialId}`));
    assert.match(explanation.output, /README\.md/);
    assert.match(explanation.output, /outside the declared task contract/);
    const doctor = requireSuccess(['doctor', '--repo', repo], {
      env: { ...env, PATH: `${shimDir}${delimiter}${process.env.PATH}` },
    });
    assert.match(doctor.output, /event_chain.*verified/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('experimental Codex app-server launch stays in the Rust native authority end-to-end', () => {
  const root = mkdtempSync(join(tmpdir(), 'icarus-codex-app-server-'));
  const shimDir = join(root, 'bin');
  const repo = join(root, 'repo');
  const contractPath = join(root, 'contract.json');
  try {
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(repo, 'README.md'), 'native Codex fixture\n');
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
    requireSuccess(['harness', 'init', '--agent', 'codex', '--repo', repo], { env });
    git(['add', '.icarus']);
    git(['commit', '-qm', 'add harness contract']);
    const started = requireSuccess(['task', 'start', '--objective', 'native Codex fixture', '--contract', contractPath, '--repo', repo], { env });
    const taskId = started.output.match(/started\s+(TASK-[A-Z0-9]+)/)?.[1];
    assert.ok(taskId, `task id missing from: ${started.output}`);
    for (const state of ['orienting', 'contracted', 'planned']) {
      requireSuccess(['task', 'transition', taskId, state, '--repo', repo], { env });
    }
    const shim = join(shimDir, 'codex');
    writeFileSync(shim, `#!/bin/sh
set -eu
if [ "${'$'}#" -eq 1 ] && [ "${'$'}1" = "--version" ]; then printf 'fake codex 0.0.0\\n'; exit 0; fi
[ "${'$'}1" = "app-server" ] || exit 71
while IFS= read -r line; do
  case "${'$'}line" in
    *'"method":"initialize"'*) echo '{"id":1,"result":{}}' ;;
    *'"method":"thread/start"'*)
      echo '{"method":"thread/started","params":{"thread":{"id":"thread-native"}}}'
      echo '{"id":2,"result":{"thread":{"id":"thread-native"}}}' ;;
    *'"method":"turn/start"'*)
      echo '{"id":3,"result":{"turn":{"id":"turn-native"}}}'
      echo '{"method":"item/started","params":{"threadId":"thread-native","turnId":"turn-native","item":{"id":"item-native","type":"fileChange","status":"inProgress","changes":[{"path":"src/native.rs","diff":"@@","kind":{"type":"add"}}]}}}'
      echo '{"id":90,"method":"item/fileChange/requestApproval","params":{"threadId":"thread-native","turnId":"turn-native","itemId":"item-native","startedAtMs":1}}'
      IFS= read -r approval
      case "${'$'}approval" in *'"decision":"accept"'*) ;; *) exit 72 ;; esac
      echo '{"method":"turn/started","params":{"threadId":"thread-native","turnId":"turn-native","startedAtMs":2}}'
      echo '{"method":"item/completed","params":{"threadId":"thread-native","turnId":"turn-native","completedAtMs":3,"item":{"id":"item-native","type":"fileChange","status":"completed","changes":[{"path":"src/native.rs","diff":"@@","kind":{"type":"add"}}]}}}'
      echo '{"method":"turn/completed","params":{"threadId":"thread-native","turn":{"id":"turn-native"}}}'
      exit 0 ;;
  esac
done
exit 73
`);
    makeAgentShimExecutable(shim);
    const launched = requireSuccess(['run', '--task', taskId, '--agent', 'codex', '--workspace', 'current', '--acknowledge-dirty-current', '--codex-app-server', '--repo', repo], {
      env: { ...env, PATH: `${shimDir}${delimiter}${process.env.PATH}` },
    });
    assert.match(launched.output, /→ verifying/);
    const events = readFileSync(join(repo, '.icarus/runtime/logs/events.jsonl'), 'utf8');
    for (const eventType of ['codex_app_server_thread_bound', 'codex_app_server_approval_authorized', 'codex_app_server_turn_completed', 'adapter_session_ended']) {
      assert.match(events, new RegExp(eventType));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
