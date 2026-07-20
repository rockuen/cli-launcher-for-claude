// Reader fenced-code copy affordance tests.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderBlocks } = require('../../src/lib/readerRender');

const render = (text: string, copyLabel = 'Copy block') =>
  renderBlocks(
    [{ role: 'assistant', text, timestamp: '2026-07-20T10:00:00Z' }],
    { copyLabel },
  );

test('fenced code block gets one top-right copy button wrapper', () => {
  const out = render('Before\n\n```text\nready to copy\nsecond line\n```');
  assert.equal((out.match(/class="reader-code-copy"/g) || []).length, 1);
  assert.match(out, /<div class="reader-code-block"><button[^>]+aria-label="Copy block"/);
  assert.match(out, /<pre><code class="language-text">ready to copy\nsecond line\n<\/code><\/pre>/);
});

test('multiple fenced blocks each get their own copy button', () => {
  const out = render('```sh\none\n```\n\n```json\n{"two": 2}\n```');
  assert.equal((out.match(/class="reader-code-copy"/g) || []).length, 2);
  assert.equal((out.match(/class="reader-code-block"/g) || []).length, 2);
});

test('inline code is not decorated as a copyable block', () => {
  const out = render('Run `npm test` now.');
  assert.doesNotMatch(out, /reader-code-copy/);
  assert.match(out, /<code>npm test<\/code>/);
});

test('copy label is escaped before entering button attributes', () => {
  const out = render('```\nx\n```', '\"><img src=x onerror=alert(1)>');
  assert.doesNotMatch(out, /<img src=x/);
  assert.match(out, /&quot;&gt;&lt;img/);
});
