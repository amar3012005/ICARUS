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
function openStore(cfg, org) {
  const key = `${cfg.dataRoot}::${org}`;
  let store = _storeCache.get(key);
  if (!store) {
    store = getMnemeStore().open(cfg.dataRoot, org, cfg.dim);
    _storeCache.set(key, store);
  }
  return store;
}

const HOME = process.env.ICARUS_HOME || process.env.MNEME_HOME || path.join(os.homedir(), '.icarus');
const CFG_PATH = path.join(HOME, 'config.json');

// The shard's native `layer` field is a plain u8 with 3 conventional values already in use
// (see mneme-node/src/lib.rs's insert_layered/recall_layer doc comments) — HIVEMIND's own
// memory/evidence/cognitive split. LAYER_SKILL is a 4th convention, Node-side only: no Rust
// change was needed to add it, since the field was never a closed enum, just documented as one.
const LAYER_MEMORY = 0;
const LAYER_EVIDENCE = 1;
const LAYER_COGNITIVE = 2;
const LAYER_SKILL = 3;
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
 * insert into a failed one. */
function appendAuditEntry(cfg, org, event, slotId) {
  try {
    const p = auditChainPath(cfg, org);
    const entries = readJsonl(p);
    const prevHash = entries.length ? entries[entries.length - 1].hash : GENESIS_HASH;
    const seq = entries.length;
    const at = new Date().toISOString();
    const hash = crypto.createHash('sha256').update(entryHashInput(prevHash, seq, event, slotId, at)).digest('hex');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({ seq, event, slot_id: slotId, prev_hash: prevHash, hash, at }) + '\n');
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

function loadCfg() {
  try {
    return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  } catch (_) {
    return {
      dataRoot: path.join(HOME, 'data'),
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
  fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
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
  return !!(cfg.llm?.apiKey || process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY);
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
    const orKey = cfg.llm?.apiKey || process.env.OPENROUTER_API_KEY;
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
    store.insertLayered(md, zero, 0, LAYER_SKILL);
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
  const res = await fetch(`${cfg.embeddings.endpoint}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: cfg.embeddings.model, input: texts, encoding_format: 'float' }),
  });
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
  const words = text.split(/\s+/);
  const out = [];
  for (let i = 0; i < words.length; i += size) out.push(words.slice(i, i + size).join(' '));
  return out.filter((c) => c.trim().length > 20);
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

function walkFiles(dir, extSet) {
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
 * which mode was used — `vector` when an embedding provider is configured, `lexical` when not
 * (BM25-only: text is stored and searchable, just not semantically). Never errors out just
 * because no embedding provider exists; it degrades, it doesn't refuse. */
async function ingestDir(dir, org, cfg, onProgress) {
  const store = openStore(cfg, org);
  const files = walkText(dir);
  const vectorMode = embeddingsConfigured(cfg);
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
    if (vectorMode) {
      for (let i = 0; i < chunks.length; i += 16) {
        const batch = chunks.slice(i, i + 16);
        const vecs = await embed(batch, cfg);
        batch.forEach((t, j) => {
          const text = `${path.basename(f)}\n${t}`;
          const slotId = store.insert(text, vecs[j], 0);
          if (signMode && signSlot(slotId, text, cfg, org)) signed++;
          appendAuditEntry(cfg, org, 'insert', slotId);
          n++;
        });
      }
    } else {
      for (const t of chunks) {
        const text = `${path.basename(f)}\n${t}`;
        const slotId = store.insert(text, zero, 0);
        if (signMode && signSlot(slotId, text, cfg, org)) signed++;
        appendAuditEntry(cfg, org, 'insert', slotId);
        n++;
      }
    }
    if (onProgress) onProgress(n);
  }
  if (vectorMode) store.enableHnsw();
  store.flush();
  return {
    files: files.length, chunks: n, live: store.liveCount(),
    mode: vectorMode ? 'vector' : 'lexical', distilled: distillMode, signed,
  };
}

/** Recall `topK` memories for `query` in `org`. `usePq` requires trainPq() to have run first
 * AND an embedding provider configured (PQ trains on real vectors, no way around that). With
 * no embedding provider configured and usePq not requested, transparently falls back to BM25
 * lexical search — the engine is still fully usable, just not semantic. */
async function recallQuery(query, org, cfg, topK = 5, usePq = false) {
  const store = openStore(cfg, org);
  const hasOwnEmbeddings = embeddingsConfigured(cfg);
  // PQ specifically requires the user's OWN provider — the codebook was trained on cfg.embeddings'
  // own vector space (train_pq itself requires embeddingsConfigured(cfg)), so query vectors for a
  // PQ search must come from that exact same space, not HIVEMIND's free fallback below.
  if (usePq && !hasOwnEmbeddings) {
    throw new Error('usePq requires an embedding provider — run `icarus connect-embeddings` first (PQ trains on real vectors)');
  }
  // Real vector-space parity, same reasoning as mirrorHivemindDocumentLocally(): HIVEMIND's own
  // free embeddings.singulancelabs.com service (confirmed live, unauthenticated, real bge-m3
  // 1024-dim vectors) is a real fallback for the QUERY side too when the user has no own
  // provider configured but IS connected — without this, vectors written by the mirror path
  // above would sit in the shard unreachable, since a query embedded via plain BM25 can't do a
  // vector-space HNSW search at all.
  const canEmbedQuery = hasOwnEmbeddings || hivemindConfigured(cfg);
  if (!canEmbedQuery) {
    const hits = store.bm25Search(query, topK);
    return hits.map((h) => ({ score: h.score, text: h.text, mode: 'lexical' }));
  }
  if (usePq && !store.pqTrained()) {
    throw new Error(`no PQ codebook trained for org "${org}" yet — run train_pq first`);
  }
  let qv;
  try {
    [qv] = hasOwnEmbeddings ? await embed([query], cfg) : await embedViaHivemindService([query]);
  } catch (e) {
    // Query embedding failed (network hiccup, etc.) — degrade to lexical rather than erroring;
    // the shard may hold a mix of real vectors and zero-vector/lexical-only slots anyway.
    const hits = store.bm25Search(query, topK);
    return hits.map((h) => ({ score: h.score, text: h.text, mode: 'lexical' }));
  }
  let hits;
  if (usePq) {
    hits = store.recallPq(qv, topK);
  } else {
    store.enableHnsw();
    hits = store.recall(qv, topK);
  }
  return hits.map((h) => ({ score: h.score, text: h.text, mode: 'vector' }));
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

// Matches the REAL fields the real FE sends — frontend/Da-vinci's api-client.js `uploadDocument()`
// (file, tags, containerTag, targetScope, force, async) — verified by reading that file directly,
// not the docs page. A real, materially different finding from what ICARUS shipped with earlier
// this cycle: `ingestMode` (evidence-vs-full, ICARUS's own --full flag) was NEVER read anywhere
// in core/src/ for this multipart upload path — a fabricated field that did nothing server-side,
// the whole time. The real pipeline (core/src/knowledge/kb-ingest-queue.js) always attempts full
// ingestion; "evidence-only" is a server-computed OUTCOME label (promoted===0 && segments>0), not
// a request parameter — there is no way to ask for evidence-only via this endpoint today. `force`
// (bypass the same-checksum dedup gate) IS a real field the FE sends, but routes/knowledge.js's
// handleKnowledgeUploadRoute never reads it either — sent here to match the real contract exactly
// (so this starts working the moment the server wires it up, zero client changes needed), but
// don't rely on it actually bypassing dedup today; it doesn't.
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

async function hivemindUploadFile(filePath, org, cfg, { force = false } = {}) {
  const base = hivemindApiBase(cfg);
  const buf = fs.readFileSync(filePath);
  const mime = UPLOAD_MIME_BY_EXT[path.extname(filePath).toLowerCase()];
  const form = new FormData();
  form.append('file', new Blob([buf], mime ? { type: mime } : undefined), path.basename(filePath));
  form.append('targetScope', 'personal');
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

async function hivemindPollJob(jobId, cfg, { intervalMs = 1000, maxAttempts = 60 } = {}) {
  const base = hivemindApiBase(cfg);
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(`${base}/api/knowledge/status?job_id=${jobId}`, {
      headers: { Authorization: `Bearer ${cfg.hivemind.token}` },
    });
    if (!res.ok) throw new Error(`HIVEMIND status ${res.status}: ${await res.text()}`);
    const body = await res.json();
    if (body.status === 'ready' || body.status === 'failed') return body;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`HIVEMIND job ${jobId} did not finish within ${(maxAttempts * intervalMs) / 1000}s — check later with the job_id above`);
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

async function embedViaHivemindService(texts) {
  const res = await fetch(HIVEMIND_EMBEDDINGS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'bge-m3', input: texts }),
  });
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
    const slotId = store.insertLayered(text, vec, 0, LAYER_EVIDENCE);
    if (signMode) signSlot(slotId, text, cfg, org);
    appendAuditEntry(cfg, org, 'insert', slotId);
    stored++;
  };
  // Prefer the user's OWN configured provider if they set one up (respect their explicit choice
  // — e.g. a self-hosted LiteLLM gateway). Otherwise, since HIVEMIND is connected anyway, use its
  // free embeddings service instead of degrading straight to lexical-only zero-vectors — a real
  // improvement: anyone connected to HIVEMIND without their own OpenRouter key still gets real
  // semantic vectors locally, not just BM25. Falls back to lexical-only per-batch (not aborting
  // the whole mirror) if even the free service errors — network hiccups shouldn't lose the text.
  const hasOwnEmbeddings = embeddingsConfigured(cfg);
  let usedVectors = false;
  for (let i = 0; i < texts.length; i += 16) {
    const batch = texts.slice(i, i + 16);
    try {
      const vecs = hasOwnEmbeddings ? await embed(batch, cfg) : await embedViaHivemindService(batch);
      batch.forEach((text, j) => insertOne(text, vecs[j]));
      usedVectors = true;
    } catch (e) {
      console.error(`icarus: local embedding failed for a batch of ${sourceLabel} — ${e.message} — storing lexical-only`);
      batch.forEach((text) => insertOne(text, zero));
    }
  }
  if (usedVectors) store.enableHnsw();
  store.flush();
  return stored;
}

/** Upload every file under `dir` to HIVEMIND (real REST API, async job per file) instead of the
 * local engine. Returns the same shape ingestDir() does, so callers (CLI/MCP) don't need to know
 * which path ran. `files`/`chunks`/`live` come from HIVEMIND's own per-job counts, not invented
 * locally — a real report of what its server actually did, not an assumption. */
async function hivemindIngestDir(dir, org, cfg, onProgress, opts = {}) {
  const files = walkHivemindIngestable(dir);
  const mirrorLocal = opts.mirrorLocal !== false; // default ON — see mirrorHivemindDocumentLocally's doc comment
  let totalMemories = 0;
  let totalSegments = 0;
  let duplicates = 0;
  let pending = 0; // uploaded, still processing past the poll window — not a failure
  let failed = 0; // genuinely errored (network blip, 5xx, etc.) — logged, batch keeps going
  let mirrored = 0; // segments actually written into the local .amr shard this run
  let n = 0;
  // The WHOLE per-file body is wrapped, not just the poll — a real bug, same class as the
  // 409-duplicate one this function already guards against but caught SEPARATELY, live: a
  // transient 502 from hivemindUploadFile on file #9 of a real 55-file batch was left
  // unguarded, aborting files #10-55 outright. Nothing in this loop may ever let ONE file's
  // failure — upload error, poll timeout, transient 5xx — kill the rest of the batch; that's
  // the whole point of iterating a folder instead of hand-calling upload once per file.
  for (const f of files) {
    try {
      const job = await hivemindUploadFile(f, org, cfg, opts);
      if (job.duplicate) {
        duplicates++; // already ingested server-side — a skip, not a failure
        // Still worth mirroring locally: "already in your knowledge base" describes the SERVER,
        // not this machine — the exact real gap this feature exists to close (a file dedup'd
        // from an earlier session/machine, but this shard has never seen it).
        if (mirrorLocal && job.existingDocumentId) {
          try { mirrored += await mirrorHivemindDocumentLocally(job.existingDocumentId, path.basename(f), org, cfg); }
          catch (e) { console.error(`icarus: local mirror failed for ${path.basename(f)} — ${e.message}`); }
        }
      } else {
        let result;
        try {
          result = await hivemindPollJob(job.job_id, cfg);
        } catch (e) {
          // Poll window (60s default) elapsed — a real, legitimate outcome for OCR/vision
          // extraction on a large PDF/PPTX, not an error. The upload already succeeded
          // server-side; only the CLI's wait-and-report gave up, the job keeps running.
          console.error(`icarus: ${path.basename(f)} still processing past the wait window — ${e.message}`);
          pending++;
          n++;
          if (onProgress) onProgress(n);
          continue;
        }
        if (result.status === 'failed') {
          console.error(`icarus: HIVEMIND ingest failed for ${f} — ${result.error || 'unknown error'}`);
          failed++;
        } else {
          totalMemories += result.counts?.memories || 0;
          totalSegments += result.counts?.segments || 0;
          if (mirrorLocal && result.document_id) {
            try { mirrored += await mirrorHivemindDocumentLocally(result.document_id, path.basename(f), org, cfg); }
            catch (e) { console.error(`icarus: local mirror failed for ${path.basename(f)} — ${e.message}`); }
          }
        }
      }
    } catch (e) {
      console.error(`icarus: ${path.basename(f)} — ${e.message}`);
      failed++;
    }
    n++;
    if (onProgress) onProgress(n);
  }
  return {
    files: files.length, chunks: totalSegments || totalMemories, live: totalMemories,
    // `distilled` reflects what the server actually did (memories > 0), not a request flag —
    // there's no real way to ask for "full" vs "evidence-only" on this endpoint (see
    // hivemindUploadFile's own doc comment).
    mode: 'hivemind', distilled: totalMemories > 0, signed: 0, duplicates, pending, failed, mirrored,
  };
}

/** Recall against HIVEMIND's real /api/recall — one hybrid engine (dense + lexical + entity +
 * temporal + graph lanes, fused server-side), not a local mode choice. See this module's header
 * comment for the honest caveat: not verified to be org-scoped server-side yet. */
async function hivemindRecallQuery(query, org, cfg, topK = 5) {
  const base = hivemindApiBase(cfg);
  const res = await fetch(`${base}/api/recall`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.hivemind.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, mode: 'quick', limit: topK }),
  });
  if (!res.ok) throw new Error(`HIVEMIND recall ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const memories = (body.memories || []).map((m) => ({ score: m.score, text: m.content, mode: 'hivemind-memory' }));
  const evidence = (body.evidence || []).map((e) => ({ score: e.score, text: e.snippet, mode: 'hivemind-evidence' }));
  return [...memories, ...evidence].sort((a, b) => b.score - a.score).slice(0, topK);
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
        try { bytes += fs.statSync(path.join(dir, f)).size; } catch (_) { /* race with a concurrent writer */ }
      }
      return { org: o.name, bytesOnDisk: bytes };
    }),
  };
}

// Bump on every release cut (matches the git tag, without the leading "v") — this IS the release
// version, not package.json's (that one tracks the napi addon package, currently 0.1.1, and is
// unrelated to the CLI's own release cadence). No build step reads this from git automatically;
// it's a plain literal that has to be kept in sync by hand when cutting a release, same as any
// CLI without a build-time version-stamping step.
const ICARUS_VERSION = '0.3.12';

// Maps to install.sh's own binary_asset_name() — same asset-naming convention
// (icarus-<os>-<arch>), so /update fetches exactly what install.sh would fetch fresh.
function updateAssetName() {
  const osMap = { darwin: 'darwin', linux: 'linux' };
  const archMap = { x64: 'x64', arm64: 'arm64' };
  const os_ = osMap[process.platform];
  const arch = archMap[process.arch];
  if (!os_ || !arch) return null; // Windows/other: no prebuilt binary yet, same as install.sh
  return `icarus-${os_}-${arch}`;
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

/** Self-update: download the latest release's binary for this platform, sanity-check it
 * actually runs, then atomically replace the CURRENTLY RUNNING binary (process.execPath under
 * Bun's single-file-executable runtime — verified by `typeof Bun !== 'undefined'`, the same test
 * native.js already uses to detect "am I the compiled artifact"). Refuses on a source/dev
 * install (plain `node mneme-cli.js`) since there's no single binary to replace there — git
 * pull + rebuild is that install's own update path, already documented in its own README.
 * onProgress(bytesDownloaded) is optional, for a progress indicator. */
async function performSelfUpdate(onProgress) {
  if (typeof Bun === 'undefined') {
    throw new Error('running from source (node mneme-cli.js), not the compiled binary — update via `git pull` in your ICARUS checkout instead');
  }
  const asset = updateAssetName();
  if (!asset) throw new Error(`no prebuilt binary for ${process.platform}/${process.arch} — update from source: https://github.com/amar3012005/ICARUS`);
  const url = `https://github.com/amar3012005/ICARUS/releases/latest/download/${asset}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (onProgress) onProgress(buf.length);

  const target = process.execPath; // the real, currently-running binary path under Bun
  const tmp = `${target}.update-tmp`;
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
  fs.renameSync(tmp, target); // same filesystem (same dir) -> atomic; safe even while target is
  // the currently-executing binary — POSIX keeps the old inode open under this process until it
  // exits, exactly how rustup/gh/other self-updating CLIs replace themselves while running.
  return buf.length;
}

module.exports = {
  HOME, CFG_PATH, loadCfg, saveCfg, embed, chunk, walkText, walkHivemindIngestable,
  INGESTABLE_EXTS, HIVEMIND_INGESTABLE_EXTS, scanIngestable, noIngestableFilesReason,
  ingestDir, recallQuery, statusReport,
  embeddingsConfigured, openStore, llmConfigured, summarize, extractSkill, skillSave, skillList,
  parseClaudeTranscript, SKILLS_DIR, LAYER_MEMORY, LAYER_EVIDENCE, LAYER_COGNITIVE, LAYER_SKILL,
  signingEnabled, ensureSigningKeys, signSlot, verifySlot, canonicalPayload, SIGN_KEYS_DIR,
  ensureAuditKeys, appendAuditEntry, checkpointAudit, verifyAuditChain,
  hivemindConfigured, hivemindIngestDir, hivemindRecallQuery, attemptHivemindOAuth,
  hivemindFetchDocumentSegments, mirrorHivemindDocumentLocally,
  DEFAULT_HIVEMIND_AUTH_URL, DEFAULT_HIVEMIND_API_URL,
  ICARUS_VERSION, checkForUpdate, performSelfUpdate,
};
