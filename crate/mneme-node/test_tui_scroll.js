'use strict';
const assert = require('assert');
const { transcriptViewport, tuiProgressLine, recordProgressTick, tuiIngestQueueLine, recordIngestQueue, statusCardLines, chatRecallLines, stripAnsi } = require('./tui.js');

const transcript = Array.from({ length: 1200 }, (_, index) => `turn-${index}`);
const tail = transcriptViewport(transcript, { contentH: 8, cols: 80, scrollOffset: 0 });
assert.match(tail.visible.join('\n'), /turn-1199/);
const older = transcriptViewport(transcript, { contentH: 8, cols: 80, scrollOffset: 1100 });
assert.match(older.visible.join('\n'), /turn-9[0-9]/);
assert.ok(older.maxScroll >= 1100);

const progress = tuiProgressLine({
  total: 47, completed: 0, phase: 'processing',
  file: 'SINGULANCE_GLOBIA_PP_Italy_Partner_MoU_Draft.docx',
}, '', 80);
assert.match(progress, /0\/47  extracting/);
assert.match(progress, /SINGULANCE_GLOBIA…raft\.docx/);
assert.doesNotMatch(progress, /docxdocx/);

const progressState = { transcript: [], _pendingPartial: '', _spinnerActive: false };
recordProgressTick(progressState, '\rfirst file · uploading');
recordProgressTick(progressState, '\rsecond file · extracting');
assert.deepStrictEqual(progressState.transcript, ['second file · extracting']);

const statusCard = statusCardLines({ org: 'default', bytesOnDisk: 29_530_000 }, {
  memories: 1, memoriesLatest: 1, evidenceAndOther: 1258, relationships: 0,
}).map(stripAnsi).join('\n');
assert.match(statusCard, /default.*29\.53 MB/);
assert.match(statusCard, /MEMORY\s+1.*EVIDENCE\s+1258.*RELATIONS\s+0/);
assert.doesNotMatch(statusCard, /not tracked locally/);

const queueState = { transcript: [], _ingestQueue: null };
recordIngestQueue(queueState, { total: 2, completed: 0, current: 1, phase: 'uploading', file: 'first.pdf' }, '⠋', 100);
recordIngestQueue(queueState, { total: 2, completed: 1, current: 1, phase: 'complete', file: 'first.pdf' }, '⠙', 100);
recordIngestQueue(queueState, { total: 2, completed: 1, current: 2, phase: 'processing', file: 'second.pdf' }, '⠹', 100);
assert.strictEqual(queueState.transcript.length, 2);
assert.match(stripAnsi(queueState.transcript[0]), /✓.*1\/2.*complete.*first\.pdf/);
assert.match(stripAnsi(queueState.transcript[1]), /2\/2.*extracting.*second\.pdf/);
assert.match(stripAnsi(tuiIngestQueueLine({ total: 1, current: 1, phase: 'complete', file: 'done.pdf' }, '', 100)), /████/);

const recalled = chatRecallLines([
  { score: 0.9, text: 'Kruti is a researcher.' },
  { score: 0.7, text: 'Kruti works on memory systems.' },
], 80).map(stripAnsi).join('\n');
assert.match(recalled, /recalled evidence · 2/);
assert.match(recalled, /\[1\].*0\.9000.*Kruti is a researcher/);
assert.match(recalled, /\[2\].*0\.7000.*Kruti works on memory systems/);
console.log('TUI_SCROLL_OK');
