#!/usr/bin/env node
'use strict';
// icarus CLI — ingest folders, recall, compact, status, connect HIVEMIND, MCP server.
// (Filename/dir stay "mneme" — the internal engine/crate name — but every string a user sees
// says "icarus", matching the CLI binary install.sh actually installs.)
// Zero npm deps beyond the native addon (and @modelcontextprotocol/sdk for `mcp-serve` only);
// embeddings via OpenRouter's baai/bge-m3 by default (any OpenAI-compatible /embeddings endpoint works).
//
// Shared config/embed/ingest/recall logic lives in cli-lib.js — mcp-serve.js requires the SAME
// module, so the CLI and the MCP server can never silently drift onto two different behaviors.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
// Lazy: `mcp install`/`status`/`connect` never touch a shard, so they must not be forced to
// load the native addon just because this file was required.
function getMnemeStore() { return require('./index.js').MnemeStore; }
const {
  HOME, CFG_PATH, loadCfg, saveCfg, statusReport, ingestDir, recallQuery, embeddingsConfigured,
  llmConfigured, skillSave, skillList, parseClaudeTranscript,
  signingEnabled, verifySlot, checkpointAudit, verifyAuditChain,
  hivemindConfigured, hivemindIngestDir, formatHivemindProgress, attemptHivemindOAuth,
  DEFAULT_HIVEMIND_AUTH_URL, DEFAULT_HIVEMIND_API_URL,
  ICARUS_VERSION, checkForUpdate, performSelfUpdate, noIngestableFilesReason, HIVEMIND_INGESTABLE_EXTS, pickFolderNative,
  hivemindSaveMemory, saveLocalMemory, saveIntelligentMemory,
} = require('./cli-lib.js');
const { c, glyphs, heading, ok, err, bullet, rule, spinnerFrame, colorizeHelp } = require('./theme.js');

// Flags that are pure on/off switches (no value token follows) — everything else keeps the
// original "consume the next token as this flag's value" behavior unchanged, so `--k 5`,
// `--org acme`, `--seed 7` etc. are byte-identical to before this set existed. A heuristic
// ("no value follows -> must be boolean") was tried and rejected: it would silently turn a
// user mistyping `--k` with no value into `Number(true) === 1` instead of the intended
// fallback default — a worse failure than the boolean-flag bug it would have fixed.
const BOOLEAN_FLAGS = new Set(['pq', 'disable', 'yes', 'local', 'force', 'oauth-only', 'no-mirror', 'keep-cloud', 'full', 'dry-run', 'acknowledge-dirty-current']);

function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') {
      out.agentArgs = args.slice(i + 1);
      break;
    }
    if (args[i].startsWith('--')) {
      const name = args[i].slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        out[name] = true;
      } else {
        out[name] = args[++i];
      }
    } else {
      out._.push(args[i]);
    }
  }
  return out;
}

// "ICARUS v3" routing: a HIVEMIND-connected workspace (icarus connect) sends ingest through
// HIVEMIND's real hosted API instead of the local v2 engine — automatic, no separate command,
// per the explicit design choice for this feature. `--local` is the escape hatch for anyone who
// wants the local engine even with HIVEMIND connected (e.g. testing, or content that should
// stay off a shared server). `--force` matches the real FE's own `force` field (bypass the
// same-checksum dedup gate). Connected ingest defaults to `ingestMode=evidence`; pass --full to
// request the server's more expensive evidence + memory/entity generation mode.
//
// Default behavior when HIVEMIND-routed: the server does the chunking/OCR/extraction (real work
// ICARUS's local engine can't do for pdf/docx/images), then the resulting segment TEXT is pulled
// back and re-embedded + stored in the LOCAL .amr shard too (see mirrorHivemindDocumentLocally's
// doc comment in cli-lib.js for the one real limitation: the server never exposes its own
// embedding vectors over HTTP, so this is cloud-chunking + local-embedding, not cloud-embedding —
// confirmed by reading the real server code, not assumed). `--no-mirror` skips this and leaves
// the data purely server-side, matching the old behavior.
async function cmdIngest(flags, cfg) {
  let dir = flags._[0];
  const org = flags.org || 'default';
  if (!dir) {
    console.log(c.dim('no path given — opening the native folder picker...'));
    dir = await pickFolderNative(`icarus: select a folder to ingest into org "${org}"`);
    if (!dir) throw new Error('no file or folder selected — usage: icarus ingest <dir|file> --org <name> [--local] [--force] [--no-mirror]');
    console.log(ok(`selected ${c.path(dir)}`));
  }
  const viaHivemind = hivemindConfigured(cfg) && !flags.local;
  const skipReason = noIngestableFilesReason(dir, viaHivemind ? HIVEMIND_INGESTABLE_EXTS : undefined);
  if (skipReason) return console.log(err(skipReason));
  if (viaHivemind) {
    const ingestMode = flags.full ? 'both' : 'evidence';
    console.log(bullet(c.system(`ingesting into HIVEMIND workspace, org tag "${c.path(`icarus-org:${org}`)}"${flags['no-mirror'] ? '' : c.dim(' (mirroring segments into the local shard too)')}`)));
    console.log(c.dim(`  mode: ${ingestMode === 'evidence' ? 'evidence only (fast)' : 'both (memory/entity generation)'}`));
    let tick = 0;
    const result = await hivemindIngestDir(dir, org, cfg, (event) => process.stdout.write(formatHivemindProgress(event, c.running(spinnerFrame(tick++)))), { force: !!flags.force, mirrorLocal: !flags['no-mirror'], purgeCloud: !flags['keep-cloud'], ingestMode });
    const notes = [];
    if (result.duplicates) notes.push(`${result.duplicates} already in your knowledge base`);
    if (result.unavailableDuplicates) notes.push(`${result.unavailableDuplicates} duplicate document(s) unavailable to mirror — server repair required`);
    if (result.pending) notes.push(`${result.pending} still processing (check icarus status/HIVEMIND later)`);
    if (result.failed) notes.push(`${result.failed} failed — see the errors printed above`);
    if (result.mirrored) notes.push(`${result.mirrored} segments mirrored into ${c.path(org)}'s local shard`);
    if (result.remoteSegments) notes.push(`${result.remoteSegments} new server segments`);
    if (result.purged) notes.push(`${result.purged} cloud document(s) deleted after mirroring — HIVEMIND used as extraction pipeline only`);
    if (result.skippedImages) notes.push(`${result.skippedImages} image(s) skipped — HIVEMIND doesn't create a fetchable document for images`);
    const outcome = ingestMode === 'evidence' ? `${result.chunks} local evidence segments` : `${result.live} memories, ${result.chunks} segments`;
    const action = result.unavailableDuplicates ? `HIVEMIND ingest incomplete: ${result.files} files checked` : result.duplicates === result.files ? `checked ${result.files} existing files` : `HIVEMIND ingested ${result.files} files`;
    console.log(`\n${ok(`${action} → ${outcome} (mode=${result.mode})`)}${notes.length ? c.dim(` — ${notes.join(', ')}`) : ''}`);
    return;
  }
  if (!embeddingsConfigured(cfg)) {
    console.log(c.dim('no embedding provider configured — ingesting lexical-only (BM25, no semantic recall).'));
    console.log(c.dim(`run ${c.command('icarus connect-embeddings')} to add one, then re-ingest for vector recall.\n`));
  }
  console.log(bullet(c.system(`ingesting into org "${c.path(org)}"`)));
  let tick = 0;
  const result = await ingestDir(dir, org, cfg, (n) => process.stdout.write(`\r  ${c.running(spinnerFrame(tick++))} ${c.running(String(n))} chunks`));
  console.log(`\n${ok(`ingested ${c.bold(result.chunks)} chunks from ${result.files} files into ${c.path(org)} (${result.live} live, mode=${result.mode})`)}`);
}

async function cmdHarness(flags) {
  const subcommand = flags._[0];
  if (subcommand !== 'init') throw new Error('usage: icarus harness init [--agent claude|codex|cursor|grok|all] [--repo <dir>]');
  const requested = flags.agent === 'all'
    ? ['claude', 'codex', 'cursor', 'grok']
    : (flags.agent ? flags.agent.split(',').map((agent) => agent.trim()).filter(Boolean) : []);
  const result = require('./harness.js').initHarness(flags.repo || process.cwd(), { agents: requested });
  if (result.created) {
    console.log(ok(`initialized ICARUS Harness (${result.manifest.repo_id})`));
    console.log(c.dim(`  tracked contract: .icarus/manifest.yaml  ·  runtime: .icarus/runtime/`));
    if (result.graph_migrated) console.log(c.dim('  copied existing .icarus-graph/graph.db into the runtime graph store (legacy graph retained)'));
  } else {
    console.log(ok(`ICARUS Harness already initialized (${result.manifest.repo_id})`));
  }
}

function cmdDoctor(flags) {
  const report = require('./harness.js').doctor(flags.repo || process.cwd());
  console.log(`\n${heading('ICARUS Harness doctor')}\n`);
  for (const check of report.checks) {
    const marker = check.status === 'pass' ? c.success('✓') : check.status === 'warn' ? c.command('!') : c.error('✗');
    console.log(`  ${marker} ${c.bold(check.id.padEnd(18))} ${check.detail}`);
  }
  if (!report.healthy) throw new Error(`harness doctor found ${report.issues.length} blocking issue(s)`);
}

// Task lifecycle is deliberately a presentation layer over the native Rust harness. Contracts
// are explicit files, never ad-hoc model output hidden in a command invocation.
function cmdTask(flags) {
  const [subcommand, taskId, target] = flags._;
  const repo = flags.repo || process.cwd();
  const harness = require('./harness.js');
  if (subcommand === 'start') {
    const objective = flags.objective || taskId;
    if (!objective || !flags.contract) throw new Error('usage: icarus task start --objective <text> --contract <contract.json> [--repo <dir>]');
    let contract;
    try { contract = JSON.parse(fs.readFileSync(flags.contract, 'utf8')); } catch (error) { throw new Error(`cannot read task contract ${flags.contract}: ${error.message}`); }
    const task = harness.startTask(repo, { objective, contract });
    console.log(ok(`started ${c.path(task.task_id)} · ${task.status} · contract v${task.contract_version}`));
    return;
  }
  if (!taskId) throw new Error('usage: icarus task <status|resume|transition|reconcile|authorize> <TASK-ID> [state] [--repo <dir>]');
  if (subcommand === 'status') {
    const task = harness.taskStatus(repo, taskId);
    console.log(`${c.bold(task.task_id)}  ${c.system(task.status)}  contract v${task.contract_version}`);
    console.log(c.dim(`  execution: ${task.execution_id}${task.previous_execution_id ? `  resumed from: ${task.previous_execution_id}` : ''}`));
    console.log(c.dim(`  objective: ${task.objective}`));
    return;
  }
  if (subcommand === 'resume') {
    const task = harness.resumeTask(repo, taskId);
    console.log(ok(`resumed ${c.path(task.task_id)} as ${task.execution_id} · ${task.status}`));
    return;
  }
  if (subcommand === 'transition') {
    if (!target) throw new Error('usage: icarus task transition <TASK-ID> <state> [--repo <dir>]');
    const task = harness.transitionTask(repo, taskId, target);
    console.log(ok(`${c.path(task.task_id)} → ${task.status}`));
    return;
  }
  if (subcommand === 'reconcile') {
    const result = harness.reconcileRun(repo, taskId);
    if (result.reconciled) console.log(ok(`${c.path(taskId)} reconciled ${result.changed_files.length} file(s) from the isolated worktree`));
    else console.log(c.dim(`${c.path(taskId)} has no isolated worktree delta to reconcile`));
    return;
  }
  if (subcommand === 'amend') {
    if (!flags.contract || !flags.reason) throw new Error('usage: icarus task amend <TASK-ID> --contract <contract.json> --reason <text> [--approval <id>] [--repo <dir>]');
    let contract;
    try { contract = JSON.parse(fs.readFileSync(flags.contract, 'utf8')); } catch (error) { throw new Error(`cannot read task contract ${flags.contract}: ${error.message}`); }
    const task = harness.amendTaskContract(repo, taskId, contract, flags.reason, flags.approval);
    console.log(ok(`${c.path(task.task_id)} contract amended to v${task.contract_version}`));
    return;
  }
  if (subcommand === 'checkpoint') {
    if (!flags.phase) throw new Error('usage: icarus task checkpoint <TASK-ID> --phase <name> [--input <json-file>] [--repo <dir>]');
    let input = {};
    if (flags.input) {
      try { input = JSON.parse(fs.readFileSync(flags.input, 'utf8')); } catch (error) { throw new Error(`cannot read checkpoint input ${flags.input}: ${error.message}`); }
    }
    const checkpoint = harness.checkpointTask(repo, taskId, flags.phase, input);
    console.log(ok(`checkpoint ${checkpoint.sequence} · ${checkpoint.phase} · ${checkpoint.git_sha || 'no git HEAD'}`));
    return;
  }
  if (subcommand === 'block') {
    if (!flags.reason) throw new Error('usage: icarus task block <TASK-ID> --reason <text> [--repo <dir>]');
    const task = harness.transitionTask(repo, taskId, 'blocked');
    harness.checkpointTask(repo, taskId, 'blocked', { open_risks: [flags.reason], next_valid_action: 'resolve blocking condition' });
    console.log(ok(`${c.path(task.task_id)} blocked with an attributable checkpoint`));
    return;
  }
  if (subcommand === 'authorize') {
    if (!flags.kind) throw new Error('usage: icarus task authorize <TASK-ID> --kind write --path <repo-relative-path> [--repo <dir>]');
    const decision = harness.authorizeAction(repo, taskId, { kind: flags.kind, path: flags.path });
    console.log(decision.allowed ? ok(`authorized — ${decision.reason}`) : err(`denied — ${decision.reason}`));
    if (!decision.allowed) process.exitCode = 3;
    return;
  }
  if (subcommand === 'verify') {
    const criterion = flags.criterion || target;
    if (!criterion) throw new Error('usage: icarus task verify <TASK-ID> --criterion <id> [--repo <dir>]');
    const receipt = harness.verifyTaskCriterion(repo, taskId, criterion);
    console.log(receipt.status === 'pass' ? ok(`${c.path(receipt.criterion_id)} passed`) : receipt.status === 'pending' ? c.command(`pending ${receipt.criterion_id}`) : err(`${c.path(receipt.criterion_id)} failed`));
    console.log(c.dim(`  receipt: ${receipt.output_path} · ${receipt.output_digest.slice(0, 12)}`));
    if (receipt.status === 'fail') process.exitCode = 3;
    return;
  }
  if (subcommand === 'attest') {
    if (!flags.criterion || !flags.approval || !flags.approver) throw new Error('usage: icarus task attest <TASK-ID> --criterion <id> --approval <id> --approver <name> [--expires-at <rfc3339>] [--repo <dir>]');
    const receipt = harness.attestTaskCriterion(repo, taskId, flags.criterion, flags.approval, flags.approver, flags['expires-at']);
    console.log(ok(`${c.path(taskId)} · ${receipt.criterion_id} attested`));
    return;
  }
  if (subcommand === 'seal') {
    const result = harness.sealTask(repo, taskId);
    if (!result.sealed) {
      console.log(err(`${c.path(taskId)} cannot seal`));
      for (const issue of [...result.unmet_criteria, ...result.issues]) console.log(c.dim(`  · ${issue}`));
      process.exitCode = 3;
      return;
    }
    console.log(ok(`${c.path(taskId)} sealed · ${result.final_receipt_path}`));
    return;
  }
  throw new Error('usage: icarus task <start|status|resume|transition|reconcile|amend|checkpoint|block|authorize|verify|seal>');
}

function cmdContext(flags) {
  const subcommand = flags._[0];
  if (subcommand !== 'build') throw new Error('usage: icarus context build --task <TASK-ID> [--budget <tokens>] [--since-checkpoint <n>] [--format json|markdown] [--repo <dir>]');
  if (!flags.task) throw new Error('context build requires --task <TASK-ID>');
  const budget = Number(flags.budget || 12_000);
  if (!Number.isInteger(budget) || budget <= 0) throw new Error('--budget must be a positive integer');
  const checkpoint = flags['since-checkpoint'] == null ? undefined : Number(flags['since-checkpoint']);
  if (checkpoint != null && (!Number.isInteger(checkpoint) || checkpoint <= 0)) throw new Error('--since-checkpoint must be a positive checkpoint sequence');
  const result = require('./harness.js').buildContext(flags.repo || process.cwd(), flags.task, budget, checkpoint);
  if (flags.format && !['json', 'markdown'].includes(flags.format)) throw new Error('--format must be json or markdown');
  if (flags.format === 'json') console.log(JSON.stringify(result.pack, null, 2));
  else console.log(result.markdown);
}

function commandOnPath(command) {
  const locator = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [command] : ['-v', command];
  return spawnSync(locator, args, { stdio: 'ignore', shell: process.platform !== 'win32' }).status === 0;
}

// The launcher does not configure, proxy, or pay for a model. It prepares a Rust-governed
// workspace, then starts the user's already-installed coding CLI in that directory.
function cmdRun(flags) {
  const taskId = flags.task || flags._[0];
  const agent = flags.agent;
  if (!taskId || !agent) throw new Error('usage: icarus run --task <TASK-ID> --agent <claude|codex|cursor|grok> [--workspace isolated|current] [--acknowledge-dirty-current] [--dry-run] [--repo <dir>]');
  const commands = { claude: 'claude', codex: 'codex', cursor: 'cursor', grok: 'grok' };
  const command = commands[agent];
  if (!command) throw new Error(`unsupported agent adapter \`${agent}\``);
  if (!commandOnPath(command)) throw new Error(`${agent} adapter is not available on PATH (${command})`);
  const harness = require('./harness.js');
  const userArgs = flags.agentArgs || [];
  harness.validateAgentArguments(agent, userArgs);
  const repo = flags.repo || process.cwd();
  const preparation = harness.prepareRun(
    repo, taskId, agent, flags.workspace || 'isolated', !!flags['acknowledge-dirty-current'],
  );
  const label = preparation.compatibility_mode
    ? 'compatibility mode: isolated workspace and lifecycle records are active; hard interception is not yet proven'
    : 'certified managed mode: enforcement contract passed';
  console.log(ok(`prepared ${c.path(preparation.task_id)} in ${c.path(preparation.workspace_path)}`));
  console.log(c.dim(`  ${agent} · ${label}`));
  console.log(c.dim(`  launch context: ${preparation.context_pack_path}`));
  console.log(c.dim(`  task ${preparation.task_id} remains the governing contract; refresh via icarus_context_get after material changes.`));
  if (flags['dry-run']) return;
  const task = harness.transitionTask(repo, taskId, 'executing');
  const result = spawnSync(command, [...(preparation.launch_arguments || []), ...userArgs], { cwd: preparation.workspace_path, stdio: 'inherit' });
  if (result.error) throw new Error(`failed to launch ${agent}: ${result.error.message}`);
  if (result.status === 0) {
    try {
      const reconciliation = harness.reconcileRun(repo, task.task_id);
      if (reconciliation.reconciled) console.log(ok(`reconciled ${reconciliation.changed_files.length} contract-scoped file(s) from the isolated worktree.`));
    } catch (error) {
      harness.transitionTask(repo, task.task_id, 'blocked');
      console.log(err(`${c.path(task.task_id)} blocked: isolated worktree was not reconciled safely — ${error.message}`));
      process.exitCode = 3;
      return;
    }
    harness.transitionTask(repo, task.task_id, 'verifying');
    console.log(ok(`${c.path(task.task_id)} → verifying; run icarus task verify before sealing.`));
  } else {
    harness.transitionTask(flags.repo || process.cwd(), task.task_id, 'blocked');
    console.log(err(`${c.path(task.task_id)} blocked after ${agent} exited ${result.status ?? 'by signal'}`));
    process.exitCode = result.status || 1;
  }
}

function cmdHarnessSkill(flags) {
  const [subcommand, skillId] = flags._;
  const repo = flags.repo || process.cwd();
  const harness = require('./harness.js');
  if (subcommand === 'propose') {
    if (!flags.file) throw new Error('usage: icarus harness-skill propose --file <skill.json> [--repo <dir>]');
    const skill = JSON.parse(fs.readFileSync(flags.file, 'utf8'));
    console.log(ok(`proposed harness skill ${harness.proposeSkill(repo, skill).id}`));
    return;
  }
  if (subcommand === 'promote') {
    if (!skillId) throw new Error('usage: icarus harness-skill promote <skill-id> [--approval <id>] [--repo <dir>]');
    console.log(ok(`activated harness skill ${harness.promoteSkill(repo, skillId, flags.approval).id}`));
    return;
  }
  if (subcommand === 'retire') {
    if (!skillId || !flags.reason) throw new Error('usage: icarus harness-skill retire <skill-id> --reason <reason> --approval <id> [--repo <dir>]');
    console.log(ok(`retired harness skill ${harness.retireSkill(repo, skillId, flags.reason, flags.approval).id}`));
    return;
  }
  throw new Error('usage: icarus harness-skill <propose|promote|retire>');
}

// Recall is LOCAL-ONLY, always — never routes to HIVEMIND's shared /api/recall regardless of
// connection state. Real reason, not a style choice: an actual test session against a real
// HIVEMIND org saw completely unrelated OTHER users'/orgs' private content come back for this
// org's own queries — a live cross-tenant leak on the server's shared recall index, not a
// hypothetical. The local .amr shard is the only surface that can't leak another tenant's data
// by construction. HIVEMIND is still used for ingest/save PROCESSING and as free embed+rerank
// helper services (see recallQuery()'s own use of them) — just never as the actual search index.
async function cmdRecall(flags, cfg) {
  const q = flags._[0];
  const org = flags.org || 'default';
  const k = Number(flags.k || 5);
  const usePq = flags.pq !== undefined;
  if (!q) throw new Error('usage: icarus recall "<query>" --org <name> [--k 5] [--pq]');
  const hits = await recallQuery(q, org, cfg, k, usePq);
  const modeLabel = usePq ? c.dim(' (PQ/ADC recall)')
    : hits[0]?.rerankFailed ? c.command(` (rerank failed — showing raw RRF scores, not calibrated: ${hits[0].rerankError})`)
    : hits[0]?.mode === 'hybrid-reranked' ? c.dim(' (parallel hybrid, reranked — bge-reranker-v2-m3)')
    : hits[0]?.mode === 'lexical' ? c.dim(' (lexical/BM25 — no embedding provider configured)')
    : hits[0]?.mode === 'hybrid' ? c.dim(' (parallel hybrid: dense + lexical, RRF-merged — too few candidates to rerank)')
    : '';
  console.log(`\n${heading(`top ${hits.length}`)} for "${c.fg(q)}"${modeLabel}:\n`);
  hits.forEach((h, i) => {
    const txt = h.text.replace(/\s+/g, ' ').slice(0, 160);
    console.log(`  ${c.dim(String(i + 1).padStart(2))} ${c.assistant(glyphs.promptArrow)} ${c.model(`[${h.score.toFixed(4)}]`)} ${txt}`);
  });
}

// /save — real, deliberate memory creation (full embedding + smart-router when HIVEMIND-routed;
// real local embedding otherwise), NOT evidence-only. Recallable via /recall alongside anything
// /ingest already stored — see hivemindSaveMemory()/saveLocalMemory()'s own doc comments.
//
// Real gap caught testing this before shipping: /recall is LOCAL ONLY (this session's own fix
// for the cross-tenant leak), so a cloud-only save via hivemindSaveMemory() was completely
// unrecallable — `icarus save "..."` then `icarus recall` on the exact same text returned ZERO
// hits. The HIVEMIND-routed branch now ALSO writes the same text into the local shard
// (saveLocalMemory — cheap, no extra network round-trip since the text is already in hand,
// unlike ingest's document mirror which has to fetch server-extracted segments back).
async function cmdSave(flags, cfg) {
  const text = flags._.join(' ');
  const org = flags.org || 'default';
  if (!text.trim()) throw new Error('usage: icarus save "<text>" --org <name> [--cloud]');
  // LOCAL ONLY BY DEFAULT — real user directive: icarus's own calls must never create a
  // permanent memory in HIVEMIND's cloud box on their own. --cloud opts back in explicitly when
  // a real, permanent, smart-routed HIVEMIND memory is actually wanted (still mirrored locally
  // too, same as before, so /recall keeps working either way).
  const saved = await saveIntelligentMemory(text, org, cfg, { cloud: !!flags.cloud });
  if (saved.mode === 'structured') {
    console.log(ok(`saved with save_memory schema (id ${c.path(saved.id)}) in ${c.path(org)} — ${saved.draft.entities.length} entities, ${saved.draft.tags.length} tags${saved.edge ? `, ${saved.edge.type} relationship` : ''}${saved.remote ? ', cloud canonical save' : ''}.`));
    return;
  }
  console.log(ok(`saved as a local memory in ${c.path(org)}'s shard${embeddingsConfigured(cfg) ? '' : c.dim(' (lexical-only — no LLM metadata available)')}.`));
}

function cmdStatus(_flags, cfg) {
  const s = statusReport(cfg);
  console.log(`${heading('icarus')} ${c.dim(`v${ICARUS_VERSION}`)}  data: ${c.path(s.dataRoot)}  dim: ${s.dim}`);
  console.log(rule());
  console.log(`${c.dim(glyphs.accentBar)} HIVEMIND   ${s.hivemindConnected ? c.success('connected') : c.dim('not connected')}`);
  console.log(`${c.dim(glyphs.accentBar)} Signing    ${signingEnabled(cfg) ? c.success('ML-DSA-65 (FIPS 204), on') : c.dim('disabled')}`);
  console.log(`${c.dim(glyphs.accentBar)} Audit      ${c.success('SLH-DSA-SHA2-128s (FIPS 205), on')} ${c.dim('— icarus audit checkpoint/verify')}`);
  if (!s.shards.length) return console.log(c.dim(`\nno shards yet — run: ${c.command('icarus ingest <dir> --org <name>')}`));
  console.log(`\n${c.system(glyphs.diamond)} ${heading('shards')}`);
  for (const sh of s.shards) {
    console.log(`  ${c.dim(glyphs.accentBar)} ${c.path(sh.org.padEnd(24))} ${c.dim((sh.bytesOnDisk / 1e6).toFixed(2) + ' MB on disk')}`);
  }
}

async function cmdUpdate(_flags, _cfg) {
  console.log(c.dim(`  checking latest version (current: v${ICARUS_VERSION})...`));
  const { current, latest, upToDate } = await checkForUpdate();
  if (upToDate === null) {
    // Network hiccup or GitHub API rate-limit -- try the update anyway rather than block on a
    // check that couldn't complete; performSelfUpdate's own sanity-check (run the download once
    // before committing) is the real safety net, not this version comparison.
    console.log(c.dim('  couldn\'t check the latest version — trying the update anyway.'));
  } else if (upToDate) {
    return console.log(ok(`already up to date (${current}).`));
  } else {
    console.log(c.system(`  updating ${c.dim(current)} → ${c.bold(latest)}...`));
  }
  console.log(bullet(c.system('downloading and verifying the new binary...')));
  const bytes = await performSelfUpdate();
  console.log(ok(`updated to ${c.bold(latest || 'the latest release')} (${(bytes / 1e6).toFixed(1)} MB). Run ${c.command('icarus status')} to confirm.`));
}

function cmdCompact(flags, cfg) {
  const org = flags.org || 'default';
  const store = getMnemeStore().open(cfg.dataRoot, org, cfg.dim);
  const reclaimed = store.compact();
  console.log(ok(`compacted ${c.path(org)}: reclaimed ${c.bold((reclaimed / 1e3).toFixed(1))} KB`));
}

// PQ (Product Quantization) is a real alternative to HNSW, not a universal upgrade — see
// trainPq()'s doc comment in amr-store.mjs for the measured tradeoff (fast build always, fast
// QUERY only at small/medium shard sizes). This command is what makes it reachable without
// writing code — before this, train_pq/recall_pq only existed in the Rust crate.
function cmdTrainPq(flags, cfg) {
  const org = flags.org || 'default';
  const seed = Number(flags.seed || 42);
  // PQ trains a codebook on the shard's raw vectors — in lexical-only mode those are zero
  // placeholders (no embedding provider to produce real ones), so training now would silently
  // produce a degenerate, meaningless codebook rather than erroring. Refuse loudly instead.
  if (!embeddingsConfigured(cfg)) {
    throw new Error('train-pq needs real vectors — no embedding provider configured. Run `icarus connect-embeddings` first, then re-ingest and train.');
  }
  const store = getMnemeStore().open(cfg.dataRoot, org, cfg.dim);
  const live = store.liveCount();
  if (!live) throw new Error(`org "${org}" has no memories yet — nothing to train on`);
  console.log(bullet(c.system(`training PQ codebook for "${c.path(org)}" ${c.dim(`(${live} live vectors, seed=${seed})`)}...`)));
  const t0 = Date.now();
  store.trainPq(seed);
  console.log(ok(`trained in ${c.bold(((Date.now() - t0) / 1000).toFixed(1) + 's')} — try: ${c.command(`icarus recall "..." --org ${org} --pq`)}`));
}

// Two real, separate bugs were caught building this:
//   1. A fresh readline.Interface PER question loses whatever was buffered past the first
//      question when the interface is closed and reopened on the same non-tty pipe.
//   2. Fixed to one shared interface, multi-question flows STILL silently dropped answers 2+ on
//      piped (non-tty) input: Node's readline.Interface on a non-tty stream processes buffered
//      lines eagerly in the background — `rl.question()` only attaches a ONE-TIME listener for
//      the very next 'line' event, so if a later question is asked after any event-loop tick
//      (even just an `await`), lines already fired-and-discarded before that listener existed
//      are gone. No error, no hang past the first question — just missing input. Reproduced in
//      a 3-line isolated repro before trusting this diagnosis.
// Fix: a real interactive TTY paces itself, so classic sequential question() is fine there.
// Piped/non-interactive input is read up front, split into lines, and each ask() call just
// pops the next one — no readline race possible because there's no readline involved.
function makePrompter() {
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));
    ask.close = () => rl.close();
    return ask;
  }
  let buffered = null;
  let idx = 0;
  const readAll = () => {
    try { buffered = fs.readFileSync(0, 'utf8').split('\n'); } catch (_) { buffered = []; }
  };
  const ask = async (q) => {
    if (buffered === null) readAll();
    process.stdout.write(q);
    const line = idx < buffered.length ? buffered[idx++] : '';
    process.stdout.write(line + '\n');
    return line.trim();
  };
  ask.close = () => {};
  return ask;
}

// DEFAULT_HIVEMIND_AUTH_URL/DEFAULT_HIVEMIND_API_URL are defined ONCE in cli-lib.js (imported
// above) and reused here and by tui.js's /connect — see cli-lib.js's own comment on them for the
// full "two different services" story (a real duplication bug was caught by the publish scanner
// flagging a second hardcoded copy in tui.js; fixed by centralizing instead of allowlisting both).

async function cmdConnect(flags, cfg, sharedAsk) {
  const authUrl = process.env.HIVEMIND_URL || cfg.hivemind?.url || DEFAULT_HIVEMIND_AUTH_URL;
  const restUrl = flags['api-url'] || process.env.HIVEMIND_API_URL || cfg.hivemind?.apiUrl || DEFAULT_HIVEMIND_API_URL;
  // --token makes this fully non-interactive — install.sh's guided section uses this instead of
  // spawning a second interactive read inside a curl|bash pipeline's child process. A real bug
  // was caught running the actual `curl | bash` install: a long-lived Node process doing several
  // sequential /dev/tty reads (icarus setup's own wizard, invoked as install.sh's child) died
  // silently after its first question — most likely a controlling-terminal/process-group issue
  // specific to being spawned from within a shell pipeline (`curl url | bash`), not reproducible
  // in a plain interactive shell. install.sh now does ALL prompting itself (the single-read `read
  // ... < /dev/tty` pattern already proven reliable), then calls each icarus subcommand with the
  // answer already in hand via flags — never handing tty control to a child process for more than
  // one read at a time.
  if (flags.token !== undefined) {
    if (!flags.token) return console.log(c.dim('  skipped.'));
    cfg.hivemind = { connected: true, url: authUrl, token: flags.token, apiUrl: restUrl, connectedAt: new Date().toISOString() };
    saveCfg(cfg);
    console.log(`  ${ok('HIVEMIND connected.')} Token stored in ${c.path(CFG_PATH)}`);
    return;
  }
  console.log(`\n${heading('Connect ICARUS ↔ HIVEMIND')}`);
  // Real browser-login handshake (GET /auth/cli/start — see attemptHivemindOAuth's own doc
  // comment) tried FIRST against the default/configured server, no prompt needed for the common
  // case. Only if that fails (unreachable server, timed out, or user closes the tab) does this
  // fall to asking for a URL + a manually pasted token.
  console.log(c.dim(`  Signing in via ${c.path(authUrl)} ${authUrl === DEFAULT_HIVEMIND_AUTH_URL ? '(default — override with HIVEMIND_URL)' : ''}`));
  console.log(c.running('  Opening your browser...'));
  const oauth = await attemptHivemindOAuth(authUrl);
  if (oauth) {
    cfg.hivemind = { connected: true, url: authUrl, token: oauth.token, userEmail: oauth.userEmail, apiUrl: restUrl, connectedAt: new Date().toISOString() };
    saveCfg(cfg);
    return console.log(`  ${ok(`HIVEMIND connected${oauth.userEmail ? ` as ${c.path(oauth.userEmail)}` : ''}.`)} Token stored in ${c.path(CFG_PATH)} (API base: ${c.path(restUrl)})`);
  }
  // --oauth-only: browser-flow-or-fail, no interactive fallback — this is what install.sh's
  // guided_setup calls, so it (not this Node process) owns every /dev/tty read. A real bug this
  // session: a Node child doing SEQUENTIAL /dev/tty reads died silently when spawned from inside
  // a `curl | bash` pipe — the browser-flow-only path here does zero tty reads (its callback
  // server is a plain loopback HTTP listener, not stdin), so it's safe to call directly; install.sh
  // does its own single-read fallback if this returns nonzero.
  if (flags['oauth-only']) {
    console.log(c.dim('  Browser sign-in didn\'t complete.'));
    process.exitCode = 1;
    return;
  }
  console.log(c.dim('  Browser sign-in didn\'t complete — falling back to a manual URL + token.'));
  // A caller (icarus setup) that's already mid-wizard passes its own prompter through, so this
  // never touches stdin itself — a SECOND fs.readFileSync(0) on piped input reads nothing, since
  // the first prompter already drained the pipe (a real bug, caught running the actual wizard).
  const ask = sharedAsk || makePrompter();
  const manualUrl = (await ask(`  Memory server REST API base URL [${restUrl}]: `)) || restUrl;
  console.log(`  1. Open: ${c.path(`${authUrl}/settings/connections`)} (authorize "icarus local")`);
  console.log(`  2. Copy the access token shown after authorizing.\n`);
  const token = await ask('  Paste HIVEMIND token (or blank to skip): ');
  if (!sharedAsk) ask.close();
  if (!token) return console.log(c.dim('  skipped.'));
  cfg.hivemind = { connected: true, url: authUrl, token, apiUrl: manualUrl, connectedAt: new Date().toISOString() };
  saveCfg(cfg);
  console.log(`  ${ok('HIVEMIND connected.')} Token stored in ${c.path(CFG_PATH)}`);
}

// Embeddings are OPT-IN, not required — ingest/recall work lexical-only (BM25) with zero
// embedding provider configured. `export OPENROUTER_API_KEY=...` alone is enough (.env-style,
// no interactive step needed — the same pattern TencentDB Agent Memory's own setup uses); this
// command is for when you'd rather be prompted, or want the key saved to config instead of
// exported every session, or want to force lexical-only even with an env var present. Default
// provider is OpenRouter's real baai/bge-m3 (openrouter.ai/baai/bge-m3, verified live: native
// 1024-dim output, matches the shard's fixed dim exactly). LITELLM_API_KEY/LITELLM_BASE_URL
// still work as an override for anyone pointing at their own LiteLLM/blaiq gateway instead.
async function cmdConnectEmbeddings(flags, cfg, sharedAsk) {
  if (flags.disable) {
    cfg.embeddings = { ...cfg.embeddings, disabled: true, apiKey: null };
    saveCfg(cfg);
    return console.log(ok('embeddings disabled — ingest/recall will use lexical-only (BM25) search, even with OPENROUTER_API_KEY set.'));
  }
  // --key (even '' to mean "use env var / skip") makes this fully non-interactive — see
  // cmdConnect's comment for why install.sh's guided section needs this shape.
  if (flags.key !== undefined) {
    const endpoint = flags.endpoint || cfg.embeddings?.endpoint || 'https://openrouter.ai/api/v1';
    const model = flags.model || cfg.embeddings?.model || 'baai/bge-m3';
    if (!flags.key && !process.env.OPENROUTER_API_KEY && !process.env.LITELLM_API_KEY) {
      return console.log(c.dim('  no key given and OPENROUTER_API_KEY not set — skipped. Staying lexical-only.'));
    }
    cfg.embeddings = { disabled: false, endpoint, model, apiKey: flags.key || null };
    saveCfg(cfg);
    console.log(`  ${ok(`embedding provider configured (${c.model(model)} @ ${c.path(endpoint)})`)}. Config → ${c.path(CFG_PATH)}`);
    return;
  }
  console.log(`\n${heading('Connect an embedding provider')} ${c.dim('(OpenAI-compatible /embeddings endpoint)')}`);
  console.log(c.dim('Skip this entirely and ICARUS still works — BM25 lexical search needs no vector.'));
  console.log(c.dim('(Already have OPENROUTER_API_KEY exported? You don\'t need this command at all — it just works.)\n'));
  const ask = sharedAsk || makePrompter();
  const endpoint = await ask(`  Endpoint [${cfg.embeddings?.endpoint || 'https://openrouter.ai/api/v1'}]: `)
    || cfg.embeddings?.endpoint || 'https://openrouter.ai/api/v1';
  const model = await ask(`  Model [${cfg.embeddings?.model || 'baai/bge-m3'}]: `) || cfg.embeddings?.model || 'baai/bge-m3';
  const apiKey = await ask('  API key (or blank to use OPENROUTER_API_KEY env var instead): ');
  if (!sharedAsk) ask.close();
  if (!apiKey && !process.env.OPENROUTER_API_KEY && !process.env.LITELLM_API_KEY) {
    return console.log(c.dim('  no key given and OPENROUTER_API_KEY not set — skipped. Staying lexical-only.'));
  }
  cfg.embeddings = { disabled: false, endpoint, model, apiKey: apiKey || null };
  saveCfg(cfg);
  console.log(`  ${ok(`embedding provider configured (${c.model(model)} @ ${c.path(endpoint)})`)}. Config → ${c.path(CFG_PATH)}`);
  console.log(c.dim(`  Re-run ${c.command('icarus ingest')} for existing orgs to get vector recall on their content.`));
}

// Memory generation (distillation, TencentDB Agent Memory's own L0->L1 term) is OPT-IN, same
// shape as connect-embeddings — but a SEPARATE knob: this is a chat-completion call, not an
// embeddings one, and neither Claude's native API nor OpenRouter offer embeddings at all. Two
// real providers, not a fake "connect your Claude subscription": Anthropic prohibits third-party
// products from routing calls through a user's Claude.ai Free/Pro/Max login — the only supported
// path is a standalone Anthropic API key from console.anthropic.com, or OpenRouter (which can
// also reach Claude models, by model name, through its own separate key). ICARUS never asks for
// or stores a Claude.ai/Codex login session.
async function cmdConnectLlm(flags, cfg, sharedAsk) {
  if (flags.disable) {
    cfg.llm = { ...cfg.llm, disabled: true, apiKey: null };
    saveCfg(cfg);
    return console.log(ok('memory generation disabled — ingest will store raw text, even with an API key env var set.'));
  }
  // --provider (openrouter|anthropic|skip) + --key make this fully non-interactive — see
  // cmdConnect's comment for why install.sh's guided section needs this shape.
  if (flags.provider !== undefined) {
    if (flags.provider === 'skip') return console.log(c.dim('  skipped. Staying raw-text mode.'));
    const provider = flags.provider === 'anthropic' ? 'anthropic' : 'openrouter';
    const defaults = provider === 'anthropic'
      ? { endpoint: 'https://api.anthropic.com', model: 'claude-3-5-haiku-20241022' }
      : { endpoint: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-3.5-haiku' };
    const endpoint = flags.endpoint || cfg.llm?.endpoint || defaults.endpoint;
    const model = flags.model || cfg.llm?.model || defaults.model;
    const envVar = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENROUTER_API_KEY';
    if (!flags.key && !process.env[envVar]) {
      return console.log(c.dim(`  no key given and ${envVar} not set — skipped. Staying raw-text mode.`));
    }
    cfg.llm = { disabled: false, provider, endpoint, model, apiKey: flags.key || null };
    saveCfg(cfg);
    console.log(`  ${ok(`memory generation configured (${c.model(provider)}: ${model} @ ${c.path(endpoint)})`)}. Config → ${c.path(CFG_PATH)}`);
    return;
  }
  console.log(`\n${heading('Connect a memory-generation provider')} ${c.dim('(distills raw text into key facts before storing)')}`);
  console.log(c.dim('Skip this entirely and ICARUS still works — raw text is stored and searchable as-is.\n'));
  console.log(`  ${c.command('1)')} OpenRouter   — one key, routes to Claude/GPT/etc by model name`);
  console.log(`  ${c.command('2)')} Anthropic API key — console.anthropic.com (NOT your Claude.ai subscription login)`);
  console.log(`  ${c.command('3)')} Skip\n`);
  const ask = sharedAsk || makePrompter();
  const choice = (await ask('  Choice [1/2/3]: ')).trim() || '3';
  if (choice === '3') { if (!sharedAsk) ask.close(); return console.log(c.dim('  skipped. Staying raw-text mode.')); }
  const provider = choice === '2' ? 'anthropic' : 'openrouter';
  const defaults = provider === 'anthropic'
    ? { endpoint: 'https://api.anthropic.com', model: 'claude-3-5-haiku-20241022' }
    : { endpoint: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-3.5-haiku' };
  const endpoint = await ask(`  Endpoint [${cfg.llm?.endpoint || defaults.endpoint}]: `) || cfg.llm?.endpoint || defaults.endpoint;
  const model = await ask(`  Model [${cfg.llm?.model || defaults.model}]: `) || cfg.llm?.model || defaults.model;
  const envVar = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENROUTER_API_KEY';
  const apiKey = await ask(`  API key (or blank to use ${envVar} env var instead): `);
  if (!sharedAsk) ask.close();
  if (!apiKey && !process.env[envVar]) {
    return console.log(c.dim(`  no key given and ${envVar} not set — skipped. Staying raw-text mode.`));
  }
  cfg.llm = { disabled: false, provider, endpoint, model, apiKey: apiKey || null };
  saveCfg(cfg);
  console.log(`  ${ok(`memory generation configured (${c.model(provider)}: ${model} @ ${c.path(endpoint)})`)}. Config → ${c.path(CFG_PATH)}`);
  console.log(c.dim(`  Re-run ${c.command('icarus ingest')} for existing orgs to distill their content going forward.`));
}

// The guided, one-by-one flow: detect agents, ask per agent, then walk through memory-generation
// / embeddings / HIVEMIND as sequential explained steps — never a silent "run these 3 commands
// later" wall. Piped/non-interactive input works identically (makePrompter's non-TTY branch),
// just answered from stdin/env instead of a live terminal.
async function cmdSetup(_flags, cfg) {
  const { detectAgents, installClaudeCode, installCodex, installCursor, resolveIcarusCommand } = require('./mcp-install.js');
  console.log(`\n${heading('icarus setup')} ${c.dim('— guided, step by step. Answer or press enter to skip any step.')}\n`);
  // ONE prompter for the whole wizard: on piped/non-TTY input, makePrompter() does a single
  // fs.readFileSync(0) — a second instance mid-wizard would find the pipe already drained and
  // silently read nothing for every remaining question (a real bug, caught running this live).
  const ask = makePrompter();
  console.log(`${c.system(glyphs.diamond)} ${c.bold('Step 1/4')} ${c.dim('— coding agents on this machine')}\n`);
  const found = detectAgents().filter((a) => a.found);
  if (!found.length) {
    console.log(c.dim('  none detected (no ~/.claude.json, ~/.codex, or ~/.cursor found). Skipping.\n'));
  } else {
    const command = resolveIcarusCommand();
    const installers = { 'claude-code': installClaudeCode, codex: installCodex, cursor: installCursor };
    for (const { agent } of found) {
      const yn = (await ask(`  Register ICARUS as an MCP server for ${agent}? [Y/n]: `)).trim().toLowerCase();
      if (yn === 'n' || yn === 'no') { console.log(c.dim(`  · ${agent}: skipped`)); continue; }
      const r = installers[agent](command);
      console.log(r.installed ? `  ${ok(`${agent}: registered in ${c.path(r.path)}`)}` : c.dim(`  · ${agent}: ${r.reason}`));
    }
    if (found.some((a) => a.agent === 'codex')) {
      console.log(c.dim('  (Codex ChatGPT-subscription login via its app-server is a separate, not-yet-built'));
      console.log(c.dim('   integration — this only registered icarus as a plain MCP tool for it.)'));
    }
    console.log('');
  }

  console.log(`${c.system(glyphs.diamond)} ${c.bold('Step 2/4')} ${c.dim('— memory generation (distill ingested text into key facts)')}\n`);
  if (llmConfigured(cfg)) {
    console.log(c.dim(`  already configured (${cfg.llm.provider} @ ${cfg.llm.endpoint}) — skipping.\n`));
  } else {
    await cmdConnectLlm({ _: [] }, cfg, ask);
    console.log('');
  }

  console.log(`${c.system(glyphs.diamond)} ${c.bold('Step 3/4')} ${c.dim('— vector recall (semantic search on top of lexical/BM25)')}\n`);
  if (embeddingsConfigured(cfg)) {
    console.log(c.dim(`  already configured (${cfg.embeddings.model} @ ${cfg.embeddings.endpoint}) — skipping.\n`));
  } else {
    await cmdConnectEmbeddings({ _: [] }, cfg, ask);
    console.log('');
  }

  console.log(`${c.system(glyphs.diamond)} ${c.bold('Step 4/4')} ${c.dim('— HIVEMIND account (optional)')}\n`);
  if (cfg.hivemind && cfg.hivemind.connected) {
    console.log(c.dim('  already connected — skipping.\n'));
  } else {
    await cmdConnect({ _: [] }, cfg, ask);
    console.log('');
  }
  ask.close();

  const fresh = loadCfg();
  console.log(rule());
  console.log(heading('Setup summary'));
  console.log(`  ${c.dim('agents registered :')} ${found.filter((a) => a.found).length ? c.success('see above') : c.dim('none found')}`);
  console.log(`  ${c.dim('memory generation :')} ${llmConfigured(fresh) ? c.success(`on (${fresh.llm.provider})`) : c.dim('off (raw text)')}`);
  console.log(`  ${c.dim('vector recall     :')} ${embeddingsConfigured(fresh) ? c.success(`on (${fresh.embeddings.model})`) : c.dim('off (lexical/BM25)')}`);
  console.log(`  ${c.dim('HIVEMIND          :')} ${fresh.hivemind?.connected ? c.success('connected') : c.dim('not connected')}`);
  console.log(`\n${ok('All set.')} Try: ${c.command('icarus ingest <dir> --org <name>')}`);
}

// "Automatically enables skill generation" (as requested) has a real limit: ICARUS has no
// visibility into a coding-agent session on its own — no agent broadcasts its transcript to
// arbitrary local tools. What's actually automatable is the LAST step: given a transcript
// (stdin, a file, or a piped `--session-end` hook payload), distill it into a skill with zero
// interactive prompts. The "automatic" part is wiring THIS into an agent's own hook (e.g.
// Claude Code's SessionEnd hook piping its transcript here) — that's a one-line hook config on
// the agent's side, not something ICARUS can install into another tool's session lifecycle
// itself (same reasoning as never touching a Claude Code/Codex login session).
async function cmdSkill(flags, cfg) {
  const sub = flags._[0];
  const org = flags.org || 'default';
  if (sub === 'list') {
    const skills = skillList(org);
    if (!skills.length) return console.log(`no skills saved yet for org "${org}". Run: icarus skill save <file> --org ${org}`);
    console.log(`skills for "${org}":\n`);
    for (const s of skills) console.log(`  ${s.slug.padEnd(28)} ${s.description}`);
    return;
  }
  if (sub === 'save') {
    if (!llmConfigured(cfg)) {
      throw new Error('skill extraction needs a memory-generation provider — run `icarus connect-llm` first');
    }
    const file = flags._[1];
    const transcript = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
    console.log('extracting skill...');
    const saved = await skillSave(transcript, org, cfg);
    if (!saved) throw new Error('extraction failed (bad key, provider error, or empty transcript) — no skill written');
    return console.log(`✓ skill saved: ${saved}`);
  }
  throw new Error('usage: icarus skill <save [file] --org <name> | list --org <name>>');
}

// `icarus verify` — independent proof that a memory hasn't been tampered with since it was
// written: re-derives the same canonical payload (slot id + current stored text) and checks it
// against the recorded ML-DSA-65 signature. Reports one of three real states, not just a
// boolean: no signature ever recorded (written before signing was enabled, or signing was off),
// signature present and valid, or signature present but the content no longer matches it — the
// last case is the one that actually matters (real tamper detection, verified in this session
// by rewriting a slot's stored text directly and confirming this goes invalid).
function cmdVerify(flags, cfg) {
  const org = flags.org || 'default';
  const slotId = Number(flags._[0]);
  if (!Number.isInteger(slotId) || slotId < 0) throw new Error('usage: icarus verify <slot_id> --org <name>');
  const r = verifySlot(slotId, cfg, org);
  if (!r.signed) return console.log(c.dim(`slot ${slotId} in "${org}": no signature recorded (written before signing was enabled, or signing was off).`));
  if (r.valid) return console.log(ok(`slot ${c.path(slotId)} in "${c.path(org)}": signature valid (signed ${r.signedAt}).`));
  console.log(err(`slot ${c.path(slotId)} in "${c.path(org)}": signature ${c.bold('INVALID')} — content does not match what was signed at ${r.signedAt}.`));
  process.exitCode = 1;
}

// `icarus audit checkpoint|verify` — the hash-chain audit trail (SLH-DSA-SHA2-128s, FIPS 205),
// a DIFFERENT property from `icarus verify` above: that checks one memory's content against its
// own signature; this checks that the SEQUENCE of write events hasn't been edited, reordered, or
// had entries spliced out — real tamper detection verified this session by deleting an audit
// entry directly and confirming the chain correctly reports broken, at the right position.
function cmdAudit(flags, cfg) {
  const sub = flags._[0];
  const org = flags.org || 'default';
  if (sub === 'checkpoint') {
    const cp = checkpointAudit(cfg, org);
    return console.log(ok(`checkpoint signed for "${c.path(org)}" at seq ${c.bold(cp.seq)} (${cp.signed_at}).`));
  }
  if (sub === 'verify') {
    const r = verifyAuditChain(cfg, org);
    if (!r.entries) return console.log(c.dim(`org "${org}": no audit entries yet.`));
    console.log(`${c.bold(r.entries)} audit entries for "${c.path(org)}".`);
    if (!r.chainValid) {
      console.log(err(`${c.bold('CHAIN BROKEN')} at seq ${r.brokenAt} — an entry was edited, reordered, or deleted.`));
      process.exitCode = 1;
      return;
    }
    console.log(ok('hash chain intact (genesis → tip, no gaps).'));
    if (!r.checkpoint) {
      console.log(c.dim(`  no checkpoint signed yet — run: ${c.command(`icarus audit checkpoint --org ${org}`)}`));
      return;
    }
    console.log(`  ${c.dim('latest checkpoint:')} seq ${r.checkpoint.seq}, signature ${r.checkpoint.valid ? c.success('valid') : c.error('INVALID')} (${r.checkpoint.signedAt})`);
    if (r.checkpoint.entriesSinceCheckpoint > 0) {
      console.log(c.dim(`  ${r.checkpoint.entriesSinceCheckpoint} entries since the last checkpoint are hash-chained but not yet signed — run: ${c.command(`icarus audit checkpoint --org ${org}`)}`));
    }
    if (!r.checkpoint.valid) process.exitCode = 1;
    return;
  }
  throw new Error('usage: icarus audit <checkpoint|verify> --org <name>');
}

// `icarus hook session-end` — the automatic-skill-generation counterpart to `icarus skill save`,
// wired as a real Claude Code SessionEnd hook (verified against actual Claude Code hook docs,
// not guessed): Claude Code writes {session_id, transcript_path, cwd, hook_event_name} as JSON on
// stdin when a session ends. transcript_path is Claude Code's own real transcript.jsonl for that
// session; parseClaudeTranscript() turns it into readable text for extractSkill(). Org defaults
// to the basename of `cwd` (the project directory) so skills naturally group by project, not by
// a single catch-all "default" bucket, unless overridden.
//
// Real, documented caveat this has to account for: the transcript file is written
// ASYNCHRONOUSLY and may still be lagging behind the actual last turn at the moment SessionEnd
// fires — so this polls for the file's size to stabilize (unchanged across two checks) for a few
// seconds before parsing, rather than reading whatever partial content exists the instant the
// hook starts. Never throws past that: a hook that fails must not block or error out a user's
// session close, so every failure path here just logs and exits 0.
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitForStableFile(p, attempts = 6, intervalMs = 500) {
  let lastSize = -1;
  for (let i = 0; i < attempts; i++) {
    let size;
    try { size = fs.statSync(p).size; } catch (_) { size = -1; }
    if (size !== -1 && size === lastSize) return true;
    lastSize = size;
    await sleep(intervalMs);
  }
  return fs.existsSync(p);
}
async function cmdHookSessionEnd(_flags, cfg) {
  let payload = '';
  try { payload = fs.readFileSync(0, 'utf8'); } catch (_) { /* no stdin — nothing to do */ }
  let hookData;
  try { hookData = JSON.parse(payload); } catch (_) { console.error('icarus hook session-end: no valid JSON on stdin, skipping.'); return; }
  const { transcript_path: transcriptPath, cwd } = hookData;
  if (!transcriptPath) { console.error('icarus hook session-end: no transcript_path in hook payload, skipping.'); return; }
  if (!llmConfigured(cfg)) return; // silent — this only fires automatically; no key configured means nothing to do, not an error
  await waitForStableFile(transcriptPath);
  const transcript = parseClaudeTranscript(transcriptPath);
  if (!transcript.trim()) { console.error('icarus hook session-end: empty transcript after parsing, skipping.'); return; }
  const org = process.env.ICARUS_HOOK_ORG || (cwd ? path.basename(cwd) : 'default');
  try {
    const saved = await skillSave(transcript, org, cfg);
    if (saved) console.error(`icarus: skill auto-saved from session → ${saved}`); // stderr: SessionEnd's stdout isn't shown to the user
  } catch (e) {
    console.error('icarus hook session-end: extraction failed —', e.message);
  }
}

// The PATH line install.sh's ensure_path() appends — same literal string, so removal matches
// exactly what was added, never a fuzzy/regex guess at "any icarus-looking PATH export" that
// could delete something a user wrote themselves.
function pathLine() {
  return `export PATH="${path.join(HOME, 'bin')}:$PATH"`;
}
function shellRcFiles() {
  const h = os.homedir();
  return [path.join(h, '.zshrc'), path.join(h, '.bashrc'), path.join(h, '.profile')].filter((p) => fs.existsSync(p));
}

function dirSizeMb(dir) {
  let bytes = 0;
  try {
    (function rec(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) rec(p);
        else { try { bytes += fs.statSync(p).size; } catch (_) { /* race */ } }
      }
    })(dir);
  } catch (_) { /* dir vanished mid-walk, or never existed */ }
  return (bytes / 1e6).toFixed(1);
}

// Real uninstall — everything install.sh/setup ever wrote, and nothing else. Detect-then-confirm-
// then-remove, same shape as the rest of this CLI's destructive-adjacent commands: show exactly
// what will happen before doing it, `--yes` skips the prompt for scripted use.
async function cmdPrune(flags, _cfg) {
  const { detectRemovable, removeAll } = require('./mcp-install.js');
  const icarusExists = fs.existsSync(HOME);
  const line = pathLine();
  const rcHits = shellRcFiles().filter((rc) => fs.readFileSync(rc, 'utf8').includes(line));
  const mcpHits = detectRemovable().filter((r) => r.found);

  console.log(`${heading('icarus prune')} — this will remove:\n`);
  if (icarusExists) console.log(`  ${c.error(glyphs.ballotX)} ${c.path(HOME)} (${dirSizeMb(HOME)} MB — bin, config, data, src)`);
  else console.log(c.dim(`  · ${HOME} — not found, nothing to remove`));
  for (const rc of rcHits) console.log(`  ${c.error(glyphs.ballotX)} PATH line in ${c.path(rc)}`);
  for (const r of mcpHits) console.log(`  ${c.error(glyphs.ballotX)} MCP entr${r.entries.length > 1 ? 'ies' : 'y'} (${r.entries.join(', ')}) in ${c.path(r.path)}`);
  if (!icarusExists && !rcHits.length && !mcpHits.length) {
    return console.log(c.dim('\nNothing found — icarus is already fully removed.'));
  }
  console.log(c.bold(c.error('\nData in ~/.icarus/data (ingested memories) and any HIVEMIND connection token go with it — this is not reversible.')));

  if (!flags.yes) {
    const ask = makePrompter();
    const ans = (await ask('\nProceed? [y/N] ')).trim().toLowerCase();
    ask.close();
    if (ans !== 'y' && ans !== 'yes') return console.log(c.dim('Aborted — nothing removed.'));
  }

  const removed = removeAll();
  for (const r of removed) if (r.removed) console.log(ok(`removed icarus MCP registration from ${c.path(r.path)}`));
  for (const rc of rcHits) {
    const content = fs.readFileSync(rc, 'utf8');
    fs.writeFileSync(rc, content.split('\n').filter((l) => l.trim() !== line).join('\n'));
    console.log(ok(`removed PATH line from ${c.path(rc)}`));
  }
  if (icarusExists) {
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log(ok(`removed ${c.path(HOME)}`));
  }
  console.log(c.dim('\nicarus fully removed from this machine. Restart any open Claude Code/Cursor/Codex session to drop the MCP registration.'));
}

async function cmdMcpServe(_flags, _cfg) {
  // Lazy require: @modelcontextprotocol/sdk is only needed for this one subcommand, so every
  // other command (ingest/recall/status/...) stays dependency-free at require-time.
  await require('./mcp-serve.js').run();
}

async function cmdMcpInstall(flags, _cfg) {
  // flags._[0] is still "install" here (mneme-cli's own `mcp` case reads it as `sub` but never
  // consumes it from the array) -- run()'s own agent-name arg needs it shifted off, or
  // `icarus mcp install claude` would read "install" itself as the agent name, not "claude".
  await require('./mcp-install.js').run({ ...flags, _: flags._.slice(1) });
}

async function cmdDaemon(flags, _cfg) {
  // Lazy require: daemon.js's own deps (http, child_process) are core Node, but keep the
  // require lazy anyway for consistency — the daemon subcommands are the only callers.
  const daemon = require('./daemon.js');
  const sub = flags._[0];
  if (sub === 'start') return daemon.start(flags);
  if (sub === 'stop') return daemon.stop();
  if (sub === 'status') return daemon.status();
  throw new Error('usage: icarus daemon <start|stop|status> [--port 8137]');
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  // `--version` before anything else: release automation has to be able to ask a freshly
  // built binary what it is, and prove it matches the tag it was published under. That check
  // must not depend on config being loadable, a shard existing, or the addon being present —
  // so it is answered here, ahead of loadCfg(), and prints ONLY the bare version so callers
  // can compare it directly instead of parsing a banner.
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(ICARUS_VERSION);
    return;
  }

  const cfg = loadCfg();
  try {
    // Bare `icarus` (no subcommand) on a real TTY launches the interactive shell instead of the
    // help text — matches the "grok-build-style boxed banner + /slash-command REPL" request.
    // Piped/non-TTY invocations (scripts, CI) keep falling through to the plain-text help below —
    // a slash-command shell has no meaning without a terminal to type into.
    if (cmd === undefined && process.stdout.isTTY && process.stdin.isTTY) {
      await require('./tui.js').run();
      return;
    }
    switch (cmd) {
      case 'ingest': await cmdIngest(flags, cfg); break;
      case 'recall': await cmdRecall(flags, cfg); break;
      case 'save': await cmdSave(flags, cfg); break;
      case 'status': cmdStatus(flags, cfg); break;
      case 'compact': cmdCompact(flags, cfg); break;
      case 'train-pq': cmdTrainPq(flags, cfg); break;
      case 'connect': await cmdConnect(flags, cfg); break;
      case 'connect-embeddings': await cmdConnectEmbeddings(flags, cfg); break;
      case 'connect-llm': await cmdConnectLlm(flags, cfg); break;
      case 'setup': await cmdSetup(flags, cfg); break;
      case 'mcp-serve': await cmdMcpServe(flags, cfg); break;
      case 'mcp': {
        const sub = flags._[0];
        if (sub === 'install') await cmdMcpInstall(flags, cfg);
        else if (sub === 'serve') await cmdMcpServe(flags, cfg);
        else throw new Error('usage: icarus mcp <install|serve>');
        break;
      }
      case 'daemon': await cmdDaemon(flags, cfg); break;
      case 'prune': await cmdPrune(flags, cfg); break;
      case 'hook': {
        const sub = flags._[0];
        if (sub === 'session-end') await cmdHookSessionEnd(flags, cfg);
        else throw new Error('usage: icarus hook session-end   (reads Claude Code\'s SessionEnd JSON payload from stdin)');
        break;
      }
      case 'harness': await cmdHarness(flags); break;
      case 'doctor': cmdDoctor(flags); break;
      case 'task': cmdTask(flags); break;
      case 'context': cmdContext(flags); break;
      case 'run': cmdRun(flags); break;
      case 'harness-skill': cmdHarnessSkill(flags); break;
      case 'graph': await require('./graph.js').run(flags); break;
      case 'skill': await cmdSkill(flags, cfg); break;
      case 'verify': cmdVerify(flags, cfg); break;
      case 'audit': cmdAudit(flags, cfg); break;
      case 'update': await cmdUpdate(flags, cfg); break;
      default:
        console.log(colorizeHelp(`icarus — memory filesystem CLI (the .amr engine)

  Run "icarus" with no arguments on a real terminal for an interactive shell (/ingest, /recall,
  /status, /connect as slash commands) instead of one-shot subcommands below.

  icarus ingest <dir> --org <name> [--full]
                                        extract + embed + store a folder. If icarus connect has a
                                        HIVEMIND token, routes through HIVEMIND's real API
                                        instead of the local engine — accepts everything the
                                        server itself supports (pdf/docx/xlsx/pptx/images/audio),
                                        a broader set than the local engine's text-only formats.
                                        By default the server's chunked segment TEXT is pulled
                                        back and re-embedded + stored in the LOCAL shard too
                                        (--no-mirror to skip and stay purely server-side) — the
                                        server never exposes its own embedding vectors over HTTP
                                        (confirmed absent), so this is cloud chunking + local
                                        re-embedding, not cloud embedding. HIVEMIND is used as a
                                        stateless extraction PIPELINE only: once mirrored locally,
                                        icarus deletes the document it just created server-side
                                        (--keep-cloud to skip that and leave it there) -- a
                                        pre-existing duplicate found server-side is never deleted,
                                        only what this run itself created.
                                        --local forces the local .amr engine even if connected.
                                        Connected ingest is evidence-only by default (fast; no
                                        memory/entity generation). Pass --full for both.
                                        --force matches the real FE's own force field (bypass
                                        dedup) -- not yet read server-side, sent to match the
                                        real contract exactly.
  icarus recall "<query>" --org <name> [--k 5] [--pq]
                                        LOCAL ONLY, always -- never routes to HIVEMIND's shared
                                        recall (a real cross-tenant leak was found there: other
                                        orgs' private content came back for this org's queries).
                                        Real parallel hybrid retrieval: dense (HNSW) + lexical
                                        (BM25) run concurrently, merged via Reciprocal Rank
                                        Fusion. If HIVEMIND connected: narrow re-score via the
                                        real bge-reranker-v2-m3 cross-encoder on top of that wide
                                        hybrid merge. If not: the hybrid merge IS the answer, no
                                        rerank stage.
  icarus save "<text>" --org <name> [--cloud]
                                        LOCAL ONLY by default -- real embedding, stored in the
                                        local .amr shard, never touches HIVEMIND's cloud memory
                                        box on its own. --cloud opts back in explicitly: a real,
                                        permanent HIVEMIND memory too (mode:'atomic', full
                                        smart-router + contradiction-check, same primitive MCP
                                        save_memory uses) -- still mirrored locally either way, so
                                        icarus recall keeps working regardless.
  icarus compact --org <name>          reclaim deleted memories' bytes
  icarus train-pq --org <name> [--seed 42]
                                        train PQ codebook -> enables --pq recall (see below)
  icarus status                        shards + disk usage
  icarus harness-skill propose --file <skill.json> [--repo <dir>]
                                        submit a reusable, untrusted coding procedure backed by
                                        sealed governed tasks; it cannot enter agent context yet.
  icarus harness-skill promote <id> [--approval <id>] [--repo <dir>]
                                        activate a replay-verified procedure. High-risk skills
                                        require an attributable owner approval.
  icarus harness-skill retire <id> --reason <text> --approval <id> [--repo <dir>]
                                        remove a stale or unsafe procedure from future governed
                                        context while preserving its approval-backed audit trail.
  icarus setup                         guided, one-by-one wizard: detect coding agents, connect
                                        memory generation, embeddings, HIVEMIND — do this first
  icarus connect [--api-url <url>] [--token <tok>] [--oauth-only]
                                        link your HIVEMIND account. Default flow: opens your
                                        browser to sign in (defaults to api.singulancelabs.com,
                                        override with --api-url or HIVEMIND_URL), no token to
                                        paste — falls back to a manual token if that doesn't
                                        complete. --oauth-only tries only the browser flow and
                                        exits nonzero on failure, no prompt (used by install.sh).
  icarus connect-embeddings [--disable]
                                        configure an embedding provider for vector recall — OPT
                                        IN, not required: with none configured, ingest/recall
                                        run lexical-only (BM25), not an error
  icarus connect-llm [--disable]       configure a memory-generation (distillation) provider —
                                        OpenRouter or your own Anthropic API key. OPT IN; with
                                        none configured, ingest stores raw text unchanged.
                                        NEVER a Claude.ai/Codex subscription login — Anthropic's
                                        own terms prohibit third-party tools from doing that.
  icarus skill save [file] --org <name>  distill a session transcript (file, or piped stdin) into
                                        a Claude-Code-shaped skill .md, saved to ~/.icarus/skills
  icarus skill list --org <name>       list skills saved for an org
                                        needs connect-llm configured (memory generation)
  icarus hook session-end              automatic skill generation, wired as a Claude Code
                                        SessionEnd hook (icarus setup offers to install it) —
                                        reads Claude Code's own hook JSON from stdin, no manual
                                        transcript handling needed. Not meant to be run by hand.
  icarus graph build --repo <dir>      native symbol/call-graph index (Tree-sitter via WASM,
                                        SQLite storage) — JS/TS + Rust for now, no Python/uvx dep
  icarus graph status --repo <dir>     node/edge/file counts for the built graph
  icarus graph query --kind <callers_of|callees_of|imports_of|find> --name <symbol> [--repo <dir>]
  icarus harness init [--agent claude|codex|cursor|grok|all] [--repo <dir>]
                                        initialize the deterministic repository harness: tracked
                                        manifest/policy/schemas plus ignored runtime state. No LLM
                                        calls are made; existing graph data is copied safely.
  icarus doctor [--repo <dir>]          verify the harness manifest, runtime, event integrity,
                                        graph migration state, and available agent adapters.
  icarus task start --objective <text> --contract <contract.json> [--repo <dir>]
                                        create a Rust-governed task with an immutable v1 contract.
  icarus task <status|resume> <TASK-ID> [--repo <dir>]
  icarus task transition <TASK-ID> <state> [--repo <dir>]
  icarus task reconcile <TASK-ID> [--repo <dir>]
  icarus task amend <TASK-ID> --contract <contract.json> --reason <text> [--approval <id>]
  icarus task checkpoint <TASK-ID> --phase <name> [--input <json-file>]
  icarus task block <TASK-ID> --reason <text> [--repo <dir>]
  icarus task attest <TASK-ID> --criterion <id> --approval <id> --approver <name> [--expires-at <rfc3339>]
                                        record a manual/external approval receipt. External
                                        approvals expire and must remain valid when sealing.
  icarus context build --task <TASK-ID> [--budget <tokens>] [--since-checkpoint <n>] [--format json|markdown] [--repo <dir>]
                                        compile a deterministic, source-traceable context pack
                                        without making an LLM or network call.
  icarus task authorize <TASK-ID> --kind write --path <repo-relative-path> [--repo <dir>]
                                        inspect, resume, transition, or ask the Rust authority
                                        whether a scoped action is allowed. No LLM is invoked.
  icarus mcp install                   register icarus as an MCP server in every coding agent
                                        found on this machine (Claude Code, Codex, Cursor) —
                                        exposes icarus_graph_build/status/query natively too
  icarus mcp install <claude|codex|cursor>
                                        run from a project's own folder: registers just that
                                        agent, writes its project instruction file (CLAUDE.md/
                                        AGENTS.md/.cursor rule) with THIS repo's own derived org
                                        name, and physically creates a real .icarus/data/<org>
                                        shard right there in the repo (added to .gitignore) --
                                        every agent working in this repo shares that one org, so
                                        Claude Code/Codex/Cursor all read/write the same memory
  icarus mcp serve                     run the MCP server directly (stdio) — what the agents
                                        installed above actually launch
  icarus daemon start [--port 8137]    run ICARUS as a persistent local HTTP service (a shared
                                        process anything on this machine can call — editors,
                                        scripts, a future local panel — instead of each spawning
                                        its own icarus process). Separate from mcp serve: that's
                                        stdio, one per agent session; this is one long-running
                                        process reached over http://127.0.0.1:<port>.
  icarus daemon stop
  icarus daemon status
  icarus update                        self-update: download + verify the latest release binary,
                                        atomically replace the currently running one. Compiled-
                                        binary installs only (source builds: git pull instead).
  icarus prune [--yes]                 remove EVERYTHING icarus installed: ~/.icarus (bin,
                                        config, data, src), the PATH line install.sh added, and
                                        its MCP registration from Claude Code/Cursor/Codex. Shows
                                        exactly what will be removed and asks first, unless
                                        --yes. Not reversible — ingested data goes with it.
  icarus verify <slot_id> --org <name> check a memory's ML-DSA-65 (FIPS 204) signature against
                                        its current stored content — real tamper detection, not
                                        just a checksum. Every icarus ingest signs on by default;
                                        keys live at ~/.icarus/keys (0600), generated on first use.
  icarus audit checkpoint --org <name> sign the audit trail's current tip with SLH-DSA-SHA2-128s
                                        (FIPS 205) — a real, separate algorithm from icarus verify
                                        above, attesting the SEQUENCE of writes hasn't been
                                        edited/reordered/spliced, not just one memory's content.
  icarus audit verify --org <name>     replay the full hash chain from genesis + verify the
                                        latest checkpoint's signature. Reports exactly where a
                                        broken chain diverges, and how many entries since the
                                        last checkpoint are chained but not yet signed.

  --pq recall (icarus recall --pq): an alternative to the default HNSW recall, not a universal
  upgrade — measured on real data, it builds much faster always, and queries FASTER than HNSW
  only on small/medium shards (recall_pq loses to HNSW's query latency as shard size grows).
  Good fit: shards you rebuild often. Run train-pq once first, or --pq errors with that reminder.

  env: OPENROUTER_API_KEY (embeddings + memory generation, optional — see connect-embeddings/connect-llm)
       ANTHROPIC_API_KEY (memory generation via Anthropic's own API instead — see connect-llm)
       LITELLM_API_KEY / LITELLM_BASE_URL (embeddings via your own LiteLLM/blaiq gateway instead)
       ICARUS_HOME (default ~/.icarus)`));
        // An UNRECOGNIZED subcommand is a usage error and must exit non-zero. It used to print
        // this help and exit 0, which meant a typo in a script or CI step silently "succeeded"
        // while doing nothing — the worst possible outcome for a tool whose whole job is
        // trustworthy state. Explicitly asking for help (`help`, `--help`, `-h`, or a bare
        // `icarus` with no arguments) is NOT an error and still exits 0.
        //
        // Exit 2 rather than 1, following the long-standing convention that 2 means "wrong
        // usage" while 1 means "ran correctly and the answer was no / it failed" — that
        // distinction lets a caller tell a broken invocation apart from a real failure.
        if (cmd !== undefined && cmd !== 'help' && cmd !== '--help' && cmd !== '-h') {
          console.error(err(`unknown command: ${cmd}`));
          process.exitCode = 2;
        }
    }
  } catch (e) {
    console.error(err(e.message));
    process.exit(1);
  }
}

main();
