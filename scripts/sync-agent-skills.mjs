#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const g = require('../crate/mneme-node/agent-guidance.js');
const files = {
  'skills/icarus-agent-memory/SKILL.md': g.mainSkill(),
  ...Object.fromEntries(Object.entries(g.referenceFiles()).map(([p, v]) => [`skills/icarus-agent-memory/${p}`, v])),
  'skills/icarus-coding-memory/SKILL.md': g.codingSkill(),
  'skills/icarus-memory-history/SKILL.md': g.historySkill(),
};
let drift = false;
for (const [p, body] of Object.entries(files)) {
  const target = join(root, p);
  let previous; try { previous = readFileSync(target, 'utf8'); } catch { /* missing bundle */ }
  if (previous === body) continue;
  if (process.argv.includes('--check')) { console.error(`Skill bundle drift: ${p}`); drift = true; }
  else { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, body); }
}
if (drift) process.exitCode = 1;
