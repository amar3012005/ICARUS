'use strict';
const assert = require('assert');
const { transcriptViewport } = require('./tui.js');

const transcript = Array.from({ length: 1200 }, (_, index) => `turn-${index}`);
const tail = transcriptViewport(transcript, { contentH: 8, cols: 80, scrollOffset: 0 });
assert.match(tail.visible.join('\n'), /turn-1199/);
const older = transcriptViewport(transcript, { contentH: 8, cols: 80, scrollOffset: 1100 });
assert.match(older.visible.join('\n'), /turn-9[0-9]/);
assert.ok(older.maxScroll >= 1100);
console.log('TUI_SCROLL_OK');
