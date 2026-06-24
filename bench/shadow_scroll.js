// Read-only scroll of one Qdrant collection's vectors + ids (NO payload) to stdout as jsonl.
// Runs INSIDE hm-core (docker network) via: ssh box 'docker exec -i hm-core node -' < this > out.jsonl
const http = require('http');
const KEY = process.env.QDRANT_API_KEY;
const COLL = process.env.COLL;

function scroll(body) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const r = http.request(
      {
        host: 'hm-qdrant',
        port: 6333,
        path: `/collections/${COLL}/points/scroll`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': KEY, 'Content-Length': Buffer.byteLength(data) },
      },
      (resp) => {
        let b = '';
        resp.on('data', (c) => (b += c));
        resp.on('end', () => res(JSON.parse(b)));
      }
    );
    r.on('error', rej);
    r.write(data);
    r.end();
  });
}

(async () => {
  let offset = null;
  let total = 0;
  for (;;) {
    const body = { limit: 1000, with_vector: true, with_payload: false };
    if (offset) body.offset = offset;
    const j = await scroll(body);
    if (!j.result || !j.result.points) {
      process.stderr.write('ERR ' + JSON.stringify(j).slice(0, 300) + '\n');
      break;
    }
    for (const p of j.result.points) {
      process.stdout.write(JSON.stringify({ id: p.id, vector: p.vector }) + '\n');
      total++;
    }
    offset = j.result.next_page_offset;
    if (!offset || j.result.points.length === 0) break;
  }
  process.stderr.write(`scrolled ${total} points from ${COLL}\n`);
})();
