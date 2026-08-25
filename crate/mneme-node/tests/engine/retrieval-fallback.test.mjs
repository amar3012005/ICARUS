// Native regression coverage for the availability contract: remote embedding and reranking are
// quality enhancements only. A broken provider must neither lose ingested evidence nor make a
// local recall return an error-shaped result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ingestDir, openStore, recallQuery } = require('../../cli-lib.js');

test('remote embedding and reranking outages preserve local lexical ingest and recall', async () => {
  const root = mkdtempSync(join(tmpdir(), 'icarus-retrieval-fallback-'));
  const docs = join(root, 'docs');
  const originalFetch = global.fetch;
  try {
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, 'solvis.md'), 'SOLVIS develops heating systems and thermal-energy technology.');
    global.fetch = async (_url, options = {}) => new Promise((_, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('synthetic provider timeout')), { once: true });
    });
    const cfg = {
      dataRoot: join(root, 'data'), dim: 1024,
      embeddings: { disabled: false, endpoint: 'https://embed.invalid', model: 'bge-m3', apiKey: 'broken', timeoutMs: 20 },
      llm: { disabled: true }, signing: { disabled: true },
      hivemind: { connected: true, token: 'test', apiUrl: 'https://core.invalid' },
    };

    // Native shard creation is intentionally outside the remote-provider latency assertion.
    // The product operation pays that one local open cost; this checks that the dead provider
    // itself is bounded instead of inheriting fetch's unbounded network wait.
    openStore(cfg, 'default');
    const startedAt = Date.now();
    const ingested = await ingestDir(docs, 'default', cfg);
    assert.ok(Date.now() - startedAt < 500, 'a dead provider must time out once, not use the platform fetch timeout');
    assert.equal(ingested.files, 1);
    assert.equal(ingested.chunks, 1, 'the source chunk must persist despite the embedding outage');
    assert.equal(ingested.mode, 'lexical');
    assert.match(openStore(cfg, 'default').bm25Search('solvis thermal energy', 5)[0].text, /SOLVIS/i);

    const hits = await recallQuery('what is solvis', 'default', cfg, 5);
    assert.ok(hits.some((hit) => /SOLVIS/i.test(hit.text)), `local lexical fallback lost evidence: ${JSON.stringify(hits)}`);
    assert.equal(hits[0].mode, 'lexical');
    assert.ok(hits.every((hit) => !Object.hasOwn(hit, 'rerankFailed') && !Object.hasOwn(hit, 'rerankError')),
      'provider failure details must not be returned as user-facing recall state');
  } finally {
    global.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
