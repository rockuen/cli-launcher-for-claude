// Numbered-choice prompt detection tests. The fixtures are transcribed
// from a REAL PTY capture of Claude Code v2.1.158's theme picker (the same
// capture that motivated the feature), so these lock in the behaviour that
// the 2026-05-03 naive-strip attempt got wrong: Ink draws inter-word gaps
// as CHA cursor moves (\x1b[<N>G), which must become spaces before the
// "N. label" rows can be parsed.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

const {
  detectChoicePrompt,
  normalizeChoiceLine,
} = require('../../src/lib/choicePrompt');

// Real theme picker render: header + 7 options (❯ on #2) + a syntax
// preview whose leading line-numbers (" 1function", " 3}") must NOT be
// mistaken for menu options.
const THEME_MENU = [
  '\x1b[2G\x1b[1mChoose\x1b[9Gthe\x1b[13Gtext\x1b[18Gstyle\x1b[24Gthat\x1b[29Glooks\x1b[35Gbest\x1b[40Gwith\x1b[45Gyour\x1b[50Gterminal\x1b[22m',
  '\x1b[2G\x1b[38;5;246mTo\x1b[5Gchange\x1b[12Gthis\x1b[17Glater,\x1b[24Grun\x1b[28G/theme\x1b[39m',
  '',
  '\x1b[4G\x1b[38;5;246m1.\x1b[7G\x1b[39mAuto\x1b[12G(match\x1b[19Gterminal)',
  '\x1b[2G\x1b[38;5;153m❯\x1b[4G\x1b[38;5;246m2.\x1b[7G\x1b[38;5;114mDark\x1b[12Gmode\x1b[17G✔\x1b[39m',
  '\x1b[4G\x1b[38;5;246m3.\x1b[7G\x1b[39mLight\x1b[13Gmode',
  '\x1b[4G\x1b[38;5;246m4.\x1b[7G\x1b[39mDark\x1b[12Gmode\x1b[17G(colorblind-friendly)',
  '\x1b[4G\x1b[38;5;246m5.\x1b[7G\x1b[39mLight\x1b[13Gmode\x1b[18G(colorblind-friendly)',
  '\x1b[4G\x1b[38;5;246m6.\x1b[7G\x1b[39mDark\x1b[12Gmode\x1b[17G(ANSI\x1b[23Gcolors\x1b[30Gonly)',
  '\x1b[4G\x1b[38;5;246m7.\x1b[7G\x1b[39mLight\x1b[13Gmode\x1b[18G(ANSI\x1b[24Gcolors\x1b[31Gonly)',
  '',
  '\x1b[2G\x1b[38;5;231m\x1b[2m 1\x1b[22m\x1b[38;5;81mfunction\x1b[38;5;231m \x1b[38;5;148mgreet\x1b[38;5;231m()\x1b[21G{\x1b[39m',
  '\x1b[2G\x1b[38;5;231m\x1b[2m 3\x1b[22m}\x1b[39m',
].join('\r\r\n');

test('normalizeChoiceLine turns CHA into a space (restores word gaps)', () => {
  assert.equal(normalizeChoiceLine('a\x1b[5Gb'), 'a b');
  assert.equal(normalizeChoiceLine('Auto\x1b[12G(match\x1b[19Gterminal)'), 'Auto (match terminal)');
});

test('normalizeChoiceLine strips SGR colour without eating glyphs', () => {
  assert.equal(normalizeChoiceLine('\x1b[38;5;114mDark\x1b[39m'), 'Dark');
});

test('detects the real theme picker: 7 options, caret on #2', () => {
  const r = detectChoicePrompt(THEME_MENU);
  assert.ok(r, 'should detect a choice prompt');
  assert.equal(r.count, 7);
  assert.equal(r.options.length, 7);
  assert.equal(r.selectedNum, 2);
});

test('extracts clean labels despite CHA-packed spacing', () => {
  const r = detectChoicePrompt(THEME_MENU);
  assert.equal(r.options[0].num, 1);
  assert.equal(r.options[0].label, 'Auto (match terminal)');
  assert.equal(r.options[1].label, 'Dark mode ✔');
  assert.equal(r.options[2].label, 'Light mode');
  assert.equal(r.options[6].num, 7);
  assert.equal(r.options[6].label, 'Light mode (ANSI colors only)');
});

test('syntax-preview line numbers are NOT parsed as options', () => {
  // " 1function" / " 3}" have no dot after the digit and must be ignored;
  // if they leaked in, the run would be 1,2,3,4,5,6,7,1,3 and break.
  const r = detectChoicePrompt(THEME_MENU);
  assert.equal(r.options.length, 7);
});

test('no ❯ caret anywhere → null (rendered list, not a live menu)', () => {
  const noCaret = THEME_MENU.replace('❯', ' ');
  assert.equal(detectChoicePrompt(noCaret), null);
});

test('non-contiguous numbering (1,2,4) → null', () => {
  const gap = ['❯ 1. alpha', '2. bravo', '4. delta'].join('\n');
  assert.equal(detectChoicePrompt(gap), null);
});

test('a plain numbered run with no caret → null', () => {
  const list = ['1. alpha', '2. bravo', '3. charlie'].join('\n');
  assert.equal(detectChoicePrompt(list), null);
});

test('binary [Y/n] text is not a choice menu', () => {
  // Has a ❯ but no "N." rows → zero options → null. Binary prompts stay
  // the binary detector's job.
  assert.equal(detectChoicePrompt('Continue? \x1b[2G❯ [Y/n]'), null);
});

test('single option is not enough (needs >=2)', () => {
  assert.equal(detectChoicePrompt('❯ 1. only one'), null);
});

test('empty / null input → null', () => {
  assert.equal(detectChoicePrompt(''), null);
  assert.equal(detectChoicePrompt(null), null);
  assert.equal(detectChoicePrompt(undefined), null);
});

test('caret directly adjacent to the number still parses', () => {
  // Mirrors the capture, where ❯ and "2." sit one space apart after
  // normalization but can also arrive with none.
  const r = detectChoicePrompt(['❯1. yes', '2. no'].join('\n'));
  assert.ok(r);
  assert.equal(r.selectedNum, 1);
  assert.equal(r.count, 2);
});

test('CR-only dynamic menu (/theme, /model) is detected — the real bug', () => {
  // Ink's dynamic menus delimit rows with bare CR and emit ZERO line
  // feeds, so the pre-fix /\r?\n/ split saw one giant line and found no
  // options — which is exactly why /theme was invisible in the reader
  // while trust prompts (which include LF) worked. Fixture mirrors the
  // live v2.1.158 /theme capture: CR-joined, no LF.
  const themeMenu = [
    'Theme',
    'Choose the text style that looks best with your terminal',
    '1. Auto (match terminal)',
    '❯ 2. Dark mode ✔',
    '3. Light mode',
    '4. Dark mode (colorblind-friendly)',
    '5. Light mode (colorblind-friendly)',
    '6. Dark mode (ANSI colors only)',
    '7. Light mode (ANSI colors only)',
    '8. New custom theme…',
  ].join('\r'); // CR only — NO line feeds
  const r = detectChoicePrompt(themeMenu);
  assert.ok(r, 'CR-delimited menu must be detected');
  assert.equal(r.count, 8);
  assert.equal(r.selectedNum, 2);
  assert.equal(r.options[0].label, 'Auto (match terminal)');
  assert.equal(r.options[7].label, 'New custom theme…');
});

test('truncated=true when Ink draws a ↓ scroll indicator (clipped menu)', () => {
  // Small terminal: Ink shows only a window of options plus a ↓ marker. The
  // ext side uses this to briefly enlarge the pty and capture the full list.
  const clipped = ['1. Alpha', '❯ 2. Bravo', '3. Charlie', '↓'].join('\r');
  const r = detectChoicePrompt(clipped);
  assert.ok(r);
  assert.equal(r.truncated, true);
});

test('truncated=false for a fully-visible menu (no scroll indicator)', () => {
  const r = detectChoicePrompt(THEME_MENU);
  assert.equal(r.truncated, false);
});

test('clipped window starting mid-list (2,3,4 + ↓) is detected', () => {
  // Ink's sliding window shows options around the caret, not from 1. A tiny
  // terminal pane is the trigger — this is what previously detected nothing.
  const win = ['❯ 2. Bravo', '3. Charlie', '4. Delta', '↓'].join('\r');
  const r = detectChoicePrompt(win);
  assert.ok(r);
  assert.equal(r.truncated, true);
  assert.equal(r.selectedNum, 2);
  assert.equal(r.count, 3);
});

test('lone option WITH scroll indicator detected (tiniest terminal window)', () => {
  // The exact "nothing pops up" case: only 1 option visible (num=2) plus ↓.
  const lone = ['❯ 2. Dark mode', '↓'].join('\r');
  const r = detectChoicePrompt(lone);
  assert.ok(r);
  assert.equal(r.truncated, true);
  assert.equal(r.count, 1);
});

test('mid-list start WITHOUT scroll indicator → null (prose, not a menu)', () => {
  // 2,3 with no ↑/↓ isn't a clipped window — reject so prose can't masquerade.
  const r = detectChoicePrompt(['❯ 2. foo', '3. bar'].join('\n'));
  assert.equal(r, null);
});
