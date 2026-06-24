// Shadow eval (Qdrant side): read queries.jsonl ({qid, vector}), run a read-only top-k search
// against prod Qdrant for each, print {qid, ids, ms} jsonl. Runs INSIDE hm-core.
// Usage: docker exec -e COLL=<coll> hm-core node qs.cjs /tmp/q.jsonl
const fs = require('fs');
const http = require('http');
const KEY = process.env.QDRANT_API_KEY;
const COLL = process.env.COLL;
const K = Number(process.env.K || 10);
const qPath = process.argv[2];

function search(vector) {
  const body = JSON.stringify({ vector, limit: K, with_payload: false });
  return new Promise((res, rej) => {
    const t = process.hrtime.bigint();
    const r = http.request(
      {
        host: 'hm-qdrant',
        port: 6333,
        path: `/collections/${COLL}/points/search`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': KEY, 'Content-Length': Buffer.byteLength(body) },
      },
      (resp) => {
        let b = '';
        resp.on('data', (c) => (b += c));
        resp.on('end', () => {
          const ms = Number(process.hrtime.bigint() - t) / 1e6;
          try {
            const j = JSON.parse(b);
            res({ ids: (j.result || []).map((p) => p.id), ms });
          } catch (e) {
            rej(new Error(b.slice(0, 200)));
          }
        });
      }
    );
    r.on('error', rej);
    r.write(body);
    r.end();
  });
}

(async () => {
  const lines = fs.readFileSync(qPath, 'utf8').split('\n').filter((l) => l.trim());
  for (const line of lines) {
    const o = JSON.parse(line);
    const { ids, ms } = await search(o.vector);
    process.stdout.write(JSON.stringify({ qid: o.qid, ids, ms }) + '\n');
  }
})();
