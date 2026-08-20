'use strict';
const assert = require('assert');
const { transcriptViewport, tuiProgressLine, recordProgressTick } = require('./tui.js');

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
console.log('TUI_SCROLL_OK');
