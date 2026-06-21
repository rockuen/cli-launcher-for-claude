// Claude usage parsing + model-label formatting (vscode-free helpers).
//
// usage.ts has no vscode dependency (it only reaches fs/os via liveCreds), so
// the pure normalizers are imported directly. The network fetch + token
// refresh are not exercised here — they're integration concerns.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseBucket, parseUsagePayload, formatModelLabel } from '../../src/account/usage';

// --- parseBucket ---

test('parseBucket: utilization + ISO reset → { utilization, resetsAt(ms) }', () => {
  const b = parseBucket({ utilization: 37, resets_at: '2026-06-21T16:00:00Z' });
  assert.ok(b);
  assert.equal(b!.utilization, 37);
  assert.equal(b!.resetsAt, Date.parse('2026-06-21T16:00:00Z'));
});

test('parseBucket: clamps utilization to 0..100', () => {
  assert.equal(parseBucket({ utilization: 142 })!.utilization, 100);
  assert.equal(parseBucket({ utilization: -5 })!.utilization, 0);
});

test('parseBucket: missing utilization → null', () => {
  assert.equal(parseBucket({ resets_at: '2026-06-21T16:00:00Z' }), null);
});

test('parseBucket: invalid reset keeps bucket but resetsAt is null', () => {
  const b = parseBucket({ utilization: 5, resets_at: 'not-a-date' });
  assert.ok(b);
  assert.equal(b!.resetsAt, null);
});

test('parseBucket: non-record / null → null', () => {
  assert.equal(parseBucket(null), null);
  assert.equal(parseBucket('x'), null);
  assert.equal(parseBucket(42), null);
});

// --- parseUsagePayload ---

test('parseUsagePayload: full payload maps every window', () => {
  const u = parseUsagePayload({
    five_hour: { utilization: 37, resets_at: '2026-06-21T16:00:00Z' },
    seven_day: { utilization: 42, resets_at: '2026-06-21T20:00:00Z' },
    seven_day_opus: { utilization: 12, resets_at: '2026-06-25T00:00:00Z' },
    seven_day_sonnet: { utilization: 30, resets_at: '2026-06-25T00:00:00Z' },
  });
  assert.ok(u);
  assert.equal(u!.fiveHour!.utilization, 37);
  assert.equal(u!.sevenDay!.utilization, 42);
  assert.equal(u!.sevenDayOpus!.utilization, 12);
  assert.equal(u!.sevenDaySonnet!.utilization, 30);
  assert.equal(typeof u!.fetchedAt, 'number');
});

test('parseUsagePayload: partial payload leaves missing windows null (team-plan shape)', () => {
  const u = parseUsagePayload({
    five_hour: { utilization: 61, resets_at: '2026-06-21T16:00:00Z' },
    seven_day: { utilization: 45, resets_at: '2026-06-21T20:00:00Z' },
    seven_day_opus: null,
    seven_day_sonnet: null,
  });
  assert.ok(u);
  assert.ok(u!.fiveHour);
  assert.ok(u!.sevenDay);
  assert.equal(u!.sevenDayOpus, null);
  assert.equal(u!.sevenDaySonnet, null);
});

test('parseUsagePayload: no usable windows → null', () => {
  assert.equal(parseUsagePayload({ five_hour: null, seven_day: null }), null);
  assert.equal(parseUsagePayload({ type: 'error', error: {} }), null);
  assert.equal(parseUsagePayload(null), null);
});

// --- formatModelLabel ---

test('formatModelLabel: Claude family + version', () => {
  assert.equal(formatModelLabel('claude-opus-4-7'), 'Opus 4.7');
  assert.equal(formatModelLabel('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
  assert.equal(formatModelLabel('claude-3-5-haiku-20241022'), 'Haiku 3.5');
});

test('formatModelLabel: strips provider/ prefix', () => {
  assert.equal(formatModelLabel('anthropic/claude-opus-4-8'), 'Opus 4.8');
});

test('formatModelLabel: GPT / Gemini / Grok', () => {
  assert.equal(formatModelLabel('gpt-5.2-codex'), 'GPT 5.2 Codex');
  assert.equal(formatModelLabel('gemini-3-pro'), 'Gemini 3 Pro');
  assert.equal(formatModelLabel('grok-code-fast-1'), 'Grok Code Fast 1');
});

test('formatModelLabel: empty / unknown fall back', () => {
  assert.equal(formatModelLabel(''), '');
  assert.equal(formatModelLabel('   '), '');
  assert.equal(formatModelLabel('some-unknown-id'), 'some-unknown-id');
});
