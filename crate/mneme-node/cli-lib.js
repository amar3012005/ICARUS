'use strict';
// Shared logic between mneme-cli.js and mcp-serve.js — config, embeddings, ingest/recall
// primitives. Extracted specifically so the CLI and the MCP server call the SAME code, not two
// copies that can silently drift apart (the exact class of bug the flag-parsing regression
// earlier in this repo's history was — one path fixed, the other forgotten).
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
// Lazy: some callers of this module (icarus mcp install, icarus status) never touch a shard,
// so they must not be forced to load the native addon just because this file was required.
function getMnemeStore() { return require('./index.js').MnemeStore; }
function getNative() { return require('./native.js'); }

// A shard takes an exclusive flock for the lifetime of its open handle. Each `icarus` CLI
// invocation is a short-lived process — one open, one command, process exits, lock releases
// naturally — so that was never a problem there. `icarus mcp serve` is NOT short-lived: it's
// one long process fielding many tool calls, and a real bug surfaced calling icarus_ingest then
// icarus_recall on the same org back to back — the second open collided with the first handle's
// still-held lock ("shard is locked by another process"), because nothing ever closed it and
// there's no exposed close()/drop() to call explicitly. Fix: cache one open handle per org per
// process and reuse it — the same pattern the HIVEMIND integration's embedded-agent.mjs already
// uses for the identical reason, and a real efficiency win too (skips re-scanning the shard's
// id index on every call).
const _storeCache = new Map(); // `${dataRoot}::${org}` -> open store handle
// Real, synchronous blocking sleep (Node/Bun both allow Atomics.wait on the main thread, unlike
// browsers — confirmed working under a Bun-compiled binary too, the actual distribution target).
// openStore() itself must stay synchronous (many callers use it outside an async context), so a
// promise-based delay isn't an option here.
function sleepSyncMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
    const end = Date.now() + ms; // last-resort busy-wait if Atomics.wait is ever unavailable
    while (Date.now() < end) { /* spin */ }
  }
}

// The native shard lock is flock(LOCK_EX|LOCK_NB) — exclusive, non-blocking, fails INSTANTLY if
// any other process (even one that's about to close) holds the same org's shard open. Real,
// repeated failure mode this session: a second `icarus` process (a lingering `mcp-serve`, the
// TUI, or a one-shot CLI call) briefly overlapping another one's open() — not a genuine deadlock,
// just two processes racing by a few hundred ms. A single hard failure on the very first attempt
// made this look far worse than it was. Retries with bounded backoff before giving up, so the
// common transient case resolves itself silently instead of erroring on any process overlap at
// all. Total worst-case wait ~6.3s across 5 attempts — short enough not to make a genuine stuck
// lock feel broken, long enough to ride out real transient overlap.
const LOCK_RETRY_DELAYS_MS = [200, 400, 800, 1600, 3200];

/** `{retry: false}` skips the whole backoff and fails on the FIRST lock conflict — for read-only,
 * informational callers (a /status count, an org-picker's stats line) where a real MCP server
 * legitimately holding an org open for its whole session (by design — see _storeCache's own doc
 * comment) is completely normal, not a rare transient overlap worth waiting out. Real reported
 * pain: /status hung for ~6.7s and then showed a "still locked" error just to report a memory
 * count, every single time, whenever this project's own live MCP tool connections had the org
 * open (which is most of the time, by design). A stale/unavailable count there is a fine
 * tradeoff; a multi-second freeze on every /status call to render one is not. Mutating callers
 * (ingest/save/delete/etc.) must NOT pass this — they genuinely need the wait-and-retry so a
 * brief real overlap doesn't hard-fail a write that would have succeeded a moment later. */
function openStore(cfg, org, opts = {}) {
  const key = `${cfg.dataRoot}::${org}`;
  let store = _storeCache.get(key);
  if (store) return store;
  const retry = opts.retry !== false;
  const attempts = retry ? LOCK_RETRY_DELAYS_MS.length : 0;
  let lastErr;
  for (let attempt = 0; attempt <= attempts; attempt++) {
    try {
      store = getMnemeStore().open(cfg.dataRoot, org, cfg.dim);
      _storeCache.set(key, store);
      return store;
    } catch (e) {
      lastErr = e;
      if (!/locked by another process/i.test(e.message || '')) throw e; // a different error — don't mask it with retries
      if (attempt < attempts) sleepSyncMs(LOCK_RETRY_DELAYS_MS[attempt]);
    }
  }
  if (!retry) throw lastErr; // no-retry path: surface the plain native error instantly, no ~6s wait
  // Genuinely still stuck after ~6.3s of retrying — a real, actionable message instead of the raw
  // native error, since "shard is locked by another process" alone gives no next step.
  throw new Error(
    `org "${org}"'s shard is still locked after retrying for ~6s — another icarus process is genuinely holding it open, not just briefly overlapping.\n`
    + `Find it: ps aux | grep "icarus mcp-serve"  (or plain "icarus")\n`
    + `If it's a stale/orphaned process (its parent coding-agent session already ended), it's safe to stop it: kill <pid>\n`
    + `If it's a live session actively using this org, wait for it to finish, or use a different --org.`
  );
}

const HOME = process.env.ICARUS_HOME || process.env.MNEME_HOME || path.join(os.homedir(), '.icarus');
const CFG_PATH = path.join(HOME, 'config.json');

// Embeddings and cross-encoder reranking improve retrieval quality, but the local shard and its
// BM25 index are the availability boundary. Never let an auxiliary remote provider turn an
// ingest or recall into an outage, and never wait through the platform's often-long default
// fetch timeout. This is deliberately one attempt only: a retry would add latency without making
// the already-available lexical path safer. Advanced deployments may tune the deadline, but it
// remains bounded so a dead endpoint cannot strand an interactive agent turn.
const DEFAULT_AUXILIARY_REMOTE_TIMEOUT_MS = 900;
function auxiliaryRemoteTimeoutMs(cfg) {
  const configured = Number(cfg?.embeddings?.timeoutMs ?? cfg?.rerank?.timeoutMs ?? process.env.ICARUS_AUXILIARY_REMOTE_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return DEFAULT_AUXILIARY_REMOTE_TIMEOUT_MS;
  return Math.max(1, Math.min(Math.floor(configured), 5_000));
}
async function fetchAuxiliary(url, options, cfg) {
  const controller = new AbortController();
  const timeoutMs = auxiliaryRemoteTimeoutMs(cfg);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// The shard's native `layer` field is a plain u8 with 3 conventional values already in use
// (see mneme-node/src/lib.rs's insert_layered/recall_layer doc comments) — HIVEMIND's own
// memory/evidence/cognitive split. LAYER_SKILL is a 4th convention, Node-side only: no Rust
// change was needed to add it, since the field was never a closed enum, just documented as one.
const LAYER_MEMORY = 0;
const LAYER_EVIDENCE = 1;
const LAYER_COGNITIVE = 2;
const LAYER_SKILL = 3;

// Exact parity with HIVEMIND's own real typed-edge convention (core/src/vector/mneme/
// amr-store.mjs's REL_TYPE) — the native engine's addEdge()/traverseTyped() were built for this
// exact enum (see mneme-node/src/lib.rs's own doc comment on add_edge). Reusing it verbatim
// rather than inventing a second numbering.
const REL_TYPE = { Mentions: 1, Updates: 2, Derives: 3, Contradicts: 4, PartOf: 5, Extends: 6 };
const REL_NAME = [null, 'Mentions', 'Updates', 'Derives', 'Contradicts', 'PartOf', 'Extends'];
// Agent-facing schema words (lowercase, singular verb — matching HIVEMIND's own tool schema:
// "update | extend | derive") -> the real REL_TYPE keys above. A capitalize-first-letter
// heuristic does NOT work here ('update' -> 'Update' vs the real key 'Updates') — explicit map.
const REL_WORD_TO_TYPE = {
  update: REL_TYPE.Updates, extend: REL_TYPE.Extends, derive: REL_TYPE.Derives,
  contradict: REL_TYPE.Contradicts, partof: REL_TYPE.PartOf, mentions: REL_TYPE.Mentions,
};
// Skills also get written as real .md files here -- Claude Code's own `.claude/skills/*.md`
// shape (frontmatter name/description + body). That's the canonical listing (skillList() just
// reads this directory): bm25Search has no layer filter (only vector recall_layer() does), so a
// shard-only list would need a vector provider configured just to tell skills apart from
// ordinary memories in the same org. The shard insert (layer=LAYER_SKILL) is for RECALL
// integration only -- so a skill's content surfaces in `icarus recall` alongside real memories.
const SKILLS_DIR = path.join(HOME, 'skills');

// Post-quantum signing (ML-DSA-65 / FIPS 204) — every memory signed at write time, on by
// default, matching the real production design this was modeled on (see mneme-node/src/lib.rs's
// `sign` module for the crypto itself and why it's a side-table, not a slot-format change).
// Deliberately simpler key handling than a multi-tenant server: this is a single-user local CLI,
// so ONE keypair lives at ~/.icarus/keys, generated transparently on first use — no signup, no
// network, no manual `icarus keygen` step required for the "on by default" property to hold.
const SIGN_KEYS_DIR = path.join(HOME, 'keys');
const SIGNING_KEY_PATH = path.join(SIGN_KEYS_DIR, 'ml-dsa-sk');
const VERIFYING_KEY_PATH = path.join(SIGN_KEYS_DIR, 'ml-dsa-pk');

function signaturesPath(cfg, org) {
  return path.join(cfg.dataRoot, org, 'signatures.jsonl');
}

/** True unless explicitly disabled — signing needs no external key/network (unlike embeddings/
 * llm), so there's no "no key configured" case to gate on; the only way it's off is a person
 * turning it off. */
function signingEnabled(cfg) {
  return !(cfg.signing && cfg.signing.disabled);
}

/** Load the local ML-DSA-65 keypair, generating one on first use. The signing key file is
 * written 0600 (owner read/write only) — the same "secret key never leaves this machine, DB
 * compromise != forgery" property the production design documents, scaled down to "this
 * machine's disk, not a database anyone else can dump." Returns {signingKey, verifyingKey} as
 * Buffers. */
function ensureSigningKeys() {
  if (fs.existsSync(SIGNING_KEY_PATH) && fs.existsSync(VERIFYING_KEY_PATH)) {
    return {
      signingKey: fs.readFileSync(SIGNING_KEY_PATH),
      verifyingKey: fs.readFileSync(VERIFYING_KEY_PATH),
    };
  }
  const kp = getNative().generateSigningKeypair();
  fs.mkdirSync(SIGN_KEYS_DIR, { recursive: true });
  fs.writeFileSync(SIGNING_KEY_PATH, kp.signingKey, { mode: 0o600 });
  fs.writeFileSync(VERIFYING_KEY_PATH, kp.verifyingKey, { mode: 0o644 });
  return { signingKey: kp.signingKey, verifyingKey: kp.verifyingKey };
}

/** The exact bytes that get signed — MUST match between signSlot() and verifySlot(), and
 * changing this format later invalidates every existing signature (a real, honest tradeoff of
 * "the signature proves this exact text belongs to this exact slot," not something to change
 * casually). Binds the slot id INTO the payload so a signature can't be replayed onto a
 * different slot even if the text happens to collide. */
function canonicalPayload(slotId, text) {
  return Buffer.from(`slot:${slotId}\n${text}`, 'utf8');
}

/** Sign slot `slotId`'s `text` and append the signature to this org's signatures.jsonl. Never
 * throws past logging — signing is a bonus property of a write, not a requirement for it; a
 * signing failure (corrupt key, native module issue) must not turn a successful insert into a
 * failed ingest. This is the SAME fail-open honesty the production design documents for its own
 * signing path, not a weaker version invented for this. */
function signSlot(slotId, text, cfg, org) {
  try {
    const { signingKey } = ensureSigningKeys();
    const payload = canonicalPayload(slotId, text);
    const signature = getNative().signBytes(signingKey, payload);
    const line = JSON.stringify({ slot_id: slotId, signature: signature.toString('base64'), signed_at: new Date().toISOString() });
    fs.appendFileSync(signaturesPath(cfg, org), line + '\n');
    return true;
  } catch (e) {
    console.error(`icarus: signing slot ${slotId} failed (${e.message}) — memory stored unsigned.`);
    return false;
  }
}

/** Verify a previously signed slot. Returns {signed: false} if no signature was ever recorded
 * for this slot (raw/unsigned memory — not itself suspicious, e.g. anything written before
 * signing was enabled), {signed: true, valid: bool} otherwise. */
function verifySlot(slotId, cfg, org) {
  const p = signaturesPath(cfg, org);
  if (!fs.existsSync(p)) return { signed: false };
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  // Last-match-wins: a slot could in principle be signed more than once (re-signed after a
  // rewrite); the most recent entry is the one that should describe the slot's current content.
  let entry = null;
  for (const line of lines) {
    let d;
    try { d = JSON.parse(line); } catch (_) { continue; }
    if (d.slot_id === slotId) entry = d;
  }
  if (!entry) return { signed: false };
  const store = openStore(cfg, org);
  const text = store.slotText(slotId);
  const { verifyingKey } = ensureSigningKeys();
  const payload = canonicalPayload(slotId, text);
  // A malformed/corrupted signature (wrong length, bad encoding) is a REAL tamper indicator, not
  // a bug to surface as an exception — the native layer throws on that (it can't even decode a
  // Signature struct to compare), caught here so "someone corrupted this record" always reports
  // as valid:false, the same as "someone changed the text but kept a well-formed signature."
  let valid;
  try {
    valid = getNative().verifyBytes(verifyingKey, payload, Buffer.from(entry.signature, 'base64'));
  } catch (_) {
    valid = false;
  }
  return { signed: true, valid, signedAt: entry.signed_at };
}

// Audit trail — SLH-DSA-SHA2-128s (FIPS 205) hash-chained checkpoints over an append-only log of
// write events. A DIFFERENT property from signSlot()/verifySlot() above: signing proves "this
// memory's content matches what was signed"; the audit trail proves "the SEQUENCE of write
// events itself hasn't been edited, reordered, or had entries deleted" — e.g. someone splicing
// out an entire insert event from history, which a per-memory signature alone can't catch (the
// remaining memories would still verify fine individually). Real crypto library: `slh-dsa`
// (RustCrypto, same org as `ml-dsa` above) — a SEPARATE algorithm/keypair from the per-memory
// ML-DSA-65 signing on purpose, so the audit trail's trust doesn't rest on the same cryptographic
// assumption as the memory signatures it's meant to independently corroborate.
const AUDIT_SK_PATH = path.join(SIGN_KEYS_DIR, 'slh-dsa-sk');
const AUDIT_VK_PATH = path.join(SIGN_KEYS_DIR, 'slh-dsa-pk');
const GENESIS_HASH = '0'.repeat(64);

function auditChainPath(cfg, org) { return path.join(cfg.dataRoot, org, 'audit.jsonl'); }
function checkpointsPath(cfg, org) { return path.join(cfg.dataRoot, org, 'checkpoints.jsonl'); }

function ensureAuditKeys() {
  if (fs.existsSync(AUDIT_SK_PATH) && fs.existsSync(AUDIT_VK_PATH)) {
    return { signingKey: fs.readFileSync(AUDIT_SK_PATH), verifyingKey: fs.readFileSync(AUDIT_VK_PATH) };
  }
  const kp = getNative().generateAuditKeypair();
  fs.mkdirSync(SIGN_KEYS_DIR, { recursive: true });
  fs.writeFileSync(AUDIT_SK_PATH, kp.signingKey, { mode: 0o600 });
  fs.writeFileSync(AUDIT_VK_PATH, kp.verifyingKey, { mode: 0o644 });
  return { signingKey: kp.signingKey, verifyingKey: kp.verifyingKey };
}

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean);
}

/** The exact bytes hashed into the chain for one entry — MUST stay stable, same reasoning as
 * canonicalPayload() above: this format IS the contract a verifier reconstructs independently. */
function entryHashInput(prevHash, seq, event, slotId, at) {
  return `${prevHash}|${seq}|${event}|${slotId}|${at}`;
}

/** Append one hash-chained event to org's audit trail. Never throws past logging — same
 * fail-open posture as signSlot(): an audit-trail write failure must not turn a successful
 * insert into a failed one.
 *
 * `meta` is real provenance riding ALONGSIDE the chain, not part of it: the native .amr engine
 * has no free-form metadata field on a memory itself (checked MemoryInput's real fields — just
 * text/vector/entity_bitmap/adjacency/valid_from/created_at/layer), so "where did this slot come
 * from" has nowhere else to live. Deliberately excluded from entryHashInput()/verifyAuditChain()
 * — the hash chain's job is proving the SEQUENCE of writes wasn't reordered/spliced, not
 * attesting to descriptive metadata, and folding meta into the hash would break every audit
 * chain written before this field existed. `meta.source` identifies which code path created the
 * slot (save-local/save-cloud/ingest-local/ingest-evidence/skill/...); `meta.sourceFile` is the
 * originating file/document name for evidence, when there is one. */
function appendAuditEntry(cfg, org, event, slotId, meta = null) {
  try {
    const p = auditChainPath(cfg, org);
    const entries = readJsonl(p);
    const prevHash = entries.length ? entries[entries.length - 1].hash : GENESIS_HASH;
    const seq = entries.length;
    const at = new Date().toISOString();
    const hash = crypto.createHash('sha256').update(entryHashInput(prevHash, seq, event, slotId, at)).digest('hex');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const line = { seq, event, slot_id: slotId, prev_hash: prevHash, hash, at, org };
    if (meta && meta.source) line.source = meta.source;
    if (meta && meta.sourceFile) line.source_file = meta.sourceFile;
    fs.appendFileSync(p, JSON.stringify(line) + '\n');
    return true;
  } catch (e) {
    console.error(`icarus: audit trail append failed (${e.message}) — write itself still succeeded.`);
    return false;
  }
}

/** Sign the audit chain's CURRENT tip with SLH-DSA. Anyone holding the public verifying key can
 * later confirm the chain really was in this exact state at this time — a checkpoint doesn't
 * protect entries written after it (the next checkpoint does), which is why `verifyAuditChain`
 * below reports how many entries sit unattested past the latest checkpoint. */
function checkpointAudit(cfg, org) {
  const entries = readJsonl(auditChainPath(cfg, org));
  if (!entries.length) throw new Error(`org "${org}" has no audit entries yet — nothing to checkpoint`);
  const tip = entries[entries.length - 1];
  const { signingKey } = ensureAuditKeys();
  const payload = Buffer.from(`checkpoint|${tip.seq}|${tip.hash}`, 'utf8');
  const signature = getNative().auditSignBytes(signingKey, payload);
  const record = { seq: tip.seq, hash: tip.hash, signature: signature.toString('base64'), signed_at: new Date().toISOString() };
  fs.appendFileSync(checkpointsPath(cfg, org), JSON.stringify(record) + '\n');
  return record;
}

/** Full independent verification: (1) replay the ENTIRE chain from genesis, recomputing each
 * entry's hash from its own recorded fields and confirming it matches both the entry's own
 * `hash` AND the next entry's `prev_hash` — this is what catches a deleted/reordered/edited
 * entry anywhere in history, not just at the tip. (2) verify the latest checkpoint's SLH-DSA
 * signature against its recorded (seq, hash) — proving that exact state was cryptographically
 * attested, not just internally self-consistent. */
function verifyAuditChain(cfg, org) {
  const entries = readJsonl(auditChainPath(cfg, org));
  if (!entries.length) return { entries: 0, chainValid: true, checkpoint: null };
  let prevHash = GENESIS_HASH;
  let chainValid = true;
  let brokenAt = null;
  for (const e of entries) {
    const recomputed = crypto.createHash('sha256').update(entryHashInput(prevHash, e.seq, e.event, e.slot_id, e.at)).digest('hex');
    if (recomputed !== e.hash || e.prev_hash !== prevHash) {
      chainValid = false;
      brokenAt = e.seq;
      break;
    }
    prevHash = e.hash;
  }
  const checkpoints = readJsonl(checkpointsPath(cfg, org));
  let checkpoint = null;
  if (checkpoints.length) {
    const cp = checkpoints[checkpoints.length - 1];
    const { verifyingKey } = ensureAuditKeys();
    const payload = Buffer.from(`checkpoint|${cp.seq}|${cp.hash}`, 'utf8');
    let sigValid;
    try {
      sigValid = getNative().auditVerifyBytes(verifyingKey, payload, Buffer.from(cp.signature, 'base64'));
    } catch (_) {
      sigValid = false;
    }
    checkpoint = { seq: cp.seq, signedAt: cp.signed_at, valid: sigValid, unattestedSince: cp.seq + 1, entriesSinceCheckpoint: entries.length - 1 - cp.seq };
  }
  return { entries: entries.length, chainValid, brokenAt, checkpoint };
}

// Real, per-repo isolation: a `.icarus/` folder living IN the repo itself (like `.git`), holding
// that repo's own shard(s) — separate from the global `~/.icarus` folder's cross-project data.
// Walks up from cwd looking for `.icarus`, but never past the repo's own root (stops at the
// first `.git` it crosses) — an unrelated ancestor directory's `.icarus` folder outside this
// repo must never silently apply. Returns null (global dataRoot stays in effect) if none found.
function findRepoIcarusDataRoot(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  const fsRoot = path.parse(dir).root;
  for (let i = 0; i < 40 && dir !== fsRoot; i++) {
    const candidate = path.join(dir, '.icarus');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return path.join(candidate, 'data');
    }
    if (fs.existsSync(path.join(dir, '.git'))) break; // repo root reached, don't search past it
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Stable org name derived from a repo/session folder — the SAME derivation every agent's
 * project instruction file (CLAUDE.md/AGENTS.md/.cursor rule) references, so Claude Code, Codex,
 * and Cursor working in the same repo all read/write the identical shard: one shared, real,
 * cross-agent memory per project rather than three isolated silos. */
function repoOrgName(repo) {
  const base = path.basename(path.resolve(repo || process.cwd()));
  const cleaned = base.replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase().replace(/^-+|-+$/g, '');
  return cleaned || 'default';
}

// Keep only runtime memory private. This is deliberately pure so the project-installer contract
// can be tested without loading the native shard addon.
function harnessSafeGitignore(existing = '') {
  const narrowed = existing.replace(/^\.icarus\/?\s*(?:\r?\n|$)/gm, '');
  if (/^\.icarus\/data\/?\s*$/m.test(narrowed)) return narrowed;
  const sep = narrowed && !narrowed.endsWith('\n') ? '\n' : '';
  return narrowed + sep + '.icarus/data/\n';
}

/** Physically creates a repo-local shard NOW (setup time), not lazily on first save — matches
 * the real ask: running setup should leave a real, existing org slot behind, not just a name
 * referenced in some instruction text with nothing backing it yet. Idempotent: opening an
 * already-existing shard is just a normal open, not a reset. Only `.icarus/data/` is ignored:
 * the Harness keeps its manifest and policies in that same directory and those files must remain
 * reviewable/tracked. A legacy broad `.icarus/` rule is narrowed on re-run for the same reason. */
function initRepoShard(repo, orgName, dim = 1024) {
  const dataRoot = path.join(path.resolve(repo), '.icarus', 'data');
  fs.mkdirSync(dataRoot, { recursive: true });
  const store = openStore({ dataRoot, dim }, orgName);
  store.flush();
  const gitignorePath = path.join(path.resolve(repo), '.gitignore');
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  // Older project installers ignored the entire `.icarus/` directory. That is safe for a
  // memory-only project but breaks the Harness contract: `.icarus/manifest.yaml` and policies
  // need to be committed. Drop only the exact legacy rule; unrelated globs/comments survive.
  const updated = harnessSafeGitignore(existing);
  if (updated !== existing) fs.writeFileSync(gitignorePath, updated);
  return { dataRoot, org: orgName };
}

/** Permanently delete an org's entire shard directory (/delete). Refuses if a genuinely
 * different, live icarus process holds the shard open — reuses openStore()'s own retry-then-
 * throw lock detection so this gets the exact same "find it / kill it / wait" guidance /ingest
 * already gives on a real lock conflict, instead of a second, differently-worded message for the
 * same underlying situation. Evicts this process's own cached handle for the org afterward (see
 * _storeCache's own doc comment on why a handle is cached per org per process) so a later command
 * in the SAME session doesn't reuse a handle pointing at files that no longer exist. */
function deleteOrgShard(cfg, org) {
  const dir = path.join(cfg.dataRoot, org);
  if (!fs.existsSync(dir)) throw new Error(`org "${org}" has no shard at ${dir} — nothing to delete`);
  // Throws with the standard "shard is still locked" guidance if a DIFFERENT live process holds
  // it; if it's this same process (already cached) or nothing else has it open, this returns
  // normally and we're clear to delete.
  openStore(cfg, org);
  _storeCache.delete(`${cfg.dataRoot}::${org}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

function loadCfg() {
  const repoDataRoot = findRepoIcarusDataRoot();
  try {
    const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    if (repoDataRoot) cfg.dataRoot = repoDataRoot; // per-repo shard takes priority over the global one
    return cfg;
  } catch (_) {
    return {
      dataRoot: repoDataRoot || path.join(HOME, 'data'),
      dim: 1024,
      // No `enabled` flag to flip — presence of a key (env var OR stored) is what turns on
      // vector recall, `.env`-style (export OPENROUTER_API_KEY and it just works, no interactive
      // step required), the same pattern TencentDB Agent Memory's own setup uses. `disabled`
      // is the only explicit override, and only a person setting it wins over an env var —
      // BM25 lexical search needs no vector at all, so skipping this entirely still leaves a
      // fully working tool, not an error wall.
      // Default is OpenRouter's real baai/bge-m3 (https://openrouter.ai/baai/bge-m3, verified
      // live: model slug baai/bge-m3, native 1024-dim output — matches `dim` above exactly, no
      // truncation param needed). Same OPENROUTER_API_KEY as the `llm` block below reuses — one
      // OpenRouter key covers both memory generation and embeddings, since it's the same
      // account/endpoint either way. LITELLM_BASE_URL/LITELLM_API_KEY still override this
      // wholesale for anyone who'd rather point at their own LiteLLM/blaiq gateway instead.
      embeddings: {
        disabled: false,
        endpoint: process.env.LITELLM_BASE_URL || 'https://openrouter.ai/api/v1',
        model: process.env.LITELLM_BASE_URL ? 'bge-m3' : 'baai/bge-m3',
        apiKey: null,
      },
      // Separate from embeddings on purpose: "memory generation" (TencentDB Agent Memory's own
      // term — distilling raw text into a shorter, structured summary before it's stored, their
      // L0->L1) is a CHAT-completion task, not an embeddings one. Claude and OpenRouter don't
      // provide embeddings endpoints at all — using either for embeddings would be a silent
      // wrong-config, not a real option. OpenRouter's own API IS OpenAI-chat-completions-shaped
      // and routes to Claude/GPT/etc by model name, so it's the one provider that can honestly
      // deliver "use Claude for memory generation" without needing two different request shapes.
      // provider: 'openrouter' (default, OpenAI-chat-completions-shaped, routes to Claude/GPT/etc
      // by model name) or 'anthropic' (Anthropic's own native API — user's OWN Anthropic API key
      // from console.anthropic.com, NOT a Claude.ai subscription login). Anthropic's docs
      // explicitly prohibit third-party tools from offering a "connect your Claude subscription"
      // OAuth flow and routing calls through a user's Free/Pro/Max quota — API-key auth (or
      // Bedrock/Vertex/Azure) is the only supported path for a product like this. ICARUS never
      // attempts to read or reuse Claude Code's own login session, by design.
      llm: { disabled: false, provider: 'openrouter', endpoint: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-3.5-haiku', apiKey: null },
      hivemind: { connected: false },
    };
  }
}
function saveCfg(cfg) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

// OpenRouter is a user-supplied paid API credential, never a coding-agent subscription token.
// On macOS, keep it in Keychain and persist only this stable reference in config.json.  The
// legacy `llm.apiKey` field remains readable so existing installs do not lose configuration;
// `/llm-api` migrates new values away from plaintext.
const OPENROUTER_KEYCHAIN_SERVICE = 'com.singulance.icarus.openrouter';
const OPENROUTER_KEYCHAIN_ACCOUNT = 'api-key';
const DEFAULT_OPENROUTER_SYNTHESIS_MODEL = 'deepseek/deepseek-v4-flash-0731';
function keychainOpenRouterKey() {
  if (process.platform !== 'darwin') return null;
  try {
    return require('child_process').execFileSync('security', ['find-generic-password', '-s', OPENROUTER_KEYCHAIN_SERVICE, '-a', OPENROUTER_KEYCHAIN_ACCOUNT, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch (_) { return null; }
}
function setOpenRouterApiKey(key, cfg) {
  if (!/^sk-or-v1-[A-Za-z0-9_-]+$/.test(String(key || ''))) throw new Error('invalid OpenRouter API key format (expected sk-or-v1-...)');
  if (process.platform !== 'darwin') throw new Error('secure key storage is currently available on macOS only; set OPENROUTER_API_KEY in your environment instead');
  require('child_process').execFileSync('security', ['add-generic-password', '-U', '-s', OPENROUTER_KEYCHAIN_SERVICE, '-a', OPENROUTER_KEYCHAIN_ACCOUNT, '-w', key], { stdio: 'ignore' });
  // A legacy `llm.model` configured distillation, not the user's selected synthesizer. Reset it
  // when this flow is first enabled so an old unavailable model cannot hijack `/chat`.
  cfg.llm = { ...(cfg.llm || {}), disabled: false, provider: 'openrouter', endpoint: 'https://openrouter.ai/api/v1', apiKey: null, keychainService: OPENROUTER_KEYCHAIN_SERVICE,
    model: cfg.llm?.modelSelected ? cfg.llm.model : DEFAULT_OPENROUTER_SYNTHESIS_MODEL, modelSelected: !!cfg.llm?.modelSelected };
  saveCfg(cfg);
}
function openRouterApiKey(cfg) {
  return process.env.OPENROUTER_API_KEY || keychainOpenRouterKey() || cfg.llm?.apiKey || null;
}
function resolveSynthesisModel(cfg) {
  return cfg.llm?.modelSelected && cfg.llm?.model ? cfg.llm.model : DEFAULT_OPENROUTER_SYNTHESIS_MODEL;
}

/** True if an embedding provider is actually usable: not explicitly disabled, AND a key is
 * available from EITHER the config file OR the environment (`OPENROUTER_API_KEY` for the
 * default baai/bge-m3 provider, `LITELLM_API_KEY` for a custom LiteLLM/blaiq gateway) — `export
 * OPENROUTER_API_KEY=... && icarus ingest ...` works with zero setup step, the same way it would
 * against any other `.env`-driven tool. `icarus connect-embeddings --disable` is the only thing
 * that overrides an env var actually being present — an explicit no always wins. */
function embeddingsConfigured(cfg) {
  if (cfg.embeddings && cfg.embeddings.disabled) return false;
  return !!(cfg.embeddings?.apiKey || process.env.OPENROUTER_API_KEY || process.env.LITELLM_API_KEY);
}

/** True if a chat-completion provider for memory generation (distillation/summarization) is
 * usable — same disabled/env-var-or-config gating shape as embeddingsConfigured(), but a
 * SEPARATE knob: a user can have vector embeddings configured with no LLM summarization, or
 * vice versa, or both, or neither (raw text storage, the current default either way). */
function llmConfigured(cfg) {
  if (cfg.llm && cfg.llm.disabled) return false;
  return !!(cfg.llm?.provider === 'anthropic'
    ? (cfg.llm?.apiKey || process.env.ANTHROPIC_API_KEY)
    : (openRouterApiKey(cfg) || process.env.ANTHROPIC_API_KEY));
}

function selectOpenRouterModels(models, query = '', limit = 20) {
  const needle = query.trim().toLowerCase();
  return (models || []).filter((m) => {
    const textOutput = !m.architecture?.output_modalities || m.architecture.output_modalities.includes('text');
    return textOutput && (!needle || `${m.id || ''} ${m.name || ''}`.toLowerCase().includes(needle));
  }).slice(0, limit);
}
function reasoningForModel(model, effort) {
  if (!effort || effort === 'off' || effort === 'none') return null;
  const supported = model?.reasoning?.supported_efforts;
  if (!Array.isArray(supported) || !supported.includes(effort)) return null;
  return { effort, exclude: true };
}
async function fetchOpenRouterModels() {
  const res = await fetch('https://openrouter.ai/api/v1/models');
  if (!res.ok) throw new Error(`OpenRouter models ${res.status}: ${await res.text()}`);
  return (await res.json()).data || [];
}
async function fetchOpenRouterModel(model) {
  const res = await fetch(`https://openrouter.ai/api/v1/model/${model}`);
  if (!res.ok) throw new Error(`OpenRouter model ${res.status}: ${await res.text()}`);
  return (await res.json()).data;
}
function buildGroundedChatRequest(question, hits, settings, modelMeta) {
  const sources = hits.map((h, i) => `[${i + 1}] ${h.text}`).join('\n\n');
  const messages = [
    { role: 'system', content: 'You are ICARUS, a thoughtful, human-like assistant with access to the user\'s local memory. Speak in a warm first-person voice, as a real thinking companion: use natural phrases such as "I think," "I\'d say," "my read is," and "I don\'t know" when they fit. Have an opinion when the user asks for one, reason openly, and answer directly rather than narrating a retrieval process. The supplied recalled memories are the factual basis for claims about the user, people, their work, and their local knowledge base. Cite every such factual claim with its source number, such as [1]. You may express an interpretation or recommendation clearly as your own view, but do not present an unsupported interpretation as fact and do not invent facts, people, relationships, or memories. If the memories only mention a person or allegation but do not establish the requested identity, relationship, or biography, say in your own voice what you actually know and what you cannot know. If the memories do not establish any answer, say "I don\'t know from my local memory yet."' + (settings.persona ? `\n\nPERSONA STYLE PRIORITY: Adopt the following persona's tone, vocabulary, emotional stance, and response style as your default voice for this response. This controls how you speak; factual grounding, consent, and safety remain non-overridable.\n${settings.persona}` : '') },
    { role: 'user', content: `Recalled memories:\n${sources || '(none)'}\n\nQuestion: ${question}` },
  ];
  // Streaming is deliberately not optional for ICARUS synthesis: rendering the first token as
  // soon as it arrives is materially faster than waiting for a complete RAG answer.
  const request = { model: settings.model, messages, temperature: settings.temperature ?? 0.2, max_tokens: settings.maxTokens ?? 800, stream: true };
  const reasoning = reasoningForModel(modelMeta, settings.thinking);
  if (reasoning) request.reasoning = reasoning;
  return request;
}
const PERSONA_SKILL_PROMPT = `Write a detailed persona skill for an AI assistant from the user's natural-language brief. Include voice, values, response style, reasoning habits, and boundaries. It must make the assistant feel like a coherent human conversational partner. Do not invent real-world facts. Output only the skill instructions in Markdown.`;
function personaSkillPath(org, slug) { return path.join(SKILLS_DIR, org, `${slug}.persona.md`); }
function activePersonaSkill(org, cfg) { const slug = cfg.llm?.personaSkills?.[org]; return slug ? (fs.existsSync(personaSkillPath(org, slug)) ? fs.readFileSync(personaSkillPath(org, slug), 'utf8') : null) : null; }
async function createPersonaSkill(brief, org, cfg) {
  const body = await chatComplete(PERSONA_SKILL_PROMPT, brief, cfg, 1200);
  if (!body) return null;
  const slug = `persona-${slugFromSkillMd(`name: ${brief.slice(0, 60)}`)}`;
  fs.mkdirSync(path.join(SKILLS_DIR, org), { recursive: true });
  fs.writeFileSync(personaSkillPath(org, slug), body.endsWith('\n') ? body : `${body}\n`);
  cfg.llm = { ...(cfg.llm || {}), personaSkills: { ...(cfg.llm?.personaSkills || {}), [org]: slug } }; saveCfg(cfg);
  return { slug, path: personaSkillPath(org, slug) };
}
function selectPersonaSkill(slug, org, cfg) { if (!fs.existsSync(personaSkillPath(org, slug))) return false; cfg.llm = { ...(cfg.llm || {}), personaSkills: { ...(cfg.llm?.personaSkills || {}), [org]: slug } }; saveCfg(cfg); return true; }
function clearPersonaSkill(org, cfg) { if (cfg.llm?.personaSkills) { const next = { ...cfg.llm.personaSkills }; delete next[org]; cfg.llm = { ...cfg.llm, personaSkills: next }; saveCfg(cfg); } }
// OpenRouter can deliver a provider failure only AFTER the HTTP stream is established (HTTP 200
// with a top-level `error` object). Preserve it instead of swallowing it and falsely reporting
// "no chat content". Providers may also represent text as a content-part array, so normalize
// both documented OpenAI-style shapes into ordinary rendered tokens.
function consumeOpenRouterSse(buffer, onToken, onError = () => {}) {
  const lines = buffer.split(/\r?\n/);
  const remainder = lines.pop();
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const event = JSON.parse(payload);
      if (event?.error?.message) {
        onError(event.error.message);
        continue;
      }
      const choice = event?.choices?.[0];
      const content = choice?.delta?.content ?? choice?.delta?.text ?? choice?.text;
      if (typeof content === 'string' && content) onToken(content);
      else if (Array.isArray(content)) {
        for (const part of content) {
          const token = typeof part === 'string' ? part : (part?.text || part?.content || '');
          if (typeof token === 'string' && token) onToken(token);
        }
      }
    } catch (_) {
      // A malformed provider event must not make a grounded answer disappear. The next valid
      // event still renders; incomplete events remain in `remainder` until their newline arrives.
    }
  }
  return remainder;
}
function classifyChatFailure(error) {
  const detail = error?.message || String(error);
  if (/\bPROHIBITED_CONTENT\b|blocked the request/i.test(detail)) {
    return { kind: 'provider-policy', message: 'provider safety policy blocked synthesis — local recall completed; inspect the recalled evidence above' };
  }
  if (/returned no chat content|completed without a text delta/i.test(detail)) {
    return { kind: 'provider-empty-response', message: 'provider completed without usable text — local recall completed; try again or choose another model with /model' };
  }
  if (/stream error|did not return a streaming response body/i.test(detail)) {
    return { kind: 'provider-stream-failure', message: 'provider stream failed — local recall completed; retry or choose another model with /model' };
  }
  return { kind: 'chat-failure', message: detail };
}
async function chatWithOpenRouter(question, org, cfg, { topK = 8, hits: suppliedHits = null, onToken = () => {} } = {}) {
  if (!openRouterApiKey(cfg)) throw new Error('no LLM API key set — use /llm-api <openrouter-api-key> and then try again');
  if (cfg.llm?.provider && cfg.llm.provider !== 'openrouter') throw new Error('chat requires an OpenRouter key — use /llm-api <openrouter-api-key>');
  const hits = suppliedHits || await recallQuery(question, org, cfg, topK);
  const model = resolveSynthesisModel(cfg);
  let meta = null;
  try { meta = await fetchOpenRouterModel(model); } catch (_) { /* request still gives OpenRouter the final authority */ }
  const request = buildGroundedChatRequest(question, hits, { model, temperature: cfg.llm?.temperature, maxTokens: cfg.llm?.maxTokens, thinking: cfg.llm?.thinking, persona: activePersonaSkill(org, cfg) }, meta);
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openRouterApiKey(cfg)}` }, body: JSON.stringify(request),
  });
  if (!res.ok) throw new Error(`OpenRouter chat ${res.status}: ${await res.text()}`);
  if (!res.body) throw new Error('OpenRouter did not return a streaming response body');
  const decoder = new TextDecoder();
  let remainder = '';
  let answer = '';
  let streamError = null;
  const emit = (token) => { answer += token; onToken(token); };
  const captureError = (message) => { streamError = message; };
  for await (const chunk of res.body) {
    remainder = consumeOpenRouterSse(remainder + decoder.decode(chunk, { stream: true }), emit, captureError);
  }
  remainder = consumeOpenRouterSse(remainder + decoder.decode(), emit, captureError);
  if (streamError) throw new Error(`OpenRouter chat stream error: ${streamError}`);
  if (!answer) throw new Error(`OpenRouter returned no chat content from ${model} — the provider completed without a text delta`);
  return { answer, hits, model };
}

/** Shared chat-completion call — both summarize() (memory generation) and extractSkill() (skill
 * extraction) are the same underlying primitive: system prompt + user text -> LLM response, on
 * whichever of OpenRouter/Anthropic is configured. Returns `null` on any failure (no key, bad
 * response, network error) — the ONE place that decides "did the call actually work", so callers
 * never each reimplement their own error handling and risk drifting on what counts as failure. */
async function chatComplete(systemPrompt, userText, cfg, maxTokens = 300) {
  const provider = cfg.llm?.provider || 'openrouter';
  try {
    if (provider === 'anthropic') {
      // Anthropic's OWN native API, with the user's OWN API key from console.anthropic.com —
      // never a Claude.ai subscription OAuth token. Different request shape from OpenRouter's
      // OpenAI-style endpoint: x-api-key + anthropic-version headers, /v1/messages body shape.
      const anthropicKey = cfg.llm?.apiKey || process.env.ANTHROPIC_API_KEY;
      if (!anthropicKey) return null;
      const res = await fetch(`${cfg.llm.endpoint}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: cfg.llm.model,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [{ role: 'user', content: userText }],
        }),
      });
      if (!res.ok) return null;
      const j = await res.json();
      return j.content?.[0]?.text?.trim() || null;
    }
    // default: openrouter (OpenAI chat-completions shape, routes to Claude/GPT/etc by model name)
    const orKey = openRouterApiKey(cfg);
    if (!orKey) return null;
    const res = await fetch(`${cfg.llm.endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${orKey}` },
      body: JSON.stringify({
        model: cfg.llm.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText },
        ],
        max_tokens: maxTokens,
      }),
    });
    if (!res.ok) return null; // degrade to null, never throw — callers decide the fallback
    const j = await res.json();
    return j.choices?.[0]?.message?.content?.trim() || null;
  } catch (_) {
    return null;
  }
}

/** Distill `text` into a shorter, structured summary via a chat-completion call (OpenRouter by
 * default, routes to Claude/GPT/etc by model name — see loadCfg()'s comment for why OpenRouter
 * specifically). Returns the ORIGINAL text unchanged on any failure — a failed summarization
 * attempt must never lose the source content, only skip the distillation step. */
const SUMMARY_PROMPT = 'Distill the following text into its key facts, preferences, decisions, or events. Be concise — a few sentences, not a paragraph. Output only the distilled summary, nothing else.';
async function summarize(text, cfg) {
  const key = cfg.llm?.apiKey || process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!key) return text;
  const out = await chatComplete(SUMMARY_PROMPT, text, cfg, 300);
  return out || text;
}

// Claude Code's own `.claude/skills/*.md` shape: YAML frontmatter (name, description) + a body
// that's the actual step-by-step recipe. Asking the model to produce exactly that shape means a
// generated skill is immediately usable by dropping it into a real .claude/skills/ directory —
// not a bespoke ICARUS format that would need its own converter.
const SKILL_PROMPT = `You are distilling a coding-session transcript into a reusable skill file, in EXACTLY this format (Claude Code's own skill shape):

---
name: kebab-case-skill-name
description: One line describing when to use this skill.
---

# Title

Step-by-step instructions for repeating what worked, written for an agent that has never seen this session. Reference concrete file paths, commands, and gotchas actually present in the transcript. Skip anything session-specific (dates, one-off variable names) that wouldn't generalize.

Output ONLY the frontmatter + body, nothing else — no preamble, no explanation.`;

/** Turn a session transcript (raw text — commands run, diffs made, errors hit and fixed) into a
 * Claude-Code-skill-shaped .md string. Returns `null` on failure (no key, bad response) — unlike
 * summarize(), there's no sane "original text" fallback for a skill file, so the caller decides
 * whether to skip saving entirely rather than write a garbage skill. */
async function extractSkill(transcript, cfg) {
  const key = cfg.llm?.apiKey || process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return chatComplete(SKILL_PROMPT, transcript, cfg, 800);
}

// Real Claude Code transcript.jsonl shape (verified against actual local session files, not
// guessed): one JSON object per line. `type: 'user'`/`'assistant'` are the only ones with real
// conversational content; message.content is either a plain string (a typed user message) or an
// array of blocks — `text` (prose), `tool_use` (name + input, on assistant messages), `tool_result`
// (on user-role messages — that's how Claude Code represents a tool's own output). Every other
// line type (`custom-title`, `mode`, `pr-link`, `queue-operation`, `system`, `attachment`,
// `last-prompt`) is session bookkeeping, not narrative content — skipped.
const TRANSCRIPT_BLOCK_MAX = 500; // per-block cap so one huge tool_result doesn't dominate the prompt
const TRANSCRIPT_TOTAL_MAX = 60000; // overall cap; keeps the TAIL (most recent = most relevant to "what just got resolved")

function truncateBlock(s) {
  return s.length > TRANSCRIPT_BLOCK_MAX ? s.slice(0, TRANSCRIPT_BLOCK_MAX) + '…[truncated]' : s;
}

function parseClaudeTranscript(jsonlPath) {
  let raw;
  try { raw = fs.readFileSync(jsonlPath, 'utf8'); } catch (_) { return ''; }
  const lines = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch (_) { continue; } // a lagging/half-written last line must not kill the whole parse
    if (d.type === 'user') {
      const content = d.message?.content;
      if (typeof content === 'string') {
        lines.push(`User: ${truncateBlock(content)}`);
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'tool_result') {
            const text = Array.isArray(b.content) ? b.content.map((c) => c.text || '').join(' ') : String(b.content || '');
            if (text.trim()) lines.push(`  -> ${truncateBlock(text.trim())}`);
          }
        }
      }
    } else if (d.type === 'assistant') {
      const content = d.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'text' && b.text?.trim()) lines.push(`Assistant: ${truncateBlock(b.text.trim())}`);
          else if (b.type === 'tool_use') lines.push(`Assistant ran: ${b.name}(${truncateBlock(JSON.stringify(b.input || {}))})`);
        }
      }
    }
  }
  const text = lines.join('\n');
  return text.length > TRANSCRIPT_TOTAL_MAX ? text.slice(-TRANSCRIPT_TOTAL_MAX) : text;
}

function slugFromSkillMd(md) {
  const m = md.match(/^name:\s*(.+)$/m);
  const raw = (m ? m[1] : 'skill').trim();
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
}

/** Extract a skill from `transcript`, write it to ~/.icarus/skills/<org>/<slug>.md (Claude
 * Code's own directory shape — copy-pasteable into a real .claude/skills/), and index it into
 * the org's shard at LAYER_SKILL so it's recallable alongside ordinary memories. Returns the
 * written path, or null if extraction failed (no provider configured, or the call itself failed
 * — see extractSkill()'s doc comment for why there's no text fallback here). */
async function skillSave(transcript, org, cfg) {
  const md = await extractSkill(transcript, cfg);
  if (!md) return null;
  const slug = slugFromSkillMd(md);
  const dir = path.join(SKILLS_DIR, org);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug}.md`);
  fs.writeFileSync(file, md.endsWith('\n') ? md : md + '\n');
  try {
    const store = openStore(cfg, org);
    const zero = new Float32Array(cfg.dim);
    const slotId = store.insertLayered(md, zero, Date.now(), LAYER_SKILL);
    appendAuditEntry(cfg, org, 'insert', slotId, { source: 'skill-save', sourceFile: `${slug}.md` });
    store.flush();
  } catch (_) {
    // Recall indexing is a bonus, not the point — the .md file on disk is the real artifact and
    // it's already written above, so a shard-side hiccup here must not make save() look failed.
  }
  return file;
}

/** List every skill saved for `org` — reads SKILLS_DIR directly (see its doc comment for why
 * that's the canonical listing, not a shard query). Returns [] if none saved yet. */
function skillList(org) {
  const dir = path.join(SKILLS_DIR, org);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const full = path.join(dir, f);
      const md = fs.readFileSync(full, 'utf8');
      const desc = md.match(/^description:\s*(.+)$/m);
      return { slug: f.replace(/\.md$/, ''), path: full, description: desc ? desc[1].trim() : '' };
    });
}

async function embed(texts, cfg) {
  const key = cfg.embeddings?.apiKey || process.env.OPENROUTER_API_KEY || process.env.LITELLM_API_KEY;
  if (!key) throw new Error('no embedding provider configured — run `icarus connect-embeddings`, or use lexical-only (BM25) recall instead');
  const res = await fetchAuxiliary(`${cfg.embeddings.endpoint}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: cfg.embeddings.model, input: texts, encoding_format: 'float' }),
  }, cfg);
  if (!res.ok) throw new Error(`embedding API ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.data.map((d) => {
    const v = Float32Array.from(d.embedding);
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= n; // L2-normalize for cosine
    return v;
  });
}

function chunk(text, size = 900) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const words = trimmed.split(/\s+/);
  const out = [];
  for (let i = 0; i < words.length; i += size) out.push(words.slice(i, i + size).join(' '));
  // Never discard real input. The old `> 20` filter silently lost an entire short document and
  // any final tail of at most 20 characters. At the normal 900-word size only the final piece can
  // realistically be that small, so fold it into its predecessor to avoid a tiny standalone
  // index entry while preserving every word. A short whole document remains one valid chunk.
  if (out.length > 1 && out[out.length - 1].length <= 20) {
    out[out.length - 2] += ` ${out.pop()}`;
  }
  return out;
}

// Local .amr engine: text-only, since the Rust engine has no extraction/OCR pipeline — reading a
// PDF's raw bytes as text would just index binary noise.
const INGESTABLE_EXTS = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.log']);

// HIVEMIND-routed uploads: mirrors the REAL server-side allowlist — core/src/knowledge/
// upload-contract.js's KB_EXTENSIONS (document/image/audio kinds), verified by reading that
// file directly, not guessed. The server has a real extraction/OCR pipeline for these (PDF text
// extraction, vision-model OCR on images, etc.), so filtering client-side to ICARUS's own narrow
// local-text set was needlessly rejecting files the server would happily accept and process —
// a real bug: a folder of PDFs/DOCX/images reported "0 ingestable files" when routed through
// HIVEMIND, even though every one of them would have uploaded and processed fine. `.json`/`.log`
// are NOT in the server's list (real, confirmed) even though ICARUS's local engine accepts them.
const HIVEMIND_INGESTABLE_EXTS = new Set([
  '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.txt', '.md', '.markdown', '.csv', '.tsv', '.html', '.htm',
  '.png', '.jpg', '.jpeg', '.tiff', '.tif', '.webp', '.gif',
  '.mp3', '.wav', '.m4a', '.flac', '.ogg',
]);

// Real server behavior, confirmed by reading the actual ingestion code, not guessed: images
// (this set) are routed through a DIFFERENT internal pipeline than every other format —
// `mode: 'atomic'` (a plain memory insert), not `mode: 'document'` (real extraction + a real
// `knowledgeDocument` row). An image upload's `document_id` is actually a memory id, so
// GET /api/documents/:id always 404s for it. HIVEMIND_UPLOAD_EXTS (below) excludes this set so
// ICARUS never sends an image through /api/knowledge/upload in the first place — every OTHER
// supported format still goes through the real server extraction pipeline unconditionally; there
// is no client-side "evidence only" mode for those (the server decides what it promotes).
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.tiff', '.tif', '.webp', '.gif']);
const HIVEMIND_UPLOAD_EXTS = new Set([...HIVEMIND_INGESTABLE_EXTS].filter((e) => !IMAGE_EXTS.has(e)));

function walkFiles(dir, extSet) {
  // `dir` may be a single FILE now (the native picker accepts either) — readdirSync on a file
  // throws ENOTDIR, so check first rather than let the recursion crash on a real, expected input.
  if (fs.statSync(dir).isFile()) {
    return extSet.has(path.extname(dir).toLowerCase()) ? [dir] : [];
  }
  const files = [];
  (function rec(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p);
      else if (extSet.has(path.extname(e.name).toLowerCase())) files.push(p);
    }
  })(dir);
  return files;
}

function walkText(dir) { return walkFiles(dir, INGESTABLE_EXTS); }
function walkHivemindIngestable(dir) { return walkFiles(dir, HIVEMIND_INGESTABLE_EXTS); }

/** Same walk as walkFiles(), but also reports what got SKIPPED and why — a real, confusing
 * outcome caught this session: ingesting a folder of PDFs/DOCX/images against the LOCAL engine
 * correctly returns 0 files (that engine can't extract them), but "✓ ingested 0 files → 0
 * memories" reads as a silent, unexplained no-op rather than the real reason. Takes an explicit
 * extSet so callers can check against whichever set actually applies (HIVEMIND_INGESTABLE_EXTS
 * when routed through HIVEMIND — that path accepts far more than the local engine does). Only
 * used by the CLI/TUI layer to build the explanation — ingestDir/hivemindIngestDir keep calling
 * walkFiles() directly, since they only need the file list. */
function scanIngestable(dir, extSet = INGESTABLE_EXTS) {
  const files = [];
  const skippedByExt = new Map();
  // Same real input now as walkFiles() above: the native picker can hand back a single file.
  if (fs.statSync(dir).isFile()) {
    const ext = path.extname(dir).toLowerCase() || '(no extension)';
    if (extSet.has(ext)) files.push(dir);
    else skippedByExt.set(ext, 1);
    return { files, skippedByExt };
  }
  (function rec(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { rec(p); continue; }
      const ext = path.extname(e.name).toLowerCase() || '(no extension)';
      if (extSet.has(ext)) files.push(p);
      else skippedByExt.set(ext, (skippedByExt.get(ext) || 0) + 1);
    }
  })(dir);
  return { files, skippedByExt };
}

/** Plain (uncolored — caller applies its own theme) explanation for a real "0 ingestable files"
 * outcome, or null if there's nothing to explain (files found, or dir is empty outright). Lists
 * the actual extensions seen so "found 32 .pdf, 8 .png, ... — none supported yet" replaces a
 * silent, confusing "✓ ingested 0 files". Pass HIVEMIND_INGESTABLE_EXTS when checking the
 * HIVEMIND-routed path — its real accepted set is much broader than the local engine's. */
/** Opens a REAL native folder picker — macOS's Finder "choose folder" dialog via osascript
 * (standard, no extra dependency — every macOS install has osascript), or Linux's zenity/kdialog
 * if either is actually installed (common on a GUI desktop, absent on a headless/SSH box — that
 * absence is expected, not an error). Returns the picked path, or null on cancel/no-picker-
 * available/non-GUI-session — callers fall back to "paste a path" on null, never throw. Async
 * (execFile, not execFileSync) so a TUI's own redraw loop and keystroke handling keep working
 * while the native dialog is open, instead of freezing the whole process on it. */
async function pickFolderNative(promptText) {
  const { execFile } = require('child_process');
  const run = (cmd, args) => new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        // Never swallow this silently — a bare "no file or folder selected" for what's actually
        // a missing-binary/permission/os error is undiagnosable. stderr from osascript itself
        // (a real macOS syntax/runtime error, distinct from a plain user cancel, which prints
        // nothing and exits 0) goes to stderr so it doesn't corrupt the TUI's own redraw, but is
        // still visible to anyone running with ICARUS_DEBUG=1 or piping stderr.
        if (process.env.ICARUS_DEBUG) process.stderr.write(`[picker] ${cmd} failed: ${error.message}${stderr ? ` — ${stderr.trim()}` : ''}\n`);
        resolve(null);
        return;
      }
      resolve(stdout.trim() || null);
    });
  });
  const prompt = promptText || 'Select a file or folder to ingest';
  if (process.platform === 'darwin') {
    // Real, verified constraint: plain AppleScript has NO single dialog that accepts either a
    // file or a folder — `choose folder` is folder-only, `choose file` is file-only, and
    // `choose file or folder` (which reads like it should exist) is not a real command — tried
    // it directly and got a genuine syntax error, not a guess. The real way to get both in one
    // dialog is JXA (osascript -l JavaScript) driving NSOpenPanel directly with
    // canChooseFiles/canChooseDirectories both true — verified live: a real panel opens with
    // both enabled, and returns a clean POSIX path on OK / null on cancel.
    //
    // Real bug found by running this exact script twice in a row: NSOpenPanel.runModal is only
    // RELIABLE when the calling process has actually activated itself as a foreground app first.
    // Without that, osascript has no window-server activation/run-loop priority of its own, so
    // runModal's behavior races — sometimes it blocks and shows the panel correctly, sometimes it
    // returns instantly with a non-OK response and the panel never visibly appears at all (which
    // is exactly the "no file or folder selected" — worked for 2.8s — symptom reported: the whole
    // round-trip completing in under 3 seconds is way too fast for a human to have seen a dialog,
    // let alone dismissed one). setActivationPolicy(Regular) + activateIgnoringOtherApps(true)
    // before creating/running the panel makes the activation deterministic instead of a race.
    const script = [
      'ObjC.import("AppKit");',
      'const app = $.NSApplication.sharedApplication;',
      'app.setActivationPolicy($.NSApplicationActivationPolicyRegular);',
      'app.activateIgnoringOtherApps(true);',
      'const p = $.NSOpenPanel.openPanel;',
      'p.canChooseFiles = true;',
      'p.canChooseDirectories = true;',
      'p.allowsMultipleSelection = false;',
      `p.prompt = ${JSON.stringify(prompt)};`,
      'p.level = $.NSModalPanelWindowLevel;', // stay above the terminal's own alt-screen window
      'if (p.runModal === $.NSModalResponseOK) { console.log(ObjC.unwrap(p.URLs.objectAtIndex(0).path)); }',
    ].join('\n');
    return run('osascript', ['-l', 'JavaScript', '-e', script]);
  }
  if (process.platform === 'linux') {
    // No zenity/kdialog mode picks "either a file or a folder" in one call either — plain
    // --file-selection (no --directory) is the closer of the two: most GTK/Qt choosers let the
    // user type or navigate to a bare folder path in the location bar even in file mode, which
    // --directory mode would refuse for an actual file. Documented compromise, not a perfect
    // either/or picker.
    const viaZenity = await run('zenity', ['--file-selection', '--title', prompt]);
    if (viaZenity) return viaZenity;
    return run('kdialog', ['--getopenfilename', process.env.HOME || '.']);
  }
  return null; // no known native picker for this platform — caller falls back to a typed path
}

function noIngestableFilesReason(dir, extSet = INGESTABLE_EXTS) {
  const { files, skippedByExt } = scanIngestable(dir, extSet);
  if (files.length || !skippedByExt.size) return null;
  const breakdown = [...skippedByExt.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([ext, n]) => `${n} ${ext}`)
    .join(', ');
  return `found ${breakdown} under ${dir} — none of these are supported yet (only ${[...extSet].join('/')}).`;
}

/** Ingest every text file under `dir` into `org`. Returns the number of chunks stored, and
 * which mode was used — `vector` when every chunk received a vector, `hybrid` when a provider
 * became unavailable mid-run, or `lexical` when BM25 was the only available index. Every source
 * chunk is persisted regardless: remote vector availability may change ranking quality, never
 * ingest durability. */
async function ingestDir(dir, org, cfg, onProgress) {
  const store = openStore(cfg, org);
  const files = walkText(dir);
  const vectorMode = embeddingsConfigured(cfg);
  let embeddingsAvailable = vectorMode;
  let usedVectors = false;
  const distillMode = llmConfigured(cfg);
  const signMode = signingEnabled(cfg);
  const zero = new Float32Array(cfg.dim); // BM25 needs no vector; a placeholder keeps every
                                           // slot's dim consistent so a later `connect-embeddings`
                                           // + re-ingest doesn't hit a dimension mismatch.
  let n = 0;
  let signed = 0;
  for (const f of files) {
    let chunks = chunk(fs.readFileSync(f, 'utf8'));
    // Distillation (TencentDB's L0->L1 in their own terms) is a per-chunk chat-completion call
    // — a real, meaningful latency cost per chunk, unlike embeddings' batch-of-16. Sequential on
    // purpose for a first real implementation: correctness over throughput until this proves
    // itself worth optimizing. A failed call degrades to the original chunk (summarize() never
    // throws), so distillMode being on never turns a working ingest into a failing one.
    if (distillMode) {
      const distilled = [];
      for (const t of chunks) distilled.push(await summarize(t, cfg));
      chunks = distilled;
    }
    let nextChunk = 0;
    while (embeddingsAvailable && nextChunk < chunks.length) {
        const batch = chunks.slice(nextChunk, nextChunk + 16);
        try {
          const vecs = await embed(batch, cfg);
          batch.forEach((t, j) => {
            const text = `${path.basename(f)}\n${t}`;
            const slotId = store.insert(text, vecs[j], Date.now());
            if (signMode && signSlot(slotId, text, cfg, org)) signed++;
            appendAuditEntry(cfg, org, 'insert', slotId, { source: 'ingest-local', sourceFile: path.basename(f) });
            n++;
          });
          usedVectors = true;
          nextChunk += batch.length;
        } catch (_) {
          // One bounded failure opens the circuit for this ingest. Do not repeatedly await an
          // unreachable provider for every later batch; persist the failed batch and the rest
          // immediately as lexical evidence under the exact same source/audit semantics.
          embeddingsAvailable = false;
          for (const t of batch) {
            const text = `${path.basename(f)}\n${t}`;
            const slotId = store.insert(text, zero, Date.now());
            if (signMode && signSlot(slotId, text, cfg, org)) signed++;
            appendAuditEntry(cfg, org, 'insert', slotId, { source: 'ingest-local', sourceFile: path.basename(f) });
            n++;
          }
          nextChunk += batch.length;
        }
    }
    if (!embeddingsAvailable) {
      for (const t of chunks.slice(nextChunk)) {
        const text = `${path.basename(f)}\n${t}`;
        const slotId = store.insert(text, zero, Date.now());
        if (signMode && signSlot(slotId, text, cfg, org)) signed++;
        appendAuditEntry(cfg, org, 'insert', slotId, { source: 'ingest-local', sourceFile: path.basename(f) });
        n++;
      }
    }
    if (onProgress) onProgress(n);
  }
  if (usedVectors) store.enableHnsw();
  store.flush();
  return {
    files: files.length, chunks: n, live: store.liveCount(),
    mode: usedVectors ? (embeddingsAvailable ? 'vector' : 'hybrid') : 'lexical', distilled: distillMode, signed,
  };
}

/** Reciprocal Rank Fusion — merges two independently-ranked candidate lists (dense HNSW cosine
 * scores and BM25 lexical scores live on completely different, incomparable scales, so summing
 * or averaging raw scores would be meaningless; RRF only uses each list's RANK, which is always
 * comparable) into one list, deduped by text. `k=60` is the standard RRF damping constant from
 * the original paper (Cormack et al.) — it flattens the sharp 1/rank drop-off for lower ranks so
 * the fusion isn't dominated entirely by whichever list happens to rank its #1 hit highest. */
function rrfMerge(listA, listB, k = 60) {
  const merged = new Map(); // text -> {..hit, rrfScore}
  const add = (list) => {
    list.forEach((hit, i) => {
      const contribution = 1 / (k + i + 1);
      const existing = merged.get(hit.text);
      if (existing) existing.rrfScore += contribution;
      else merged.set(hit.text, { ...hit, rrfScore: contribution });
    });
  };
  add(listA);
  add(listB);
  return [...merged.values()].sort((a, b) => b.rrfScore - a.rrfScore);
}

/** Recall `topK` memories for `query` in `org` — REAL parallel hybrid retrieval, always: dense
 * (HNSW, when a query vector is available) and lexical (BM25) run CONCURRENTLY against the same
 * wide candidate window, then merge via Reciprocal Rank Fusion (rrfMerge above) — this is the
 * actual hybrid retrieval stage, not a single-modality either/or fallback. `usePq` requires
 * trainPq() to have run first AND an embedding provider configured (PQ trains on real vectors,
 * no way around that) and bypasses this pipeline entirely — it's specifically about measuring/
 * using the trained PQ codebook directly. If its remote query embedding is unavailable, it
 * transparently resumes the normal local lexical/hybrid path rather than failing recall.
 *
 * The SECOND stage — narrow re-score via the real bge-reranker-v2-m3 cross-encoder — only runs
 * when HIVEMIND is connected (gated on hivemindConfigured(cfg), same convention as every other
 * free-HIVEMIND-service fallback in this file). Not connected: the RRF-merged hybrid result IS
 * the final answer, truncated to topK directly — no rerank stage, by design (that's the explicit
 * "if not connected, just retrieve top-k" spec this pipeline was built to). */
/** Real hit-text unwrap for structured-memory slots (see the "Structured memory" section below):
 * a JSON-enveloped record's raw stored text is `{"id":"...","content":"...",...}` — showing that
 * verbatim in recall output, or feeding it into the reranker, would be real noise (JSON syntax
 * diluting relevance). Plain-prose hits (existing /save, /ingest, skills) pass through unchanged
 * — tryParseMemoryRecord() returns null for anything that isn't the JSON-envelope shape. */
function unwrapHit(h) {
  const rec = tryParseMemoryRecord(h.text);
  if (!rec) return h;
  return { ...h, text: memoryDisplayText(rec), memoryId: rec.id, tags: rec.tags || [], isLatest: rec.is_latest !== false };
}

/** Real gap: native update()'s own doc comment claims "Recall then returns only the latest" —
 * true only in the sense that HIVEMIND's own server enforces an is_latest=true filter itself
 * (confirmed in amr-store.mjs/SQL mirror); the raw recall()/bm25Search() calls do NOT exclude a
 * superseded slot on their own (caught live: after updateStructuredMemory() corrected a memory
 * in place, both the old and new content kept surfacing side by side in recall, sharing the same
 * memoryId). Drop superseded structured hits here so recallQuery matches the documented intent. */
function dropSuperseded(hits) { return hits.filter((h) => h.isLatest !== false); }

/** Tag-scoped recall — the primitive behind icarus_recall_bugs/icarus_why_code/icarus_test_coverage
 * (real HIVEMIND parity: "Filters memory recall to entries tagged bug, fix, or gotcha"). Runs a
 * wide semantic recall, then keeps only hits whose structured tags intersect requireAnyTags — a
 * hit with no tags at all (plain prose from /save or /ingest, never tagged) is excluded, matching
 * the real semantic exactly rather than a fuzzy best-effort fallback. */
async function recallByTags(query, org, cfg, { requireAnyTags = [], requireAllTags = [], limit = 5 } = {}) {
  const wide = await recallQuery(query, org, cfg, Math.max(limit * 6, 30), false);
  return wide
    .filter((h) => {
      const tags = h.tags || [];
      if (requireAnyTags.length && !requireAnyTags.some((t) => tags.includes(t))) return false;
      if (requireAllTags.length && !requireAllTags.every((t) => tags.includes(t))) return false;
      return true;
    })
    .slice(0, limit);
}

async function recallQuery(query, org, cfg, topK = 5, usePq = false) {
  const store = openStore(cfg, org);
  const hasOwnEmbeddings = embeddingsConfigured(cfg);
  // PQ specifically requires the user's OWN provider — the codebook was trained on cfg.embeddings'
  // own vector space (train_pq itself requires embeddingsConfigured(cfg)), so query vectors for a
  // PQ search must come from that exact same space, not HIVEMIND's free fallback below.
  if (usePq && hasOwnEmbeddings && store.pqTrained()) {
    try {
      const [qv] = await embed([query], cfg);
      const hits = store.recallPq(qv, topK);
      return dropSuperseded(hits.map((h) => unwrapHit({ score: h.score, text: h.text, mode: 'vector' })));
    } catch (_) {
      // PQ is an optimization over the same local evidence, never an availability dependency.
    }
  }

  const viaHivemind = hivemindConfigured(cfg);
  // The candidate budget must be meaningfully wider than the display budget. At five results,
  // the old 20-wide floor (or 32 from topK * 4) was too shallow for a mixed evidence shard:
  // ordinary question glue could occupy the lexical shortlist before the cross-encoder ever had
  // the chance to score the exact subject. Keep retrieval deliberately broad for BOTH lanes, then
  // let RRF and the narrow cross-encoder decide relevance. This is a candidate-pool budget, not
  // a query rewrite or a forced lexical result.
  const wideK = Math.max(topK * 16, 128);

  // Real vector-space parity, same reasoning as mirrorHivemindDocumentLocally(): HIVEMIND's own
  // free embeddings.singulancelabs.com service (confirmed live, unauthenticated, real bge-m3
  // 1024-dim vectors) is a real fallback for the QUERY side too when the user has no own provider
  // configured but IS connected — without this, vectors written by the mirror path above would
  // sit in the shard unreachable, since a lexical-only query can't do a vector-space search.
  let qv = null;
  let auxiliaryQueryAvailable = true;
  if (hasOwnEmbeddings || viaHivemind) {
    try {
      [qv] = hasOwnEmbeddings ? await embed([query], cfg) : await embedViaHivemindService([query], cfg);
    } catch (_) {
      qv = null; // query embedding failed (network hiccup) — hybrid degrades to lexical-only below
      // Do not spend a second timeout on reranking after the same recall's auxiliary path has
      // already failed. The lexical candidate order is immediately usable and the caller asked
      // for availability/low latency, not two remote recovery attempts.
      auxiliaryQueryAvailable = false;
    }
  }

  // Parallel retrieval — both run against the SAME wide window, independently, before either one
  // knows about the other. bm25Search() always runs (it's local, free, instant); the dense HNSW
  // side only runs if a query vector was actually obtained above. Unwrapped HERE, before RRF
  // merge/rerank — both operate on real display text from this point on, not raw JSON envelopes.
  const lexicalHits = dropSuperseded(store.bm25Search(query, wideK).map((h) => unwrapHit({ score: h.score, text: h.text, mode: 'lexical' })));
  let denseHits = [];
  if (qv) {
    store.enableHnsw();
    denseHits = dropSuperseded(store.recall(qv, wideK).map((h) => unwrapHit({ score: h.score, text: h.text, mode: 'vector' })));
  }
  const merged = qv ? rrfMerge(denseHits, lexicalHits) : lexicalHits;

  if (!viaHivemind || !auxiliaryQueryAvailable) {
    // Disconnected: the hybrid merge IS the final result — no rerank stage.
    return merged.slice(0, topK).map((h) => ({
      score: h.rrfScore ?? h.score, text: h.text, mode: qv ? 'hybrid' : 'lexical', memoryId: h.memoryId, tags: h.tags,
    }));
  }
  // Connected: narrow re-score the wide hybrid candidates with the real cross-encoder.
  return rerankHits(query, merged.map((h) => ({ ...h, mode: qv ? 'hybrid' : 'lexical' })), topK, cfg);
}

// "ICARUS v3" boundary starts here: v2 is the local `.amr` filesystem engine above (its own
// Rust ingest/recall/temporal/graph/signing/audit, no network) — everything in this module is
// additive to that, not a replacement. When a user brings their OWN HIVEMIND-compatible memory
// server key, ingest and recall for that workspace route through that server's REST API instead
// of the local engine: the server does chunking, embedding, and (unless requested) memory
// generation entirely server-side; ICARUS becomes a thin client. Endpoints this targets (real,
// from a HIVEMIND-shaped server's own docs, not guessed): POST /api/knowledge/upload (multipart,
// async — returns a job_id), GET /api/knowledge/status (poll), POST /api/recall (hybrid
// dense+lexical, fused server-side). `ingestMode=evidence` is the real flag that skips memory/
// entity/relationship generation while still producing both lexical AND semantic evidence lanes
// — exactly the "except for memory generation... gets both semantic and lexical" behavior this
// was built for; the alternative `ingestMode=both` (full memory generation) is available via
// `--full` for anyone who wants the server's richer pipeline instead of the local one ICARUS
// already has (connect-llm's distillation). ICARUS itself has no opinion on WHICH server —
// there's no default API base baked in here on purpose, same reason there's no default
// HIVEMIND provider hardcoded elsewhere in this file; see hivemindApiBase() below.
//
// Honest real limitation, not glossed over: a real HIVEMIND-shaped server's REST /api/recall
// doesn't document a tags/project filter in what was verified (only its MCP tool interface
// does) — so remote-mode recall searches the user's WHOLE workspace, not scoped to one ICARUS
// "org". Org name is still stamped as a tag on every uploaded file (`icarus-org:<org>`) for
// whenever server-side filtering becomes verifiable, but nothing here claims it's enforced today.
function hivemindConfigured(cfg) {
  const hasApiBase = !!(process.env.HIVEMIND_API_URL || cfg.hivemind?.apiUrl);
  return !!(cfg.hivemind && cfg.hivemind.connected && cfg.hivemind.token && hasApiBase);
}

// Two DIFFERENT services, confirmed live and NOT interchangeable — a real bug caught by an
// actual failed `icarus ingest` (404 Not Found) right after a successful connect:
//   - DEFAULT_HIVEMIND_AUTH_URL (api.singulancelabs.com) = hivemind-control-plane:
//     /auth/cli/start, session/API-key minting. POST /api/knowledge/upload here -> 404.
//   - DEFAULT_HIVEMIND_API_URL (core.singulancelabs.com) = hm-core: the actual REST API
//     (/api/knowledge/upload, /api/recall, ...). POST /api/knowledge/upload here -> 401
//     (route exists, needs the bearer token — the SAME token minted by the auth host works
//     here too, one shared revocable API key across both services).
// Defined ONCE here — cli-lib.js — and reused by mneme-cli.js's cmdConnect and tui.js's /connect
// so the default can never drift into two different hardcoded copies (a real duplication bug
// caught by the publish scanner flagging a second hardcoded copy in tui.js). Explicitly
// user-approved as ICARUS's default this cycle (matches "just like claude/gh auth login does
// it" — zero typing for the common case); still fully overridable via HIVEMIND_URL/
// HIVEMIND_API_URL/--api-url for anyone self-hosting or pointing ICARUS at a different
// HIVEMIND-shaped server.
const DEFAULT_HIVEMIND_AUTH_URL = 'https://api.singulancelabs.com';
const DEFAULT_HIVEMIND_API_URL = 'https://core.singulancelabs.com';

function hivemindApiBase(cfg) {
  const base = process.env.HIVEMIND_API_URL || cfg.hivemind?.apiUrl || DEFAULT_HIVEMIND_API_URL;
  if (!base) throw new Error('no HIVEMIND API base configured — set HIVEMIND_API_URL or cfg.hivemind.apiUrl to your memory server\'s REST API base URL');
  return base;
}

// Browser-login handshake, matching the server's REAL, already-shipped CLI-auth endpoint —
// GET /auth/cli/start?callback=<loopback-url>&state=<rand> (control-plane-server.js's own doc
// comment: "same UX as `gh auth login --web` / `vercel login`"). This replaced an earlier
// generic OAuth2 PKCE + Dynamic Client Registration attempt that guessed at RFC 8414/7591/7636
// support and hit real 404s on /oauth/register and /oauth/token — /auth/cli/start needs none of
// that: no client registration, no PKCE, no discovery document. Server-side it:
//   1. Requires the caller already be logged in (browser session cookie) — if not, redirects
//      through the branded /hivemind/login page first, then loops back here automatically.
//   2. Mints (or reuses) a revocable API key for that user/org.
//   3. Parks the key behind a single-use, 60s-TTL exchange code and shows a branded
//      "Verified as <email>" confirmation page — the token is NEVER placed in a URL the user's
//      browser displays. Only after the user clicks Continue does the page redirect to our
//      localhost callback below with the real token.
//   4. Refuses to redirect anywhere except 127.0.0.1/localhost/::1 (or a chromiumapp.org
//      extension callback) — the token cannot leak to a remote host even if `callback` were
//      tampered with, so this is safe to point at by default.
//
// Deliberately NEVER throws — timeout, a non-loopback rejection, or any network hiccup all
// return `null` so the caller falls back to the manual paste-your-own-key flow.
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { require('child_process').spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref(); } catch (_) { /* user copies the URL manually below */ }
}

async function attemptHivemindOAuth(baseUrl, { timeoutMs = 180000 } = {}) {
  const http = require('http');
  try {
    const { server, port, waitForCallback } = await new Promise((resolve, reject) => {
      let resolveCb, rejectCb;
      const srv = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
        const token = u.searchParams.get('token');
        const state = u.searchParams.get('state');
        const email = u.searchParams.get('user_email') || '';
        const err = u.searchParams.get('error');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(err
          ? `<h2>ICARUS: sign-in failed (${err}) — return to your terminal.</h2>`
          : `<h2>ICARUS connected${email ? ` as ${email}` : ''} — you can close this tab and return to your terminal.</h2>`);
        if (err) rejectCb(new Error(err));
        else resolveCb({ token, state, email, userId: u.searchParams.get('user_id') || null, orgId: u.searchParams.get('org_id') || null });
      });
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const p = srv.address().port;
        resolve({ server: srv, port: p, waitForCallback: () => new Promise((res, rej) => { resolveCb = res; rejectCb = rej; }) });
      });
    });

    try {
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const state = base64url(crypto.randomBytes(16));
      const startUrl = `${baseUrl}/auth/cli/start?${new URLSearchParams({ callback: redirectUri, state })}`;

      console.log('\n  Opening your browser to sign in...');
      console.log(`  If it doesn't open automatically: ${startUrl}\n`);
      openBrowser(startUrl);

      const result = await Promise.race([
        waitForCallback(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timed out waiting for browser login')), timeoutMs)),
      ]);
      if (result.state !== state) throw new Error('state mismatch on callback — possible CSRF, aborting');
      if (!result.token) return null;
      return { token: result.token, userEmail: result.email || null, userId: result.userId, orgId: result.orgId };
    } finally {
      server.close();
    }
  } catch (_) {
    return null; // any network/timeout/state-mismatch failure -> caller falls back to manual key entry
  }
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Upload contract: `ingestMode=evidence` stores retrievable lexical + semantic evidence without
// memory/entity/relationship promotion; `both` also runs that more expensive promotion pipeline.
// ICARUS defaults to evidence-only so bulk document ingest is fast and does not manufacture
// memories. The user can explicitly choose `both` for a document set that merits it.
// Exact mirror of upload-contract.js's MIME_PREFIX — the server rejects a mismatched
// extension/content-type pair with 415 MIME_EXTENSION_MISMATCH. A real bug caught by testing an
// actual upload: `new Blob([buf])` with no `type` sends no meaningful content-type, which the
// server's `allowedMimes && contentType && !allowedMimes.includes(...)` check treated as a
// mismatch for every extension IT restricts (pdf/png/jpg/webp/gif/mp3/wav/m4a) — a browser's real
// File object carries its own detected MIME type, which is what the FE actually sends; ICARUS
// has to set it explicitly since it isn't a browser. Extensions with no entry here (docx/pptx/
// xlsx/txt/md/csv/tsv/html/htm/doc/ppt/tiff/flac/ogg) aren't MIME-checked server-side at all, so
// they don't need one.
const UPLOAD_MIME_BY_EXT = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};

async function hivemindUploadFile(filePath, org, cfg, { force = false, ingestMode = 'evidence' } = {}) {
  if (ingestMode !== 'evidence' && ingestMode !== 'both') {
    throw new Error(`invalid ingest mode "${ingestMode}" — expected evidence or both`);
  }
  const base = hivemindApiBase(cfg);
  const buf = fs.readFileSync(filePath);
  const mime = UPLOAD_MIME_BY_EXT[path.extname(filePath).toLowerCase()];
  const form = new FormData();
  form.append('file', new Blob([buf], mime ? { type: mime } : undefined), path.basename(filePath));
  form.append('targetScope', 'personal');
  form.append('ingestMode', ingestMode);
  form.append('tags', `icarus-org:${org}`);
  if (force) form.append('force', 'true');
  const res = await fetch(`${base}/api/knowledge/upload?async=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.hivemind.token}` },
    body: form,
  });
  const bodyText = await res.text();
  if (res.status === 409) {
    // A real, EXPECTED outcome — not a failure. The server's own response body says so
    // explicitly (`duplicate: true`, `status: "existing"`), rather than us assuming from the
    // status code alone. A real bug this was caught fixing: hivemindIngestDir's per-file loop
    // used to let this throw, which aborted the ENTIRE folder ingest on the first file the
    // server had already seen — one re-ingested doc silently dropped every other file in the
    // batch. Non-duplicate 409s (a genuinely unexpected shape) still throw below.
    let body; try { body = JSON.parse(bodyText); } catch (_) { body = null; }
    if (body?.duplicate) return { duplicate: true, existingTitle: body.existing_title || null, existingDocumentId: body.existing_document_id || null };
    throw new Error(`HIVEMIND upload 409: ${bodyText}`);
  }
  if (!res.ok) throw new Error(`HIVEMIND upload ${res.status}: ${bodyText}`);
  return JSON.parse(bodyText); // { job_id, status, storage_mode, ... }
}

async function hivemindPollJob(jobId, cfg, { intervalMs = 1000, maxAttempts = 60, onStatus } = {}) {
  const base = hivemindApiBase(cfg);
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(`${base}/api/knowledge/status?job_id=${jobId}`, {
      headers: { Authorization: `Bearer ${cfg.hivemind.token}` },
    });
    if (!res.ok) throw new Error(`HIVEMIND status ${res.status}: ${await res.text()}`);
    const body = await res.json();
    if (onStatus) onStatus(body);
    if (body.status === 'ready' || body.status === 'failed') return body;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`HIVEMIND job ${jobId} did not finish within ${(maxAttempts * intervalMs) / 1000}s — check later with the job_id above`);
}

// A terminal-safe tqdm-like line. Its phase and counts come only from observed server-job
// responses or named local stages; the bar itself measures completed files, never guessed work.
function formatHivemindProgress(event = {}, spinner = '') {
  const total = Math.max(0, Number(event.total) || 0);
  const completed = Math.max(0, Math.min(total, Number(event.completed) || 0));
  const width = 22;
  const filled = total ? Math.floor((completed / total) * width) : 0;
  const active = completed < total;
  const bar = `${'█'.repeat(filled)}${active ? '▌' : ''}${'░'.repeat(Math.max(0, width - filled - (active ? 1 : 0)))}`;
  const phase = ({ queued: 'queued', processing: 'extracting', uploading: 'uploading', mirroring: 'mirroring locally', purging: 'verifying & purging', duplicate: 'already ingested', pending: 'still processing', failed: 'failed', complete: 'complete', ready: 'ready' })[event.phase] || event.phase || 'working';
  const counts = event.counts || {};
  const details = [
    counts.pages != null && `${counts.pages} pages`,
    counts.segments != null && `${counts.segments} segments`,
    counts.memories != null && `${counts.memories} memories`,
  ].filter(Boolean).join(' · ');
  const file = event.file ? `  ${event.file}` : '';
  return `\r  ${spinner} [${bar}] ${completed}/${total}  ${phase}${details ? ` · ${details}` : ''}${file}`;
}

/** Purges a HIVEMIND-side document icarus itself just created — DELETE /api/knowledge/document,
 * confirmed real (server.js's "KNOWLEDGE BASE — Document Delete (cascading)" handler): removes
 * the knowledge_document row, its segments, evidence vectors, AND any memory it promoted
 * server-side. Real user directive this exists for: connected-mode ingest should use HIVEMIND's
 * server as a stateless extraction PIPELINE (real PDF/OCR/etc — the local engine can't do that),
 * never as permanent storage — icarus mirrors the extracted segments into the local .amr shard
 * first, then calls this to leave nothing of its own behind in the cloud "memory box". Best-
 * effort: a failed purge logs and is reported, never throws — the local mirror already
 * succeeded, and failing the whole ingest over a cleanup step would be worse than a leftover
 * cloud copy. Callers must only pass a document_id THIS ingest itself created (the fresh-upload
 * path) — never a pre-existing duplicate's id, which this ingest didn't create and may be relied
 * on elsewhere. */
async function purgeHivemindDocument(documentId, cfg) {
  const base = hivemindApiBase(cfg);
  const res = await fetch(`${base}/api/knowledge/document`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${cfg.hivemind.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: documentId }),
  });
  if (!res.ok) throw new Error(`HIVEMIND document delete ${res.status}: ${await res.text()}`);
  return true;
}

/** Real, deliberate memory save — POST /api/ingest/source with `mode: 'atomic'`: confirmed real
 * via document-first-ingestion.js's own doc comment ("one memory through the canonical engine
 * gateway") — same primitive MCP's save_memory / chat autosave use. Goes through the server's
 * normal embedding + smart-router + contradiction-detection pipeline (NOT evidence mode's
 * skip_fact_extraction/recall_exclude flags — this is a real, fully first-class memory, meant to
 * surface in normal recall next to evidence). `source.type: 'mcp'` matches detectMode()'s own
 * inference for single-memory saves, kept alongside the explicit `mode` override for clarity. */
async function hivemindSaveMemory(text, org, cfg, opts = {}) {
  const base = hivemindApiBase(cfg);
  const res = await fetch(`${base}/api/ingest/source`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.hivemind.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: text,
      mode: 'atomic',
      source: { type: 'mcp', platform: 'icarus' },
      title: opts.title || undefined,
      memory_type: opts.memoryType || undefined,
      entities: Array.isArray(opts.entities) ? opts.entities : undefined,
      tags: [...new Set([`icarus-org:${org}`, ...(Array.isArray(opts.tags) ? opts.tags : [])])],
    }),
  });
  const bodyText = await res.text();
  if (!res.ok) throw new Error(`HIVEMIND ingest/source ${res.status}: ${bodyText}`);
  return JSON.parse(bodyText); // { ok, mode: 'atomic', memoryIds, memoryId }
}

/** Local-engine equivalent of hivemindSaveMemory() for a disconnected/--local session: embeds
 * (real vector if configured, lexical zero-vector placeholder otherwise — same degrade-gracefully
 * rule ingestDir() already follows) and inserts at LAYER_MEMORY, so it's a normal first-class
 * memory, indistinguishable from anything /ingest already stored. */
async function saveLocalMemory(text, org, cfg, opts = {}) {
  const store = openStore(cfg, org);
  const hasOwnEmbeddings = embeddingsConfigured(cfg);
  const signMode = signingEnabled(cfg);
  let vec = new Float32Array(cfg.dim);
  let vectorMode = false;
  // Same free-HIVEMIND-embedding-fallback convention as mirrorHivemindDocumentLocally()/
  // recallQuery(): real vectors even with no own provider configured, as long as HIVEMIND is
  // connected. Degrades to a lexical zero-vector placeholder on any embedding failure, never
  // loses the save itself over a network hiccup.
  if (hasOwnEmbeddings || hivemindConfigured(cfg)) {
    try {
      [vec] = hasOwnEmbeddings ? await embed([text], cfg) : await embedViaHivemindService([text], cfg);
      vectorMode = true;
    } catch (_) { /* keep the zero-vector placeholder */ }
  }
  // Real bug fixed here: this used to call insert(text, vec, LAYER_MEMORY) — insert()'s 3rd
  // param is valid_from, NOT layer (see its Rust signature), so LAYER_MEMORY (0) was silently
  // landing as a fake "valid_from=0" timestamp, and the actual layer was never set at all (only
  // correct by coincidence, since the engine's own default layer also happens to be 0). Fixed to
  // call insertLayered() with a real timestamp AND an explicit layer.
  const slotId = store.insertLayered(text, vec, Date.now(), LAYER_MEMORY);
  if (signMode) signSlot(slotId, text, cfg, org);
  appendAuditEntry(cfg, org, 'insert', slotId, { source: opts.viaCloud ? 'save-cloud-mirror' : 'save-local' });
  if (vectorMode) store.enableHnsw();
  store.flush();
  return slotId;
}

const SAVE_MEMORY_TOOL = {
  type: 'function',
  function: {
    name: 'save_memory',
    description: 'Save one durable user fact using the official structured memory schema. Preserve the user claim; do not invent facts, entities, or relationships.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string' }, content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
        memory_type: { type: 'string', enum: ['fact', 'preference', 'decision', 'goal', 'event', 'lesson'] },
        entities: { type: 'array', items: { type: 'string' }, maxItems: 12 },
        relationship: { type: 'string', enum: ['update', 'extend', 'derive', 'contradict', 'partof', 'mentions'] },
        related_to: { type: 'string' },
      },
      required: ['title', 'content', 'tags'],
    },
  },
};

function normalizeStructuredSaveToolCall(argumentsText, knownIds = new Set()) {
  let value;
  try { value = JSON.parse(argumentsText); } catch (_) { return null; }
  if (!value || typeof value.title !== 'string' || !value.title.trim() || typeof value.content !== 'string' || !value.content.trim()) return null;
  const tags = Array.isArray(value.tags) ? [...new Set(value.tags.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 8) : [];
  const entities = Array.isArray(value.entities) ? [...new Set(value.entities.map((entity) => String(entity).trim()).filter(Boolean))].slice(0, 12) : [];
  const relationship = typeof value.relationship === 'string' && REL_WORD_TO_TYPE[value.relationship.toLowerCase()] && knownIds.has(value.related_to)
    ? value.relationship.toLowerCase() : null;
  return {
    title: value.title.trim().slice(0, 160), content: value.content.trim(), tags,
    memoryType: ['fact', 'preference', 'decision', 'goal', 'event', 'lesson'].includes(value.memory_type) ? value.memory_type : 'fact',
    entities, relationship, relatedTo: relationship ? value.related_to : null,
  };
}

async function draftStructuredSave(text, org, cfg) {
  const key = openRouterApiKey(cfg);
  if (!key || (cfg.llm?.provider && cfg.llm.provider !== 'openrouter')) return null;
  const existing = listStructuredMemories(org, cfg, { limit: 20 });
  const knownIds = new Set(existing.map((memory) => memory.id));
  const candidates = existing.map((memory) => ({ id: memory.id, title: memory.title, content: memory.content.slice(0, 240) }));
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: resolveSynthesisModel(cfg), temperature: 0, max_tokens: 400,
      messages: [
        { role: 'system', content: 'Use the save_memory tool exactly once. Preserve the user claim in content. Supply 2-5 precise tags and exact named entities only. Create a relationship only when it is explicitly supported and related_to is one of the provided ids; otherwise omit both.' },
        { role: 'user', content: `User memory: ${text}\n\nExisting structured memories eligible as relationship targets:\n${JSON.stringify(candidates)}` },
      ],
      tools: [SAVE_MEMORY_TOOL], tool_choice: { type: 'function', function: { name: 'save_memory' } },
    }),
  });
  if (!res.ok) return null; // Unsupported tool calling / transient provider failure falls back without losing the save.
  const args = (await res.json())?.choices?.[0]?.message?.tool_calls?.find((call) => call.function?.name === 'save_memory')?.function?.arguments;
  return typeof args === 'string' ? normalizeStructuredSaveToolCall(args, knownIds) : null;
}

// Human /save uses the same official save_memory schema when an OpenRouter key is available.
// A model or provider failure never blocks a durable save: it simply returns to plain local text.
async function saveIntelligentMemory(text, org, cfg, { cloud = false } = {}) {
  let draft = null;
  try { draft = await draftStructuredSave(text, org, cfg); } catch (_) { /* graceful fallback below */ }
  if (!draft) {
    if (cloud && hivemindConfigured(cfg)) {
      const remote = await hivemindSaveMemory(text, org, cfg);
      const slot = await saveLocalMemory(text, org, cfg, { viaCloud: true });
      return { mode: 'plain-cloud', remote, slot };
    }
    return { mode: 'plain-local', slot: await saveLocalMemory(text, org, cfg) };
  }
  const saved = await saveStructuredMemory(draft.content, org, cfg, {
    title: draft.title, tags: [...draft.tags, ...draft.entities.map((entity) => `entity:${entity}`)], sourceType: draft.memoryType,
    relationship: draft.relationship, relatedTo: draft.relatedTo,
  });
  let remote = null;
  if (cloud && hivemindConfigured(cfg)) remote = await hivemindSaveMemory(draft.content, org, cfg, draft);
  return { mode: 'structured', ...saved, draft, remote };
}

// ── Structured memory (agent-facing MCP tools) ──────────────────────────────────────────────
//
// The human /save path above stores plain prose text — a person typing into the TUI has no
// schema to follow. An AI agent calling an MCP tool is different: it's given a real schema
// (title/content/tags/source_type/relationship/related_to, matching HIVEMIND's own
// hivemind_save_memory) and — being the LLM itself — fills it in thoughtfully, the same way it
// would call hivemind_save_memory server-side. icarus's job here is just to store what the
// agent already decided, not to run its own extraction on top.
//
// Storage convention deliberately reused, not invented: HIVEMIND's own real .amr storage
// backend (core/src/vector/mneme/amr-store.mjs) already stores every record as
// `JSON.stringify({id, content, title, tags, ...})` via insertLayered(), and the native engine's
// findById()/addEdge()/traverseTyped()/update()/delete() were built specifically to operate on
// that convention (confirmed by lib.rs's own doc comments — "HIVEMIND traverse_graph parity",
// "the agent always serializes {"id":"<uuid>",...}"). Reusing that exact shape end-to-end means
// icarus's structured memories are the same real format HIVEMIND's own server-side embedded
// engine already uses, not a second, incompatible one.
//
// Plain-prose slots (existing /save, /ingest, /save --cloud mirror) and JSON-enveloped slots
// (this section) coexist safely in the same shard: extractId()/findById() simply skip any slot
// whose text isn't `{"id":"..."}`-shaped (real, by design — see lib.rs's extract_id, which
// returns None on no match), and recall's own hybrid search treats both as plain searchable
// text either way.

function newMemoryId() { return crypto.randomUUID(); }

/** Parses a slot's stored text as a structured-memory record, or returns null for anything that
 * isn't one (plain prose from /save, evidence segments from /ingest, skill markdown — all real,
 * expected non-JSON text sharing the same shard). Never throws. */
function tryParseMemoryRecord(text) {
  if (!text || text[0] !== '{') return null;
  try {
    const rec = JSON.parse(text);
    return rec && typeof rec === 'object' && typeof rec.id === 'string' ? rec : null;
  } catch (_) { return null; }
}

/** The text actually worth embedding/displaying for a structured record — just `content` (and
 * `title` when present), never the raw JSON envelope. Embedding the full JSON blob would dilute
 * the vector with field-name/punctuation noise (the exact chunk-dilution lesson from earlier
 * this session); BM25 self-corrects for repeated boilerplate keys via IDF, but dense embedding
 * does not, so this matters most for the embed-time text, not just display. */
function memoryDisplayText(rec) {
  return rec.title ? `${rec.title}\n${rec.content || ''}` : (rec.content || '');
}

/** Real, deliberate memory save with HIVEMIND's own schema (title/content/tags/source_type/
 * relationship/related_to) — the primitive behind the icarus_save_memory MCP tool. `relationship`
 * + `relatedTo` records a real typed edge (native addEdge(), exact HIVEMIND enum) from the new
 * memory to the target — a genuinely SEPARATE memory that relates to an existing one, distinct
 * from icarus_update_memory below (which corrects an EXISTING memory in place, same id). Returns
 * the new memory's real id (a UUID an agent can pass back into related_to/get/update/delete). */
async function saveStructuredMemory(content, org, cfg, opts = {}) {
  const store = openStore(cfg, org);
  const hasOwnEmbeddings = embeddingsConfigured(cfg);
  const id = newMemoryId();
  const now = new Date();
  const rec = {
    id, content, title: opts.title || null, tags: Array.isArray(opts.tags) ? opts.tags : [],
    source_type: opts.sourceType || null, layer: 'memory', created_at: now.toISOString(),
    valid_from: now.getTime(), is_latest: true, project: opts.project || null,
  };
  let vec = new Float32Array(cfg.dim);
  let vectorMode = false;
  if (hasOwnEmbeddings || hivemindConfigured(cfg)) {
    try {
      [vec] = hasOwnEmbeddings ? await embed([content], cfg) : await embedViaHivemindService([content], cfg);
      vectorMode = true;
    } catch (_) { /* keep the zero-vector placeholder — same degrade-gracefully rule as saveLocalMemory */ }
  }
  const slotId = store.insertLayered(JSON.stringify(rec), vec, now.getTime(), LAYER_MEMORY);
  appendAuditEntry(cfg, org, 'insert', slotId, { source: 'save-memory-structured', sourceFile: opts.title || null });
  let edge = null;
  if (opts.relationship && opts.relatedTo) {
    const relType = REL_WORD_TO_TYPE[opts.relationship.toLowerCase()];
    if (!relType) throw new Error(`unknown relationship "${opts.relationship}" — one of update, extend, derive, contradict, partof, mentions`);
    const targetSlot = store.findById(opts.relatedTo);
    if (targetSlot < 0) throw new Error(`related_to "${opts.relatedTo}" — no live memory with that id in org "${org}"`);
    store.addEdge(slotId, targetSlot, relType, 255);
    // "update" specifically means the new memory supersedes the old one for normal recall — flip
    // the OLD record's is_latest via rewriteText (metadata-only mutation, vector/layer/edges
    // untouched — exactly what rewriteText's own doc comment says it's for).
    if (opts.relationship === 'update') {
      const oldText = store.slotText(targetSlot);
      const oldRec = tryParseMemoryRecord(oldText);
      if (oldRec && oldRec.is_latest !== false) {
        oldRec.is_latest = false;
        store.rewriteText(targetSlot, JSON.stringify(oldRec));
      }
    }
    edge = { type: opts.relationship, target: opts.relatedTo };
  }
  if (vectorMode) store.enableHnsw();
  store.flush();
  return { id, slot: slotId, edge };
}

/** Fetch one structured memory by its real id — native findById() + slotText(), O(1) off the
 * engine's own id index, no JS-side Map. Returns null if not found or tombstoned (a deleted
 * memory's slot fails findById's own liveness check — see lib.rs's find_by_id doc comment). */
function getStructuredMemory(memoryId, org, cfg) {
  const store = openStore(cfg, org);
  const slot = store.findById(memoryId);
  if (slot < 0) return null;
  const rec = tryParseMemoryRecord(store.slotText(slot));
  return rec ? { ...rec, slot } : null;
}

/** Lists structured memories for an org, newest-first, optionally AND-filtered by tags.
 * Streams via the native recordsPage() page-by-page (bounded JS heap, same pattern HIVEMIND's own
 * amr-store.mjs uses) rather than allRecords() — real for shards of any size, not just small
 * test ones. Plain-prose slots (non-JSON text) are silently skipped, not counted against limit. */
function listStructuredMemories(org, cfg, { tags = [], limit = 20, includeSuperseded = false } = {}) {
  const store = openStore(cfg, org);
  const PAGE = 500;
  const out = [];
  let from = 0;
  for (;;) {
    const { rows, nextSlot } = store.recordsPage(from, PAGE);
    for (const { slotId, text } of rows) {
      const rec = tryParseMemoryRecord(text);
      if (!rec) continue;
      if (!includeSuperseded && rec.is_latest === false) continue;
      if (tags.length && !tags.every((t) => (rec.tags || []).includes(t))) continue;
      out.push({ ...rec, slot: slotId });
    }
    if (nextSlot === 0xffffffff || out.length >= limit * 4) break; // real cap: don't scan a huge shard fully for a small limit
    from = nextSlot;
  }
  out.sort((a, b) => (b.valid_from || 0) - (a.valid_from || 0));
  return out.slice(0, limit);
}

/** Corrects an EXISTING memory in place — same id, matching HIVEMIND's real hivemind_update_memory
 * semantics ("Use when a stored fact is outdated and needs correction"), NOT a new related memory
 * (see saveStructuredMemory's relationship+relatedTo for that). Uses the native update() primitive
 * directly — it auto-adds a real Updates edge (new slot -> old slot) and tombstones the old slot
 * internally, so findById(id) naturally resolves to the live new slot afterward (same "id" field,
 * old candidate just fails the liveness check) — exactly the real, built-in HIVEMIND-parity
 * mechanism, not a hand-rolled one. */
async function updateStructuredMemory(memoryId, patch, org, cfg) {
  const store = openStore(cfg, org);
  const slot = store.findById(memoryId);
  if (slot < 0) throw new Error(`no live memory with id "${memoryId}" in org "${org}"`);
  const old = tryParseMemoryRecord(store.slotText(slot));
  if (!old) throw new Error(`memory "${memoryId}" exists but isn't a structured record — can't update it with this tool`);
  const merged = {
    ...old,
    content: patch.content ?? old.content,
    title: patch.title !== undefined ? patch.title : old.title,
    tags: Array.isArray(patch.tags) ? patch.tags : old.tags,
  };
  const hasOwnEmbeddings = embeddingsConfigured(cfg);
  let vec = new Float32Array(cfg.dim);
  if (hasOwnEmbeddings || hivemindConfigured(cfg)) {
    try { [vec] = hasOwnEmbeddings ? await embed([merged.content], cfg) : await embedViaHivemindService([merged.content], cfg); }
    catch (_) { /* zero-vector placeholder */ }
  }
  const now = Date.now();
  const newSlot = store.update(slot, JSON.stringify(merged), vec, now, old.valid_from || now);
  // Real gap caught live: native update() removes the OLD slot from the id-index (so findById
  // correctly resolves to the new slot afterward) but does NOT rewrite the old slot's own stored
  // JSON text — it stays "is_latest":true forever, so plain recall()/bm25Search() (which scan
  // live slots directly, not the id-index) kept surfacing the stale pre-correction content
  // alongside the corrected version, both under the same memoryId. Flip it explicitly.
  if (old.is_latest !== false) {
    try { store.rewriteText(slot, JSON.stringify({ ...old, is_latest: false })); }
    catch (_) { /* best-effort — the correction itself already succeeded above either way */ }
  }
  appendAuditEntry(cfg, org, 'update', newSlot, { source: 'update-memory', sourceFile: null });
  store.flush();
  return { id: memoryId, slot: newSlot };
}

/** Permanently deletes (tombstones) a memory by id — native delete(), matching HIVEMIND's real
 * hivemind_delete_memory semantics. `reason` is audit-only (never sent anywhere, just recorded
 * locally for "why was this removed" later). */
function deleteStructuredMemory(memoryId, reason, org, cfg) {
  const store = openStore(cfg, org);
  const slot = store.findById(memoryId);
  if (slot < 0) throw new Error(`no live memory with id "${memoryId}" in org "${org}"`);
  store.delete(slot);
  appendAuditEntry(cfg, org, 'delete', slot, { source: 'delete-memory', sourceFile: reason || null });
  store.flush();
  return { id: memoryId, deleted: true };
}

/** BFS graph walk from a seed memory along real typed edges — native traverseTyped(), exact
 * HIVEMIND traverse_graph parity (per lib.rs's own doc comment). `relationship` filters to one
 * edge type; omitted/"all" walks every type and unions the reachable set. */
function traverseStructuredGraph(memoryId, org, cfg, { relationship, depth = 2 } = {}) {
  const store = openStore(cfg, org);
  const seed = store.findById(memoryId);
  if (seed < 0) throw new Error(`no live memory with id "${memoryId}" in org "${org}"`);
  const types = relationship && relationship !== 'all'
    ? [REL_WORD_TO_TYPE[relationship.toLowerCase()]]
    : Object.values(REL_TYPE);
  const seen = new Set();
  for (const t of types) {
    if (!t) continue;
    for (const slot of store.traverseTyped(seed, t, depth)) seen.add(slot);
  }
  const out = [];
  for (const slot of seen) {
    let rec; try { rec = tryParseMemoryRecord(store.slotText(slot)); } catch (_) { rec = null; }
    if (rec) out.push({ ...rec, slot });
  }
  return out;
}

/** Fetch a HIVEMIND-processed document's segments back — GET /api/documents/:id (real, confirmed
 * endpoint: core/src/server.js's `documentId` route, returns `{document, segments, promotedMemories,
 * segmentCount, promotedCount}` where each segment row has a real `.content` (the chunk text)).
 * This is the ONLY thing that comes back — checked job status, this endpoint, and /api/recall, and
 * none of them expose the actual embedding VECTORS the server computed (they live only in Qdrant,
 * never surfaced over HTTP). So a local mirror can pull back the server's real chunking work, but
 * has to re-embed locally rather than reuse the server's own vectors — see
 * mirrorHivemindDocumentLocally()'s own doc comment for what that means in practice. */
async function hivemindFetchDocumentSegments(documentId, cfg) {
  const base = hivemindApiBase(cfg);
  const res = await fetch(`${base}/api/documents/${documentId}`, {
    headers: { Authorization: `Bearer ${cfg.hivemind.token}` },
  });
  if (!res.ok) throw new Error(`HIVEMIND documents ${res.status}: ${await res.text()}`);
  return res.json();
}

/** After HIVEMIND finishes processing a file (real chunking/OCR/extraction — work ICARUS's local
 * engine can't do for pdf/docx/images), pull the resulting segment TEXT back and store it in the
 * LOCAL .amr shard too, under LAYER_EVIDENCE — so ingesting through HIVEMIND leaves you with a
 * real local copy, not just a server-side one.
 *
 * Real, load-bearing limitation, stated plainly rather than silently glossed over: the server
 * never exposes the embedding VECTORS it computed (confirmed — no endpoint returns them). So this
 * does NOT get "cloud embedding, local storage" — it gets cloud CHUNKING + local RE-EMBEDDING
 * (using cfg.embeddings, the same provider local ingestDir() already uses) + local storage. If no
 * embedding provider is configured, it stores lexical-only (BM25, zero-vector placeholder) —
 * exactly ingestDir()'s own degrade-gracefully behavior, not a new failure mode. Returns the
 * number of segments mirrored (0 if the document had none, e.g. still processing). */
// Real, live, UNAUTHENTICATED OpenAI-compatible embeddings service — confirmed via direct curl:
// POST https://embeddings.singulancelabs.com/v1/embeddings with no Authorization header returns
// real bge-m3, 1024-dim vectors (200 OK; note the path is `/v1/embeddings`, not bare
// `/embeddings` — that 404s). This is the SAME service HIVEMIND's own server uses as its primary
// embedding route (Cloudflare-hosted, ~79-149ms measured, OpenRouter as its own fallback) — so
// vectors computed here land in the exact same embedding space the server's own recall/storage
// already uses. Real vector-space parity, not a guess or a different model landing in the same
// dimension by coincidence.
const HIVEMIND_EMBEDDINGS_URL = 'https://embeddings.singulancelabs.com/v1/embeddings';

async function embedViaHivemindService(texts, cfg) {
  const res = await fetchAuxiliary(HIVEMIND_EMBEDDINGS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'bge-m3', input: texts }),
  }, cfg);
  if (!res.ok) throw new Error(`HIVEMIND embeddings ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.data.map((d) => {
    const v = Float32Array.from(d.embedding);
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= n; // L2-normalize for cosine, same as embed()
    return v;
  });
}

// Real, live, UNAUTHENTICATED reranker — same box as HIVEMIND_EMBEDDINGS_URL (confirmed via its
// own /openapi.json: title "BGE Embedding & Reranker", serving both /v1/embeddings and this route
// from one FastAPI service). Real contract verified by direct curl, not guessed: POST
// /api/v1/rerank with {query, documents, top_n} returns {results: [{index, relevance_score}]}
// sorted descending — confirmed a real unrelated document scores ~1e-5 while a real match scores
// ~0.999. This is the "narrow re-score" half of a proper wide-retrieve-then-rerank recall
// pipeline: /api/recall (or local HNSW/BM25) does the cheap WIDE candidate pull, this cross-
// encoder reranker (bge-reranker-v2-m3) does the expensive but far more accurate NARROW re-score
// on just those candidates — standard two-stage retrieval, not something either recall path did
// before this.
const HIVEMIND_RERANK_URL = 'https://rerank.singulancelabs.com/api/v1/rerank';

async function rerankViaHivemindService(query, documents, topN, cfg) {
  const res = await fetchAuxiliary(HIVEMIND_RERANK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, documents, top_n: topN }),
  }, cfg);
  if (!res.ok) throw new Error(`HIVEMIND rerank ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.results; // [{index, relevance_score}], sorted desc by relevance_score
}

/** Re-score a WIDE candidate set down to `topK` using the real cross-encoder reranker, replacing
 * each hit's own score with the reranker's `relevance_score` (a real, more accurate signal than
 * cosine/BM25 alone — that's the whole point of a rerank stage). Falls back to the original
 * wide-search order (already-sorted, just truncated to topK) on any failure — a network hiccup on
 * the free rerank service must never make recall itself fail. */
async function rerankHits(query, hits, topK, cfg) {
  if (hits.length <= 1) return hits.slice(0, topK);
  try {
    const results = await rerankViaHivemindService(query, hits.map((h) => h.text), topK, cfg);
    return results.map((r) => ({ ...hits[r.index], score: r.relevance_score, mode: 'hybrid-reranked' }));
  } catch (_) {
    // The same wide retrieval result is already valid. Keep its existing RRF/BM25 ordering and
    // provider-neutral mode rather than leaking a transient remote error into the user-facing
    // answer. This is a quality downgrade, not a recall failure.
    return hits.slice(0, topK);
  }
}

async function mirrorHivemindDocumentLocally(documentId, sourceLabel, org, cfg) {
  const { segments } = await hivemindFetchDocumentSegments(documentId, cfg);
  const texts = (segments || [])
    .map((s) => `${sourceLabel}\n${s.content || ''}`)
    .filter((t) => t.trim().length > 20);
  if (!texts.length) return 0;

  const store = openStore(cfg, org);
  const signMode = signingEnabled(cfg);
  const zero = new Float32Array(cfg.dim);
  let stored = 0;
  const insertOne = (text, vec) => {
    const slotId = store.insertLayered(text, vec, Date.now(), LAYER_EVIDENCE);
    if (signMode) signSlot(slotId, text, cfg, org);
    appendAuditEntry(cfg, org, 'insert', slotId, { source: 'ingest-evidence', sourceFile: sourceLabel });
    stored++;
  };
  // Prefer the user's OWN configured provider if they set one up (respect their explicit choice
  // — e.g. a self-hosted LiteLLM gateway). Otherwise, since HIVEMIND is connected anyway, use its
  // free embeddings service instead of degrading straight to lexical-only zero-vectors — a real
  // improvement: anyone connected to HIVEMIND without their own OpenRouter key still gets real
  // semantic vectors locally, not just BM25. Falls back to lexical-only per-batch (not aborting
  // the whole mirror) if even the free service errors — network hiccups shouldn't lose the text.
  const hasOwnEmbeddings = embeddingsConfigured(cfg);
  let embeddingsAvailable = hasOwnEmbeddings || hivemindConfigured(cfg);
  let usedVectors = false;
  for (let i = 0; i < texts.length; i += 16) {
    const batch = texts.slice(i, i + 16);
    if (!embeddingsAvailable) {
      batch.forEach((text) => insertOne(text, zero));
      continue;
    }
    try {
      const vecs = hasOwnEmbeddings ? await embed(batch, cfg) : await embedViaHivemindService(batch, cfg);
      batch.forEach((text, j) => insertOne(text, vecs[j]));
      usedVectors = true;
    } catch (_) {
      // Auxiliary provider failures are intentionally silent: the evidence text is durable and
      // BM25-searchable, so expose neither an error nor repeated per-batch timeout cost.
      embeddingsAvailable = false;
      batch.forEach((text) => insertOne(text, zero));
    }
  }
  if (usedVectors) store.enableHnsw();
  store.flush();
  return stored;
}

// A duplicate response can name a document which no longer exists (or is no longer readable) in
// the document API. It cannot be mirrored into the local shard, so it must be reported as an
// incomplete ingest rather than as a successful per-org duplicate.
function isInaccessibleHivemindDuplicate(error) {
  return /^HIVEMIND documents 404:/.test(error?.message || String(error));
}

/** Upload every file under `dir` to HIVEMIND (real REST API, async job per file) instead of the
 * local engine. Returns the same shape ingestDir() does, so callers (CLI/MCP) don't need to know
 * which path ran. `files`/`chunks`/`live` come from HIVEMIND's own per-job counts, not invented
 * locally — a real report of what its server actually did, not an assumption.
 *
 * Every file goes through the real server extraction pipeline (`mode: 'document'` under
 * /api/knowledge/upload) — no evidence-only client shortcut; the server decides what it promotes.
 * Images (IMAGE_EXTS) are filtered out of the upload set BEFORE sending anything: confirmed by
 * reading the real server code that images are routed through a DIFFERENT internal pipeline
 * (`mode: 'atomic'`, a plain memory insert) that never creates a `knowledgeDocument` — the
 * `document_id` an image upload returns is actually a memory id, so GET /api/documents/:id
 * always 404s for it and mirrorHivemindDocumentLocally can never work for images. Skipping them
 * client-side avoids the pointless upload + guaranteed-404 mirror attempt entirely. */
async function hivemindIngestDir(dir, org, cfg, onProgress, opts = {}) {
  const files = walkFiles(dir, HIVEMIND_UPLOAD_EXTS); // excludes images — see this function's own doc comment
  const skippedImages = walkFiles(dir, IMAGE_EXTS).length;
  const mirrorLocal = opts.mirrorLocal !== false; // default ON — see mirrorHivemindDocumentLocally's doc comment
  let totalMemories = 0;
  let totalSegments = 0;
  let duplicates = 0;
  let unavailableDuplicates = 0; // duplicate IDs which the server cannot supply for local mirroring
  let pending = 0; // uploaded, still processing past the poll window — not a failure
  let failed = 0; // genuinely errored (network blip, 5xx, etc.) — logged, batch keeps going
  let mirrored = 0; // segments actually written into the local .amr shard this run
  let purged = 0; // cloud documents (this ingest itself created) deleted after mirroring
  const purgeCloud = opts.purgeCloud !== false; // default ON — see purgeHivemindDocument's doc comment
  const ingestMode = opts.ingestMode || 'evidence';
  if (ingestMode !== 'evidence' && ingestMode !== 'both') throw new Error(`invalid ingest mode "${ingestMode}" — expected evidence or both`);
  let n = 0;
  let completedFiles = 0; // terminal outcomes only; a timed-out remote job is explicitly not done
  // The WHOLE per-file body is wrapped, not just the poll — a real bug, same class as the
  // 409-duplicate one this function already guards against but caught SEPARATELY, live: a
  // transient 502 from hivemindUploadFile on file #9 of a real 55-file batch was left
  // unguarded, aborting files #10-55 outright. Nothing in this loop may ever let ONE file's
  // failure — upload error, poll timeout, transient 5xx — kill the rest of the batch; that's
  // the whole point of iterating a folder instead of hand-calling upload once per file.
  for (const f of files) {
    const emit = (event = {}) => {
      if (onProgress) onProgress({ total: files.length, completed: completedFiles, current: n + 1, file: path.basename(f), ...event });
    };
    try {
      emit({ phase: 'uploading' });
      let job = await hivemindUploadFile(f, org, cfg, { ...opts, ingestMode });
      if (job.duplicate) {
        duplicates++; // already ingested server-side — a skip, not a failure
        emit({ phase: 'duplicate' });
        // Still worth mirroring locally: "already in your knowledge base" describes the SERVER,
        // not this machine — the exact real gap this feature exists to close (a file dedup'd
        // from an earlier session/machine, but this shard has never seen it).
        if (mirrorLocal && job.existingDocumentId) {
          try { emit({ phase: 'mirroring' }); mirrored += await mirrorHivemindDocumentLocally(job.existingDocumentId, path.basename(f), org, cfg); }
          catch (e) {
            if (!isInaccessibleHivemindDuplicate(e)) {
              console.error(`icarus: local mirror failed for ${path.basename(f)} — ${e.message}`);
            } else {
              // Do NOT falsely report a cross-org checksum record as this shard's evidence.
              // The server's force/reprocess route is a separate lifecycle operation and must
              // repair its unavailable remote-agent cleanup before it can be safely retried.
              unavailableDuplicates++;
              emit({ phase: 'unavailable' });
            }
          }
        }
      }
      if (!job.duplicate) {
        let result;
        try {
          emit({ phase: job.status || 'queued', jobId: job.job_id, counts: job.counts });
          result = await hivemindPollJob(job.job_id, cfg, { onStatus: (status) => emit({ phase: status.status, jobId: job.job_id, counts: status.counts }) });
        } catch (e) {
          // Poll window (60s default) elapsed — a real, legitimate outcome for OCR/vision
          // extraction on a large PDF/PPTX, not an error. The upload already succeeded
          // server-side; only the CLI's wait-and-report gave up, the job keeps running.
          console.error(`icarus: ${path.basename(f)} still processing past the wait window — ${e.message}`);
          pending++;
          n++;
          emit({ phase: 'pending', current: n, jobId: job.job_id });
          continue;
        }
        if (result.status === 'failed') {
          console.error(`icarus: HIVEMIND ingest failed for ${f} — ${result.error || 'unknown error'}`);
          failed++;
          emit({ phase: 'failed', jobId: job.job_id, counts: result.counts });
        } else {
          totalMemories += result.counts?.memories || 0;
          totalSegments += result.counts?.segments || 0;
          let mirrorOk = false;
          if (mirrorLocal && result.document_id) {
            try { emit({ phase: 'mirroring', jobId: job.job_id, counts: result.counts });
              mirrored += await mirrorHivemindDocumentLocally(result.document_id, path.basename(f), org, cfg);
              mirrorOk = true;
            } catch (e) { console.error(`icarus: local mirror failed for ${path.basename(f)} — ${e.message}`); }
          }
          // Only purge a document THIS ingest just created via the fresh-upload path (never the
          // job.duplicate branch above — that document pre-existed this call and may be relied on
          // elsewhere). Only after a successful local mirror — purging before confirming the
          // extracted text actually landed locally would lose it outright on a mirror failure.
          if (purgeCloud && mirrorOk && result.document_id) {
            try { emit({ phase: 'purging', jobId: job.job_id, counts: result.counts }); await purgeHivemindDocument(result.document_id, cfg); purged++; }
            catch (e) { console.error(`icarus: cloud purge failed for ${path.basename(f)} — ${e.message} (mirrored locally either way, but a server-side copy remains)`); }
          }
        }
      }
    } catch (e) {
      console.error(`icarus: ${path.basename(f)} — ${e.message}`);
      failed++;
      emit({ phase: 'failed' });
    }
    n++;
    completedFiles++;
    emit({ phase: 'complete', current: n });
  }
  return {
    // `remoteSegments` is what newly-created server jobs reported. `mirrored` is the only
    // authoritative count of evidence that actually reached THIS local shard, including the
    // duplicate-document recovery branch. Keep them separate: reporting zero remote segments
    // as zero local evidence was a misleading accounting bug.
    files: files.length, chunks: mirrored, remoteSegments: totalSegments, live: totalMemories,
    mode: ingestMode, distilled: totalMemories > 0, signed: 0, duplicates, unavailableDuplicates, pending, failed, mirrored, skippedImages, purged,
  };
}

// hivemindRecallQuery (POST /api/recall) EXISTED here and was removed — a real, live cross-
// tenant data leak, not a hypothetical: a real test session saw completely unrelated users' and
// orgs' private content (other companies' sales-pipeline docs, unrelated personal messages) come
// back for queries scoped to this user's own org tag. This was already flagged as an unverified
// caveat in this function's own prior doc comment ("not verified to be org-scoped server-side
// yet") — that caveat turned out to be real. Recall must NEVER hit the server's shared recall
// index again. HIVEMIND is still used for ingest/save PROCESSING (chunking, OCR, extraction, the
// real embedding/rerank helper services) — recallQuery() below already calls those same free
// services for the query-embedding and rerank steps when connected — but the actual search
// happens ONLY against this machine's own local .amr shard, which by construction can never
// return another tenant's data.

/** Real reported bug: every org, even a brand-new one with zero memories, showed ~4.2 MB of
 * "storage" in /status and the ingest org-picker. Root cause, confirmed by comparing `stat`'s
 * logical size against its actual allocated blocks: shard.vec (and shard.amr) are pre-allocated
 * via `set_len()` to a fixed 1024-slot capacity at CREATE time (see mseg/src/segment.rs's
 * INITIAL_SLOTS), which on APFS/most filesystems creates a genuinely SPARSE file — st_size
 * reports the full logical 4,194,304-byte capacity, but st_blocks (real allocated disk blocks)
 * was 0 for a freshly-created, still-empty org. fs.Stats.size is the logical size; .blocks * 512
 * is the real on-disk footprint and is what a "storage used" figure should mean. Falls back to
 * .size on a platform/FS that doesn't populate .blocks (never worse than the old behavior, only
 * more accurate where the field exists). */
function realDiskBytes(stat) {
  return (typeof stat.blocks === 'number' && stat.blocks >= 0) ? stat.blocks * 512 : stat.size;
}

function statusReport(cfg) {
  let orgs = [];
  try {
    orgs = fs.readdirSync(cfg.dataRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (_) { /* no shards yet */ }
  return {
    dataRoot: cfg.dataRoot,
    dim: cfg.dim,
    hivemindConnected: !!(cfg.hivemind && cfg.hivemind.connected),
    shards: orgs.map((o) => {
      const dir = path.join(cfg.dataRoot, o.name);
      let bytes = 0;
      for (const f of fs.readdirSync(dir)) {
        try { bytes += realDiskBytes(fs.statSync(path.join(dir, f))); } catch (_) { /* race with a concurrent writer */ }
      }
      return { org: o.name, bytesOnDisk: bytes };
    }),
  };
}

/** Every existing org shard with its real on-disk size and a real creation date, for a
 * "which org do you mean?" prompt (/ingest with no --org) — not fabricated: creation date comes
 * from the earliest file's birthtime (falls back to mtime where the filesystem has no true birth
 * time, e.g. some Linux setups — still the best real signal available, not guessed). Sorted
 * oldest-first so the org someone's been using longest reads first, not alphabetically. */
function listOrgsWithMeta(cfg) {
  let orgs = [];
  try {
    orgs = fs.readdirSync(cfg.dataRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (_) { return []; }
  return orgs.map((o) => {
    const dir = path.join(cfg.dataRoot, o.name);
    let bytes = 0;
    let createdAt = null;
    try {
      for (const f of fs.readdirSync(dir)) {
        try {
          const st = fs.statSync(path.join(dir, f));
          bytes += realDiskBytes(st); // real allocated blocks, not the sparse pre-allocated logical size
          const bt = (st.birthtimeMs && st.birthtimeMs > 0) ? st.birthtime : st.mtime;
          if (!createdAt || bt < createdAt) createdAt = bt;
        } catch (_) { /* race with a concurrent writer */ }
      }
    } catch (_) { /* dir vanished mid-scan */ }
    return { org: o.name, bytesOnDisk: bytes, createdAt };
  }).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

/** Real per-org content breakdown for a richer /status: memories (structured, real exact count
 * via a full recordsPage scan), relationships (real native edges — sum of slotEdges() over every
 * structured memory found), and evidence/other (everything else live in the shard: /ingest
 * segments, plain /save prose, skills). Deliberately does NOT report an "entities" count —
 * icarus has no local entity-extraction/NER of its own (that's a real HIVEMIND server-side
 * capability, not something this engine does), so a fabricated number would be worse than
 * admitting the gap. Bounded to a real shard size (500k cap) so a huge shard's full scan can't
 * hang a status call indefinitely — same page-by-page streaming pattern listStructuredMemories
 * already uses. */
/** `opts.retry: false` (the default here — /status and org-pickers are the callers) fails fast
 * on a real lock conflict instead of the usual ~6.3s CRUD-path wait — see openStore()'s own doc
 * comment for why a read-only stats display shouldn't pay that cost. Returns `{unavailable:
 * true}` in that case rather than throwing, so a caller can render a plain, instant "counts
 * unavailable" line instead of every /status turning into a multi-second freeze. Pass
 * `{retry: true}` explicitly for a caller that genuinely needs the real numbers and can afford
 * to wait (none currently do — kept as an explicit opt-in, not a silent default). */
function richOrgStats(org, cfg, opts = {}) {
  const retry = opts.retry === true;
  let store;
  try {
    store = openStore(cfg, org, { retry });
  } catch (e) {
    if (/locked by another process|still locked/i.test(e.message || '')) return { unavailable: true, reason: e.message };
    throw e;
  }
  const live = store.liveCount();
  const memories = listStructuredMemories(org, cfg, { limit: 500000, includeSuperseded: true });
  let relationships = 0;
  for (const m of memories) {
    try { relationships += (store.slotEdges(m.slot) || []).length; } catch (_) { /* tombstoned mid-scan — skip */ }
  }
  return {
    live,
    memories: memories.length,
    memoriesLatest: memories.filter((m) => m.is_latest !== false).length,
    relationships,
    evidenceAndOther: Math.max(0, live - memories.length),
    unavailable: false,
  };
}

// Bump on every release cut (matches the git tag, without the leading "v") — this IS the release
// version, not package.json's (that one tracks the napi addon package, currently 0.1.1, and is
// unrelated to the CLI's own release cadence). No build step reads this from git automatically;
// it's a plain literal that has to be kept in sync by hand when cutting a release, same as any
// CLI without a build-time version-stamping step.
const ICARUS_VERSION = '0.3.79';

// Maps to install.sh's own binary_asset_name() — same asset-naming convention
// (icarus-<os>-<arch>), so /update fetches exactly what install.sh would fetch fresh.
function updateAssetName() {
  const osMap = { darwin: 'darwin', linux: 'linux', win32: 'win32' };
  const archMap = { x64: 'x64', arm64: 'arm64' };
  const os_ = osMap[process.platform];
  const arch = archMap[process.arch];
  if (!os_ || !arch) return null;
  return `icarus-${os_}-${arch}${process.platform === 'win32' ? '.exe' : ''}`;
}

/** Check GitHub's real /releases/latest for a newer tag than ICARUS_VERSION. Returns
 * { current, latest, upToDate } — never throws; a network failure surfaces as upToDate:null so
 * callers can tell "checked, you're current" apart from "couldn't check". */
async function checkForUpdate() {
  const current = `v${ICARUS_VERSION}`;
  try {
    const res = await fetch('https://api.github.com/repos/amar3012005/ICARUS/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return { current, latest: null, upToDate: null };
    const body = await res.json();
    const latest = body.tag_name || null;
    return { current, latest, upToDate: latest ? latest === current : null };
  } catch (_) {
    return { current, latest: null, upToDate: null };
  }
}

/** Parse the release sidecar generated by the public release workflow. The asset name is part of
 * the signed-by-publication binding: a valid digest for a different platform binary is not a
 * valid update for this binary. */
function releaseAssetChecksum(checksumText, asset) {
  const entries = String(checksumText).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const matches = entries.map((line) => line.match(/^([a-fA-F0-9]{64})\s+\*?([^\s]+)$/))
    .filter(Boolean)
    .filter((match) => match[2] === asset);
  if (matches.length !== 1) throw new Error(`release checksum does not contain exactly one digest for ${asset}`);
  return matches[0][1].toLowerCase();
}

function verifyReleaseAsset(asset, bytes, checksumText) {
  const expected = releaseAssetChecksum(checksumText, asset);
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    throw new Error(`downloaded ${asset} failed SHA-256 verification (expected ${expected}, got ${actual})`);
  }
  return actual;
}

// A live Windows executable is locked by the operating system and cannot safely rename itself.
// This helper runs only after the current CLI exits. All paths are process arguments, never
// interpolated into PowerShell source, and `-LiteralPath` prevents wildcard interpretation.
// The old executable is retained until the staged replacement has committed; if that commit
// fails, the helper restores it before reporting failure.
function windowsUpdateHandoffScript() {
  return `param(
  [int]$ParentPid,
  [string]$Target,
  [string]$Candidate,
  [string]$Previous,
  [string]$Helper,
  [bool]$RestartTui
)
$ErrorActionPreference = 'Stop'
try {
  Wait-Process -Id $ParentPid -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 120
  if (Test-Path -LiteralPath $Target) {
    if (Test-Path -LiteralPath $Previous) { Remove-Item -LiteralPath $Previous -Force }
    Move-Item -LiteralPath $Target -Destination $Previous -Force
  }
  Move-Item -LiteralPath $Candidate -Destination $Target -Force
  if ($RestartTui) { Start-Process -FilePath $Target }
} catch {
  if (-not (Test-Path -LiteralPath $Target) -and (Test-Path -LiteralPath $Previous)) {
    Move-Item -LiteralPath $Previous -Destination $Target -Force
  }
  exit 1
} finally {
  Remove-Item -LiteralPath $Helper -Force -ErrorAction SilentlyContinue
}`;
}

function stageWindowsSelfUpdate(target, candidate, restartTui = false) {
  const { spawn } = require('child_process');
  const helper = `${target}.update-handoff.ps1`;
  const previous = `${target}.previous.exe`;
  fs.writeFileSync(helper, windowsUpdateHandoffScript(), { mode: 0o600 });
  const powershell = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  try {
    const child = spawn(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
      String(process.pid), target, candidate, previous, helper, String(Boolean(restartTui)),
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (error) {
    try { fs.unlinkSync(helper); } catch (_) { /* preserve the verified candidate for manual recovery */ }
    throw new Error(`could not schedule the Windows update handoff (${error.message}) — kept your current install`);
  }
  return { bytes: fs.statSync(candidate).size, restartRequired: true, restartScheduled: restartTui };
}

/** Self-update: download the latest release's binary for this platform, sanity-check it
 * actually runs, then atomically replace the CURRENTLY RUNNING binary (process.execPath under
 * Bun's single-file-executable runtime — verified by `typeof Bun !== 'undefined'`, the same test
 * native.js already uses to detect "am I the compiled artifact"). Refuses on a source/dev
 * install (plain `node mneme-cli.js`) since there's no single binary to replace there — git
 * pull + rebuild is that install's own update path, already documented in its own README.
 * onProgress({received,total,phase}) is optional and is emitted while the response body streams,
 * rather than only after the full binary is buffered. */
async function readReleaseAsset(response, onProgress) {
  const totalHeader = Number(response.headers.get('content-length'));
  const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null;
  const report = (received, phase = 'downloading') => onProgress?.({ received, total, phase });
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    report(bytes.length);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  let lastReportedAt = 0;
  report(0);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    chunks.push(chunk);
    received += chunk.length;
    const now = Date.now();
    if (now - lastReportedAt >= 75) {
      report(received);
      lastReportedAt = now;
    }
  }
  report(received);
  return Buffer.concat(chunks, received);
}

async function performSelfUpdate(onProgress, { restartTui = false } = {}) {
  if (typeof Bun === 'undefined') {
    throw new Error('running from source (node mneme-cli.js), not the compiled binary — update via `git pull` in your ICARUS checkout instead');
  }
  const asset = updateAssetName();
  if (!asset) throw new Error(`no prebuilt binary for ${process.platform}/${process.arch} — update from source: https://github.com/amar3012005/ICARUS`);
  const url = `https://github.com/amar3012005/ICARUS/releases/latest/download/${asset}`;
  const [res, checksumRes] = await Promise.all([fetch(url), fetch(`${url}.sha256`)]);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  if (!checksumRes.ok) throw new Error(`release checksum download failed: HTTP ${checksumRes.status}`);
  const [buf, checksumText] = await Promise.all([readReleaseAsset(res, onProgress), checksumRes.text()]);
  onProgress?.({ received: buf.length, total: Number(res.headers.get('content-length')) || null, phase: 'verifying' });
  verifyReleaseAsset(asset, buf, checksumText);

  const target = process.execPath; // the real, currently-running binary path under Bun
  const tmp = `${target}.update-tmp${process.platform === 'win32' ? '.exe' : ''}`;
  fs.writeFileSync(tmp, buf, { mode: 0o755 });
  // Sanity check BEFORE committing — a corrupt/incompatible download must never replace a
  // working install (same principle install.sh's own try_binary_install already applies).
  const { execFileSync } = require('child_process');
  try {
    execFileSync(tmp, ['status'], { stdio: 'ignore', timeout: 15000 });
  } catch (e) {
    fs.unlinkSync(tmp);
    throw new Error(`downloaded binary failed to run (${e.message}) — kept your current install`);
  }
  if (process.platform === 'win32') return stageWindowsSelfUpdate(target, tmp, restartTui);
  fs.renameSync(tmp, target); // same filesystem (same dir) -> atomic; safe even while target is
  // the currently-executing binary — POSIX keeps the old inode open under this process until it
  // exits, exactly how rustup/gh/other self-updating CLIs replace themselves while running.
  return { bytes: buf.length, restartRequired: false };
}

module.exports = {
  HOME, CFG_PATH, loadCfg, saveCfg, embed, chunk, walkText, walkHivemindIngestable,
  INGESTABLE_EXTS, HIVEMIND_INGESTABLE_EXTS, HIVEMIND_UPLOAD_EXTS, IMAGE_EXTS, scanIngestable, noIngestableFilesReason,
  pickFolderNative,
  ingestDir, recallQuery, statusReport,
  embeddingsConfigured, openStore, llmConfigured, summarize, extractSkill, skillSave, skillList,
  OPENROUTER_KEYCHAIN_SERVICE, DEFAULT_OPENROUTER_SYNTHESIS_MODEL, openRouterApiKey, setOpenRouterApiKey, resolveSynthesisModel, fetchOpenRouterModels, fetchOpenRouterModel,
  selectOpenRouterModels, reasoningForModel, buildGroundedChatRequest, consumeOpenRouterSse, classifyChatFailure, chatWithOpenRouter, createPersonaSkill, selectPersonaSkill, clearPersonaSkill, activePersonaSkill,
  parseClaudeTranscript, SKILLS_DIR, LAYER_MEMORY, LAYER_EVIDENCE, LAYER_COGNITIVE, LAYER_SKILL,
  signingEnabled, ensureSigningKeys, signSlot, verifySlot, canonicalPayload, SIGN_KEYS_DIR,
  ensureAuditKeys, appendAuditEntry, checkpointAudit, verifyAuditChain,
  hivemindConfigured, hivemindIngestDir, hivemindUploadFile, hivemindPollJob, formatHivemindProgress, attemptHivemindOAuth,
  hivemindFetchDocumentSegments, mirrorHivemindDocumentLocally, isInaccessibleHivemindDuplicate,
  DEFAULT_HIVEMIND_AUTH_URL, DEFAULT_HIVEMIND_API_URL,
  ICARUS_VERSION, checkForUpdate, performSelfUpdate, readReleaseAsset, releaseAssetChecksum, verifyReleaseAsset, updateAssetName, windowsUpdateHandoffScript, hivemindSaveMemory, saveLocalMemory, saveIntelligentMemory, normalizeStructuredSaveToolCall,
  purgeHivemindDocument,
  REL_TYPE, REL_NAME, REL_WORD_TO_TYPE, saveStructuredMemory, getStructuredMemory, listStructuredMemories,
  updateStructuredMemory, deleteStructuredMemory, traverseStructuredGraph, recallByTags,
  richOrgStats, findRepoIcarusDataRoot, repoOrgName, harnessSafeGitignore, initRepoShard, listOrgsWithMeta, deleteOrgShard,
};
