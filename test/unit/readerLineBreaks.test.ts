// Reader soft-line-break behavior tests.
// Chief's API uses single newlines as intentional visual breaks, while other
// assistants retain standard Markdown soft-break behavior.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderBlocks } = require('../../src/lib/readerRender');

const message = [{
  role: 'assistant',
  text: '첫 번째 문장입니다.\n두 번째 문장입니다.\n\n마지막 문단입니다.',
  timestamp: '2026-08-03T11:00:00Z',
}];

test('Chief assistant preserves intentional single newlines as breaks', () => {
  const out = renderBlocks(message, { agent: 'chief' });
  assert.match(out, /첫 번째 문장입니다\.<br>두 번째 문장입니다\./);
  assert.match(out, /<\/p>\s*<p>마지막 문단입니다\.<\/p>/);
});

test('other assistants keep standard Markdown soft-line-break behavior', () => {
  const out = renderBlocks(message, { agent: 'claude' });
  assert.doesNotMatch(out, /첫 번째 문장입니다\.<br>두 번째 문장입니다\./);
  assert.match(out, /첫 번째 문장입니다\.\n두 번째 문장입니다\./);
});

test('user messages preserve single newlines for every agent', () => {
  const out = renderBlocks(
    [{ role: 'user', text: '첫 줄\n둘째 줄' }],
    { agent: 'claude' },
  );
  assert.match(out, /첫 줄<br>둘째 줄/);
});
