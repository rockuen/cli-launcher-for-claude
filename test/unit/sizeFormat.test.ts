// v3.5.6 — formatBytes() tests. Output appears on the session-tree metadata
// row beside the turn count + relative time. The formatter keeps the string
// short (3-7 chars) so it does not crowd the row; tests pin every boundary
// transition so the visible output stays predictable across vault sizes.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

const { formatBytes } = require('../../src/lib/sizeFormat');

test('zero bytes renders as "0 B"', () => {
  assert.equal(formatBytes(0), '0 B');
});

test('bytes under 1 KB show with B unit', () => {
  assert.equal(formatBytes(1), '1 B');
  assert.equal(formatBytes(847), '847 B');
  assert.equal(formatBytes(1023), '1023 B');
});

test('1 KB boundary switches to KB unit', () => {
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1500), '1 KB');     // rounds down
  assert.equal(formatBytes(1536), '2 KB');     // rounds up at .5
});

test('KB range has no decimals (avoids row crowding)', () => {
  assert.equal(formatBytes(412 * 1024), '412 KB');
  assert.equal(formatBytes(1023 * 1024), '1023 KB');
});

test('1 MB boundary switches to MB unit with one decimal', () => {
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(4.1 * 1024 * 1024), '4.1 MB');
  assert.equal(formatBytes(18 * 1024 * 1024), '18.0 MB');
  assert.equal(formatBytes(53.6 * 1024 * 1024), '53.6 MB');
});

test('one-decimal precision preserves visible gap between small and big sessions', () => {
  // The metadata row visual goal: distinguish a 4.1 MB session from a 53.6 MB
  // session at a glance. A rounded-int formatter would still show both as MB,
  // but the precision delta needs the decimal to read clearly.
  const a = formatBytes(4.1 * 1024 * 1024);
  const b = formatBytes(53.6 * 1024 * 1024);
  assert.notEqual(a, b);
  assert.match(a, /\d+\.\d+ MB/);
  assert.match(b, /\d+\.\d+ MB/);
});

test('invalid input returns empty string (safe to concatenate)', () => {
  assert.equal(formatBytes(undefined), '');
  assert.equal(formatBytes(null), '');
  assert.equal(formatBytes(NaN), '');
  assert.equal(formatBytes(Infinity), '');
  assert.equal(formatBytes(-1), '');
  assert.equal(formatBytes('abc'), '');
  assert.equal(formatBytes({}), '');
});
