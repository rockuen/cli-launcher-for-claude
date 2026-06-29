// renamePrefix — date-token prefix for the session rename box. Drives the
// pre-filled value + selection range when claudeCodeLauncher.renamePrefix.* is
// on. Tests pin token substitution, single-pass YYYY-vs-YY precedence, the
// disabled passthrough, and the selection math the rename boxes rely on.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

const { formatDatePattern, buildRenamePrefill } = require('../../src/lib/renamePrefix');

// Fixed reference instant: 2026-06-29 09:07:05 (local time).
const REF = new Date(2026, 5, 29, 9, 7, 5);

test('default YYMMDD_ format renders today as a 2-digit-date prefix', () => {
  assert.equal(formatDatePattern('YYMMDD_', REF), '260629_');
});

test('every supported token substitutes', () => {
  assert.equal(formatDatePattern('YYYY', REF), '2026');
  assert.equal(formatDatePattern('YY', REF), '26');
  assert.equal(formatDatePattern('MM', REF), '06');
  assert.equal(formatDatePattern('DD', REF), '29');
  assert.equal(formatDatePattern('HH', REF), '09');
  assert.equal(formatDatePattern('mm', REF), '07');
  assert.equal(formatDatePattern('ss', REF), '05');
});

test('YYYY wins over YY in one pass (no 2626 double-substitution)', () => {
  assert.equal(formatDatePattern('YYYY-MM-DD_', REF), '2026-06-29_');
  assert.equal(formatDatePattern('YYYYMMDD', REF), '20260629');
});

test('literal characters around tokens are preserved', () => {
  assert.equal(formatDatePattern('[YY.MM.DD] ', REF), '[26.06.29] ');
  assert.equal(formatDatePattern('no-tokens-here', REF), 'no-tokens-here');
});

test('empty / nullish pattern yields empty string', () => {
  assert.equal(formatDatePattern('', REF), '');
  assert.equal(formatDatePattern(null, REF), '');
  assert.equal(formatDatePattern(undefined, REF), '');
});

test('invalid now falls back to current date (does not throw)', () => {
  assert.doesNotThrow(() => formatDatePattern('YY', new Date('nonsense')));
  assert.match(formatDatePattern('YY', new Date('nonsense')), /^\d{2}$/);
});

test('buildRenamePrefill disabled → existing value, no selection', () => {
  const r = buildRenamePrefill({ enabled: false, format: 'YYMMDD_', existing: 'My Tab', now: REF });
  assert.deepEqual(r, { value: 'My Tab' });
  assert.equal('valueSelection' in r, false);
});

test('buildRenamePrefill empty format → passthrough', () => {
  const r = buildRenamePrefill({ enabled: true, format: '', existing: 'My Tab', now: REF });
  assert.deepEqual(r, { value: 'My Tab' });
});

test('buildRenamePrefill enabled + empty existing → prefix with caret at end', () => {
  const r = buildRenamePrefill({ enabled: true, format: 'YYMMDD_', existing: '', now: REF });
  assert.equal(r.value, '260629_');
  // Collapsed caret right after the prefix.
  assert.deepEqual(r.valueSelection, [7, 7]);
});

test('buildRenamePrefill enabled + existing → prefix prepended, existing selected', () => {
  const r = buildRenamePrefill({ enabled: true, format: 'YYMMDD_', existing: 'old-title', now: REF });
  assert.equal(r.value, '260629_old-title');
  // Selection covers only the existing-name portion so typing replaces it.
  assert.deepEqual(r.valueSelection, [7, '260629_old-title'.length]);
});

test('buildRenamePrefill missing existing treated as empty', () => {
  const r = buildRenamePrefill({ enabled: true, format: 'YYMMDD_', now: REF });
  assert.equal(r.value, '260629_');
});
