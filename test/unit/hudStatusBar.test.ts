// Phase 7 — HUD status bar pure-function tests.
//
// Only vscode-free helpers are tested: parseHudJson (StateWatcher),
// shortModel and formatUsd (HUDStatusBarItem).
// HUDStatusBarItem class itself requires a vscode extension host and is not
// tested here.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseHudJson } from '../../src/orchestration/core/hudHelpers';
import { shortModel, formatUsd } from '../../src/orchestration/ui/hudFormatters';

// --- parseHudJson ---

test('parseHudJson: valid JSON returns parsed object', () => {
  const raw = JSON.stringify({ session_id: 'abc123', model: { id: 'claude-3-5-sonnet-20241022' } });
  const result = parseHudJson(raw);
  assert.ok(result !== null);
  assert.equal(result!.session_id, 'abc123');
  assert.equal(result!.model?.id, 'claude-3-5-sonnet-20241022');
});

test('parseHudJson: invalid JSON returns null', () => {
  const result = parseHudJson('{broken json}');
  assert.equal(result, null);
});

test('parseHudJson: empty string returns null', () => {
  const result = parseHudJson('');
  assert.equal(result, null);
});

test('parseHudJson: whitespace-only returns null', () => {
  const result = parseHudJson('   \n  ');
  assert.equal(result, null);
});

test('parseHudJson: object with missing fields returns object as-is (no type validation)', () => {
  const raw = JSON.stringify({ cost: { total_cost_usd: 1.23 } });
  const result = parseHudJson(raw);
  assert.ok(result !== null);
  assert.equal(result!.cost?.total_cost_usd, 1.23);
  assert.equal(result!.session_id, undefined);
});

// --- shortModel ---

test('shortModel: strips claude- prefix', () => {
  assert.equal(shortModel('claude-3-5-sonnet-20241022'), '3-5-sonnet-20241022');
});

test('shortModel: strips parenthetical suffix', () => {
  assert.equal(shortModel('claude-3-5-sonnet (preview)'), '3-5-sonnet');
});

test('shortModel: returns undefined for undefined input', () => {
  assert.equal(shortModel(undefined), undefined);
});

test('shortModel: returns undefined for empty string', () => {
  assert.equal(shortModel(''), undefined);
});

test('shortModel: non-claude name returned as-is', () => {
  assert.equal(shortModel('gpt-4o'), 'gpt-4o');
});

// --- formatUsd ---

test('formatUsd: small value uses 2 decimals', () => {
  assert.equal(formatUsd(1.5), '$1.50');
});

test('formatUsd: medium value uses 1 decimal', () => {
  assert.equal(formatUsd(12.34), '$12.3');
});

test('formatUsd: large value rounds to integer', () => {
  assert.equal(formatUsd(123.7), '$124');
});

test('formatUsd: zero formatted correctly', () => {
  assert.equal(formatUsd(0), '$0.00');
});
