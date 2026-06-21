// _modelFromLine — the per-transcript-line model detector behind
// getSessionModel (used by the usage status bar to show the focused session's
// model). Covers the line shapes the supported agents emit.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';

const { _modelFromLine } = require(path.join(process.cwd(), 'src/lib/sessionJsonl'));

test('_modelFromLine: Claude/Kiro message.model envelope', () => {
  assert.equal(
    _modelFromLine({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-7', content: [] } }),
    'claude-opus-4-7',
  );
});

test('_modelFromLine: gjc model_change carries `model`', () => {
  assert.equal(
    _modelFromLine({ type: 'model_change', model: 'anthropic/claude-opus-4-8' }),
    'anthropic/claude-opus-4-8',
  );
});

test('_modelFromLine: model_change `to` field', () => {
  assert.equal(_modelFromLine({ type: 'model_change', to: 'opus' }), 'opus');
});

test('_modelFromLine: top-level model / modelID', () => {
  assert.equal(_modelFromLine({ model: 'gpt-5.2' }), 'gpt-5.2');
  assert.equal(_modelFromLine({ modelID: 'sonnet' }), 'sonnet');
});

test('_modelFromLine: lines without a model → null', () => {
  assert.equal(_modelFromLine({ message: { role: 'user', content: 'hi' } }), null);
  assert.equal(_modelFromLine({ type: 'session', id: 'abc' }), null);
  assert.equal(_modelFromLine(null), null);
  assert.equal(_modelFromLine('string'), null);
  assert.equal(_modelFromLine({}), null);
});
