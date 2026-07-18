// v3.20.1 — reader strikethrough tests.
// marked's default GFM del rule accepts a single `~` as a strikethrough
// delimiter, so prose like "3~4개월 … 9월~" rendered with the span between
// the tildes struck through. readerRender narrows the tokenizer to `~~`
// only (Obsidian-compatible); these tests guard both directions.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

// readerRender stays as plain CommonJS so panel/*.js requires it directly.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderBlocks } = require('../../src/lib/readerRender');

const render = (text: string, role = 'assistant') =>
  renderBlocks([{ role, text, timestamp: '2026-07-18T10:00:00Z' }]);

test('single ~ pairs in prose do NOT become strikethrough', () => {
  const out = render('신제품이 3~4개월 실적을 쌓으면 수요를 학습합니다. 9~12월 행 생성.');
  assert.doesNotMatch(out, /<del>/);
  assert.match(out, /3~4개월/);
  assert.match(out, /9~12월/);
});

test('trailing tilde (range shorthand) stays literal', () => {
  const out = render('8월 탭(판매 9월~)이면 9~12월 행 생성 → 이후 자동 소멸.');
  assert.doesNotMatch(out, /<del>/);
  assert.match(out, /9월~\)/);
});

test('double ~~ strikethrough still works', () => {
  const out = render('이건 ~~취소된 내용~~ 이고 3~4개월은 유지.');
  assert.match(out, /<del>취소된 내용<\/del>/);
  assert.match(out, /3~4개월/);
});

test('~~ span may contain a single ~ inside', () => {
  const out = render('~~a~b~~ 안쪽 단일 물결');
  assert.match(out, /<del>a~b<\/del>/);
});

test('nested formatting inside ~~ survives', () => {
  const out = render('그리고 ~~**굵은 취소**~~');
  assert.match(out, /<del><strong>굵은 취소<\/strong><\/del>/);
});

test('user role (breaks: true) gets the same tokenizer', () => {
  const out = render('대략 ~10ms 정도, 3~4개월 전개', 'user');
  assert.doesNotMatch(out, /<del>/);
});
