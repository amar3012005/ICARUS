'use strict';
const assert = require('assert');
const { preserveLexicalAnchors } = require('./cli-lib.js');

const lexical = [{ score: 9, text: 'SOLVIS makes heating systems.' }];
const reranked = [
  { score: 0.9, text: 'An unrelated deployment harness.' },
  { score: 0.8, text: 'Another unrelated document.' },
];
const result = preserveLexicalAnchors('what is solvis', reranked, lexical, 2);
assert.strictEqual(result.length, 2);
assert.strictEqual(result[0].text, 'SOLVIS makes heating systems.');
assert.strictEqual(result[0].lexicalAnchor, true);
console.log('RECALL_ANCHOR_OK');
