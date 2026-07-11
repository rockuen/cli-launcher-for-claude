// v3.5.8 — SessionDecorationProvider threshold + tooltip tests.
//
// We import from sessionDecorationCore.js (vscode-free) so the test file
// loads without a VSCode runtime. The provider class itself wraps Uri /
// ThemeColor / EventEmitter — those are exercised at runtime in VSCode,
// not here. What lives here is the decision logic + URI query round-trip.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

const {
  formatMB,
  formatQuery,
  parseQuery,
  encodeSessionPath,
  getDecoration,
  SCHEME,
  WARN_THRESHOLD,
  ERROR_THRESHOLD,
} = require('../../src/tree/sessionDecorationCore');

// formatMB

test('formatMB renders one-decimal MB', () => {
  assert.equal(formatMB(1024 * 1024), '1.0');
  assert.equal(formatMB(4.1 * 1024 * 1024), '4.1');
  assert.equal(formatMB(18 * 1024 * 1024), '18.0');
});

// Threshold boundaries

test('under 5 MB returns no decoration (label stays default color)', () => {
  assert.equal(getDecoration(0, false), null);
  assert.equal(getDecoration(1024, false), null);
  assert.equal(getDecoration(WARN_THRESHOLD, false), null); // exactly 5 MB is not "over"
  assert.equal(getDecoration(WARN_THRESHOLD - 1, false), null);
});

test('5+ MB returns warning decoration (yellow + split recommendation)', () => {
  const d = getDecoration(WARN_THRESHOLD + 1, false);
  assert.ok(d, 'expected decoration just over 5 MB');
  assert.equal(d.severity, 'warning');
  assert.equal(d.colorId, 'editorWarning.foreground');
  assert.match(d.tooltip, /Large session/);
  assert.match(d.tooltip, /split into a new session/);
  assert.ok(!d.tooltip.includes('Very large'), 'warning tooltip should not say Very large');
});

test('exactly 10 MB still warning (not yet error)', () => {
  const d = getDecoration(ERROR_THRESHOLD, false);
  assert.ok(d);
  assert.equal(d.severity, 'warning');
});

test('10+ MB returns error decoration (red + split-now recommendation)', () => {
  const d = getDecoration(ERROR_THRESHOLD + 1, false);
  assert.ok(d, 'expected decoration just over 10 MB');
  assert.equal(d.severity, 'error');
  assert.equal(d.colorId, 'errorForeground');
  assert.match(d.tooltip, /Very large session/);
  assert.match(d.tooltip, /split into a new session now/);
});

test('18 MB (the iloom a00cfa9a case) renders as error', () => {
  const d = getDecoration(18 * 1024 * 1024, false);
  assert.ok(d);
  assert.equal(d.severity, 'error');
  assert.match(d.tooltip, /18\.0 MB/);
});

// Trash flag changes the recommendation wording

test('trash flag swaps the recommendation to trash cleanup', () => {
  const live = getDecoration(WARN_THRESHOLD + 1, false);
  const trashed = getDecoration(WARN_THRESHOLD + 1, true);
  assert.match(live.tooltip, /split into a new session/);
  assert.match(trashed.tooltip, /clean up from trash/);
});

test('trash + 10+ MB recommends emptying trash', () => {
  const d = getDecoration(ERROR_THRESHOLD + 1, true);
  assert.match(d.tooltip, /empty from trash too/);
});

// Localization: default wording is English; passing `labels` overrides it and
// substitutes {0} with the size in MB.
test('labels override localizes tooltip wording, {0} → MB', () => {
  const labels = {
    veryLargeTrash: '매우 큼 ({0} MB) 휴지통',
    veryLargeSplit: '매우 큼 ({0} MB) 분할',
    largeTrash: '큼 ({0} MB) 휴지통',
    largeSplit: '큼 ({0} MB) 분할',
  };
  const warn = getDecoration(WARN_THRESHOLD + 1, false, labels);
  assert.match(warn.tooltip, /^큼 \(5\.0 MB\) 분할$/);
  const err = getDecoration(18 * 1024 * 1024, true, labels);
  assert.match(err.tooltip, /^매우 큼 \(18\.0 MB\) 휴지통$/);
});

// Invalid input

test('invalid sizes return null (no decoration applied)', () => {
  assert.equal(getDecoration(undefined, false), null);
  assert.equal(getDecoration(null, false), null);
  assert.equal(getDecoration(NaN, false), null);
  assert.equal(getDecoration(Infinity, false), null);
  assert.equal(getDecoration(-1, false), null);
  assert.equal(getDecoration('huge', false), null);
});

// Query round-trip

test('formatQuery encodes size + trashed flag', () => {
  assert.equal(formatQuery(0, false), 'size=0&trashed=0');
  assert.equal(formatQuery(18 * 1024 * 1024, true), `size=${18 * 1024 * 1024}&trashed=1`);
});

test('formatQuery floors fractional sizes', () => {
  assert.equal(formatQuery(1234.7, false), 'size=1234&trashed=0');
});

test('formatQuery clamps negatives to 0', () => {
  assert.equal(formatQuery(-100, false), 'size=0&trashed=0');
});

test('parseQuery round-trips formatQuery output', () => {
  const q = formatQuery(18 * 1024 * 1024, true);
  const parsed = parseQuery(q);
  assert.equal(parsed.size, 18 * 1024 * 1024);
  assert.equal(parsed.trashed, true);
});

test('parseQuery tolerates missing keys', () => {
  assert.deepEqual(parseQuery(''), { size: 0, trashed: false });
  assert.deepEqual(parseQuery('size=512'), { size: 512, trashed: false });
});

test('encodeSessionPath escapes spaces + special chars', () => {
  assert.equal(encodeSessionPath('abc'), '/abc');
  const out = encodeSessionPath('id with spaces');
  assert.ok(!out.includes(' '), `expected encoded: ${out}`);
});

test('SCHEME constant matches the registered URI scheme', () => {
  assert.equal(SCHEME, 'claudeCodeLauncher-session');
});
