// Tests for the conservative "is Claude waiting for the user?" detector that
// replaced the removed inline selectors. The whole point of this detector is
// to NOT mis-fire on plain text/code (the old selectors' failure), so the
// negative cases matter as much as the positive ones.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

const {
  detectPromptAffordance,
  stripAnsi,
} = require('../../src/lib/promptAffordance');

test('stripAnsi turns CHA cursor-moves into spaces and drops SGR', () => {
  assert.equal(stripAnsi('a\x1b[5Gb'), 'a b');
  assert.equal(stripAnsi('\x1b[38;5;231mOpus\x1b[39m'), 'Opus');
});

// --- positive: real interactive prompts must notify ---

test('/model menu footer ("to use this session only") is detected', () => {
  const tail = 'Enter to set as default \x1b[28G· s to use this session only · Esc to cancel';
  const r = detectPromptAffordance(tail);
  assert.ok(r, 'should detect the /model footer');
});

test('numbered Ink Select menu (caret + >=2 options) is detected — CR-delimited', () => {
  // Mirrors a real dynamic menu: bare CR row delimiters, caret on one row.
  const menu = ['  1. Default', '  2. Sonnet', '\x1b[38;5;153m❯\x1b[39m 3. Opus'].join('\r');
  const r = detectPromptAffordance(menu);
  assert.ok(r, 'should detect the menu');
  assert.equal(r.kind, 'menu');
});

test('trust prompt is detected', () => {
  assert.ok(detectPromptAffordance('Do you trust the files in this folder?'));
});

test('y/n question is detected (question mark + token)', () => {
  assert.ok(detectPromptAffordance('Overwrite existing file? [y/N]'));
  assert.ok(detectPromptAffordance('Continue? (y/n)'));
});

test('"Press Enter to confirm" footer is detected', () => {
  assert.ok(detectPromptAffordance('  Press Enter to confirm · Esc to cancel'));
});

// --- negative: plain text / code / generation must NOT notify ---

test('prose mentioning (y/n) without a question is NOT a prompt', () => {
  assert.equal(detectPromptAffordance('Answers are usually given in (y/n) form.'), null);
});

test('a single typed "1. ..." line in the input box is NOT a menu', () => {
  // The input box also starts with the caret; one option is not a menu.
  assert.equal(detectPromptAffordance('❯ 1. buy milk and eggs'), null);
});

test('plain numbered list in output (no caret) is NOT a menu', () => {
  assert.equal(detectPromptAffordance(['1. first', '2. second', '3. third'].join('\n')), null);
});

test('"esc to interrupt" during generation is NOT a prompt', () => {
  assert.equal(detectPromptAffordance('✳ Cogitating… (esc to interrupt)'), null);
});

test('empty / null / undefined → null', () => {
  assert.equal(detectPromptAffordance(''), null);
  assert.equal(detectPromptAffordance(null), null);
  assert.equal(detectPromptAffordance(undefined), null);
});

test('marker is stable for dedupe (same menu → same marker)', () => {
  const menu = ['  1. A', '❯ 2. B', '  3. C'].join('\r');
  const a = detectPromptAffordance(menu);
  const b = detectPromptAffordance(menu);
  assert.ok(a && b);
  assert.equal(a.marker, b.marker);
});

// --- gjc: animated prompt screens must notify without broad false positives ---

test('gjc selector footer cluster is detected with a stable family marker', () => {
  const tail = [
    '스펙이 준비됐습니다 (ambiguity: 4.8%). 어떻게 진행할까요?',
    '❯ ralplan 합의로 정제 (Recommended)',
    '  ultragoal로 바로 실행',
    '  Other (type your own)',
    'up/down navigate   enter select   esc cancel',
  ].join('\n');
  const r = detectPromptAffordance(tail, { agent: 'gjc' });
  assert.deepEqual(r, { kind: 'gjc-selector', marker: 'gjc-selector-footer-v1' });
});

test('gjc selector footer is detected when rows are CR-delimited redraws', () => {
  const tail = [
    '  ralplan 합의로 정제 (Recommended)',
    '❯ ultragoal로 바로 실행',
    '  Other (type your own)',
    'up/down navigate   enter select   esc cancel',
  ].join('\r');
  const r = detectPromptAffordance(tail, { agent: 'gjc' });
  assert.deepEqual(r, { kind: 'gjc-selector', marker: 'gjc-selector-footer-v1' });
});

test('gjc input and editor footer clusters are detected', () => {
  assert.deepEqual(
    detectPromptAffordance('Type a message...\nenter submit   esc cancel', { agent: 'gjc' }),
    { kind: 'gjc-input', marker: 'gjc-input-footer-v1' },
  );
  assert.deepEqual(
    detectPromptAffordance('Editing answer...\nctrl+enter submit   esc cancel   ctrl+g external editor', { agent: 'gjc' }),
    { kind: 'gjc-editor', marker: 'gjc-editor-footer-v1' },
  );
});

test('gjc generation interrupt and bare cancel controls are NOT prompts', () => {
  assert.equal(detectPromptAffordance('Processing… esc to interrupt', { agent: 'gjc' }), null);
  assert.equal(detectPromptAffordance('Loading… esc cancel', { agent: 'gjc' }), null);
  assert.equal(detectPromptAffordance('Loader footer: esc to cancel', { agent: 'gjc' }), null);
});

test('gjc stale footer outside bottom screen is NOT a prompt', () => {
  const staleFooter = 'up/down navigate   enter select   esc cancel';
  const finalLines = Array.from({ length: 31 }, (_, i) => `ordinary output line ${i + 1}`).join('\n');
  assert.equal(detectPromptAffordance(`${staleFooter}\n${finalLines}`, { agent: 'gjc' }), null);
});

test('gjc partial redraw without the full footer cluster is NOT a prompt', () => {
  const partial = [
    '❯ Option A',
    '  Option B',
    'up/down navigate',
    'esc cancel',
  ].join('\n');
  assert.equal(detectPromptAffordance(partial, { agent: 'gjc' }), null);
});

test('gjc cleared prompt sequence returns null so caller can restore the terminal split', () => {
  const prompt = '❯ A\n  B\nup/down navigate   enter select   esc cancel';
  assert.ok(detectPromptAffordance(prompt, { agent: 'gjc' }));
  assert.equal(detectPromptAffordance('answer accepted\nback to running output', { agent: 'gjc' }), null);
});

test('gjc selector marker stays stable across selection changes', () => {
  const selectedFirst = [
    '❯ ralplan 합의로 정제 (Recommended)',
    '  ultragoal로 바로 실행',
    '  Other (type your own)',
    'up/down navigate   enter select   esc cancel',
  ].join('\n');
  const selectedSecond = [
    '  ralplan 합의로 정제 (Recommended)',
    '❯ ultragoal로 바로 실행',
    '  Other (type your own)',
    'up/down navigate   enter select   esc cancel',
  ].join('\n');
  const a = detectPromptAffordance(selectedFirst, { agent: 'gjc' });
  const b = detectPromptAffordance(selectedSecond, { agent: 'gjc' });
  assert.ok(a && b);
  assert.equal(a.marker, b.marker);
  assert.equal(a.kind, b.kind);
});
