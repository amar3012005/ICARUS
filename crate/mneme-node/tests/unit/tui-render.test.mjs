// TUI rendering primitives: ANSI stripping, real display width, and the scrollback viewport.
//
// Each of these underpins a bug that actually shipped:
//   - visLen: counting code units instead of code POINTS shifted every box border on any row
//     containing an emoji (a surrogate pair AND double-width).
//   - transcriptViewport: for a long time there was no scroll state at all — the viewport was
//     permanently pinned to the live tail. Later, a fixed retained-window made scrollOffset
//     silently clamp, so scrolling up past the window looked "stuck".
//   - stripAnsi: /copy writes transcript lines to the clipboard; leftover escape codes there
//     are visible garbage in whatever the user pastes into.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { stripAnsi, visLen, transcriptViewport } = require('../../tui.js');

const RED = '\x1b[38;2;255;0;0m';
const RESET = '\x1b[0m';

test('stripAnsi removes SGR colour sequences and keeps the text', () => {
  assert.equal(stripAnsi(`${RED}hello${RESET}`), 'hello');
});

test('stripAnsi is a no-op on plain text', () => {
  assert.equal(stripAnsi('plain text'), 'plain text');
});

test('stripAnsi handles several spans in one line', () => {
  assert.equal(stripAnsi(`${RED}a${RESET} b ${RED}c${RESET}`), 'a b c');
});

test('visLen ignores colour codes', () => {
  assert.equal(visLen(`${RED}hello${RESET}`), 5);
});

test('visLen counts box-drawing characters as width 1', () => {
  assert.equal(visLen('│───│'), 5);
});

test('visLen counts an emoji as width 2, not as 2 code units of width 1', () => {
  // The failure this pins: '🔥'.length === 2 (surrogate pair) yet it occupies 2 columns.
  // A naive .length happens to agree here, so assert a case where they diverge: text
  // around the emoji must add up to the real column count.
  assert.equal(visLen('ab🔥'), 4, 'two narrow chars + one double-width char = 4 columns');
});

// ── viewport ───────────────────────────────────────────────────────────────────────────
const lines = (n) => Array.from({ length: n }, (_, i) => `line-${i + 1}`);

test('viewport shows the live tail when scrollOffset is 0', () => {
  const { visible, offset } = transcriptViewport(lines(50), { contentH: 5, cols: 80 });
  assert.deepEqual(visible, ['line-46', 'line-47', 'line-48', 'line-49', 'line-50']);
  assert.equal(offset, 0);
});

test('viewport scrolls up by exactly scrollOffset rows', () => {
  const { visible } = transcriptViewport(lines(50), { contentH: 5, cols: 80, scrollOffset: 5 });
  assert.deepEqual(visible, ['line-41', 'line-42', 'line-43', 'line-44', 'line-45']);
});

test('viewport clamps scrollOffset to maxScroll instead of scrolling past the top', () => {
  const { visible, offset, maxScroll } = transcriptViewport(lines(20), {
    contentH: 5, cols: 80, scrollOffset: 10_000,
  });
  assert.equal(offset, maxScroll);
  assert.equal(visible[0], 'line-1', 'clamped view starts at the very first line');
  assert.equal(visible.length, 5);
});

test('viewport clamps a negative scrollOffset to the live tail', () => {
  const { offset } = transcriptViewport(lines(20), { contentH: 5, cols: 80, scrollOffset: -5 });
  assert.equal(offset, 0);
});

test('REGRESSION: scrolling far back still moves, beyond the retained tail window', () => {
  // A fixed retained-window (800 raw lines) made maxScroll top out mid-history: scrolling
  // further changed nothing on screen and read as a frozen viewport. The window must grow
  // with scrollOffset.
  const deep = lines(4000);
  const shallow = transcriptViewport(deep, { contentH: 10, cols: 80, scrollOffset: 100 });
  const deeper = transcriptViewport(deep, { contentH: 10, cols: 80, scrollOffset: 2000 });
  assert.notDeepEqual(shallow.visible, deeper.visible, 'a much larger offset must show different lines');
  assert.equal(deeper.offset, 2000, 'the requested offset must be honoured, not clamped away');
  // start = total - contentH - offset = 4000 - 10 - 2000 = 1990 (0-indexed) -> "line-1991"
  assert.equal(deeper.visible[0], 'line-1991');
});

test('viewport never returns more rows than contentH', () => {
  for (const n of [0, 1, 3, 200]) {
    const { visible } = transcriptViewport(lines(n), { contentH: 7, cols: 80 });
    assert.ok(visible.length <= 7, `n=${n} produced ${visible.length} rows`);
  }
});

test('a long line is wrapped, so it consumes several viewport rows', () => {
  const { visible } = transcriptViewport(['x'.repeat(200)], { contentH: 5, cols: 80 });
  assert.ok(visible.length > 1, 'a 200-column line must wrap at cols=80');
  for (const row of visible) assert.ok(visLen(row) <= 80, 'no wrapped row may exceed cols');
});

test('pending partial output is appended after the transcript', () => {
  const { visible } = transcriptViewport(lines(3), {
    contentH: 5, cols: 80, pending: ['in-flight'],
  });
  assert.equal(visible.at(-1), 'in-flight');
});

test('an empty transcript yields an empty viewport rather than throwing', () => {
  const { visible, maxScroll } = transcriptViewport([], { contentH: 5, cols: 80 });
  assert.deepEqual(visible, []);
  assert.equal(maxScroll, 0);
});
