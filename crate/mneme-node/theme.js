'use strict';
// icarus CLI color theme — ported from grok-build's `xai-grok-pager` GrokNight palette
// (crates/codegen/xai-grok-pager-render/src/theme/groknight.rs): neutral gray base +
// TokyoNight accent colors. Zero deps — hand-rolled truecolor ANSI (24-bit `38;2;r;g;b`),
// degrading automatically when the terminal can't do color (NO_COLOR, non-TTY, dumb term).
// This ports the PALETTE, not the pager itself — icarus is a one-shot CLI (print and exit),
// not an alt-screen ratatui app with panes/mouse/scrollback, so there is no 1:1 equivalent of
// the pager's live UI here. What's real: every accent below is the exact RGB grok-build ships.

const enabled = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return process.stdout.isTTY && process.env.TERM !== 'dumb';
})();

function rgb(r, g, b) { return [r, g, b]; }

// Exact values from groknight.rs — do not tweak without re-checking the source.
const palette = {
  fg: rgb(225, 225, 225),
  fgDark: rgb(200, 200, 200),
  comment: rgb(145, 145, 145), // muted/dim — brightened from 108 (real user complaint: too dark to read on a real terminal)
  blue: rgb(122, 162, 247),    // accent_system
  cyan: rgb(125, 207, 255),    // running
  green: rgb(158, 206, 106),   // accent_success
  green1: rgb(115, 218, 202),  // accent_feedback
  magenta: rgb(187, 154, 247), // accent_assistant / accent_running
  orange: rgb(255, 158, 100),  // path
  red: rgb(247, 118, 142),     // accent_error
  teal: rgb(26, 188, 156),     // accent_model
  yellow: rgb(224, 175, 104),  // command / warning
};

function wrap(code, s) { return enabled ? `\x1b[${code}m${s}\x1b[0m` : s; }
function fgc([r, g, b], s) { return enabled ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m` : s; }

const c = {
  bold: (s) => wrap('1', s),
  dim: (s) => fgc(palette.comment, s),
  fg: (s) => fgc(palette.fg, s),
  system: (s) => fgc(palette.blue, s),      // headers, HIVEMIND-routed labels
  running: (s) => fgc(palette.cyan, s),     // in-progress
  success: (s) => fgc(palette.green, s),   // ✓ lines
  feedback: (s) => fgc(palette.green1, s),
  assistant: (s) => fgc(palette.magenta, s), // scores/ranked results
  path: (s) => fgc(palette.orange, s),     // file paths, orgs
  error: (s) => fgc(palette.red, s),
  model: (s) => fgc(palette.teal, s),      // model/engine names
  command: (s) => fgc(palette.yellow, s),  // flags, commands to run next
};

// Chrome glyphs — exact codepoints from grok-build's glyphs.rs (the pager's own
// legacy-console-safe chrome set). Ported the glyph, not the Windows ConHost
// fallback machinery — icarus only ships for macOS/Linux, so no legacy-console
// branch is needed here.
const glyphs = {
  checkMark: '✓',    // ✓
  ballotX: '✗',      // ✗
  promptArrow: '❯',  // ❯ — grok's prompt/bullet chevron
  chevron: '›',      // ›
  accentBar: '┃',    // ┃ — heavy vertical, left-rail accent
  diamond: '◆',      // ◆ — filled diamond, section/list bullet
  heavyRule: '━',    // ━ — heavy horizontal
  lightRule: '─',    // ─ — light horizontal
  braille: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'],
};

function heading(s) { return c.bold(c.system(s)); }
function ok(s) { return `${c.success(glyphs.checkMark)} ${s}`; }
function err(s) { return `${c.error(glyphs.ballotX)} ${s}`; }
function bullet(s) { return `${c.system(glyphs.promptArrow)} ${s}`; }

// Section divider — heavy rule (grok's "active/prominent" weight), 1 line,
// no box-drawing corners (keeps piping/CI logs clean, no truncated borders
// if the terminal is narrower than the rule).
function rule(width) {
  width = width || 40;
  return c.dim(glyphs.heavyRule.repeat(width));
}

// Braille progress spinner, one frame per call — matches grok's turn-status
// spinner (SPINNER_DIVISOR: shown a few ticks per frame, ~7.5fps at 30fps
// render). Here each call *is* a tick (one file/chunk processed), so the
// spinner advances with real progress rather than a wall-clock timer.
function spinnerFrame(tick) {
  return glyphs.braille[((tick % glyphs.braille.length) + glyphs.braille.length) % glyphs.braille.length];
}

// Colorizes the `--help` block: title line, `  icarus <sub>` command column (yellow, matching
// grok's `command` accent), everything else dimmed to gray so the command names pop the way
// grok's `/help` overlay bolds slash-commands against dimmed descriptions. Pure line-based
// regex, no template-literal surgery on the ~80-line help string itself.
function colorizeHelp(text) {
  if (!enabled) return text;
  return text.split('\n').map((line) => {
    if (line.startsWith('icarus — ')) return heading(line);
    if (line === '') return line;
    const m = line.match(/^(\s{2}icarus\b\S?.*?)(\s{2,}\S.*)?$/);
    if (m) return `${c.command(m[1])}${m[2] ? c.dim(m[2]) : ''}`;
    return c.dim(line);
  }).join('\n');
}

module.exports = { enabled, palette, c, glyphs, heading, ok, err, bullet, rule, spinnerFrame, colorizeHelp };
