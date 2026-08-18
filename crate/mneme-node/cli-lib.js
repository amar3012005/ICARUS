'use strict';
// Shared logic between mneme-cli.js and mcp-serve.js — config, embeddings, ingest/recall
// primitives. Extracted specifically so the CLI and the MCP server call the SAME code, not two
// copies that can silently drift apart (the exact class of bug the flag-parsing regression
// earlier in this repo's history was — one path fixed, the other forgotten).
const fs = require('fs');
const path = require('path');
const os = require('os');
// Lazy: some callers of this module (icarus mcp install, icarus status) never touch a shard,
// so they must not be forced to load the native addon just because this file was required.
function getMnemeStore() { return require('./index.js').MnemeStore; }

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

function walkText(dir) {
  const exts = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.log']);
  const files = [];
  (function rec(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p);
      else if (exts.has(path.extname(e.name).toLowerCase())) files.push(p);
    }
  })(dir);
  return files;
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
  const zero = new Float32Array(cfg.dim); // BM25 needs no vector; a placeholder keeps every
                                           // slot's dim consistent so a later `connect-embeddings`
                                           // + re-ingest doesn't hit a dimension mismatch.
  let n = 0;
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
          store.insert(`${path.basename(f)}\n${t}`, vecs[j], 0);
          n++;
        });
      }
    } else {
      for (const t of chunks) {
        store.insert(`${path.basename(f)}\n${t}`, zero, 0);
        n++;
      }
    }
    if (onProgress) onProgress(n);
  }
  if (vectorMode) store.enableHnsw();
  store.flush();
  return {
    files: files.length, chunks: n, live: store.liveCount(),
    mode: vectorMode ? 'vector' : 'lexical', distilled: distillMode,
  };
}

/** Recall `topK` memories for `query` in `org`. `usePq` requires trainPq() to have run first
 * AND an embedding provider configured (PQ trains on real vectors, no way around that). With
 * no embedding provider configured and usePq not requested, transparently falls back to BM25
 * lexical search — the engine is still fully usable, just not semantic. */
async function recallQuery(query, org, cfg, topK = 5, usePq = false) {
  const store = openStore(cfg, org);
  const vectorMode = embeddingsConfigured(cfg);
  if (usePq && !vectorMode) {
    throw new Error('usePq requires an embedding provider — run `icarus connect-embeddings` first (PQ trains on real vectors)');
  }
  if (!vectorMode) {
    const hits = store.bm25Search(query, topK);
    return hits.map((h) => ({ score: h.score, text: h.text, mode: 'lexical' }));
  }
  if (usePq && !store.pqTrained()) {
    throw new Error(`no PQ codebook trained for org "${org}" yet — run train_pq first`);
  }
  const [qv] = await embed([query], cfg);
  let hits;
  if (usePq) {
    hits = store.recallPq(qv, topK);
  } else {
    store.enableHnsw();
    hits = store.recall(qv, topK);
  }
  return hits.map((h) => ({ score: h.score, text: h.text, mode: 'vector' }));
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

module.exports = {
  HOME, CFG_PATH, loadCfg, saveCfg, embed, chunk, walkText, ingestDir, recallQuery, statusReport,
  embeddingsConfigured, openStore, llmConfigured, summarize, extractSkill, skillSave, skillList,
  SKILLS_DIR, LAYER_MEMORY, LAYER_EVIDENCE, LAYER_COGNITIVE, LAYER_SKILL,
};
