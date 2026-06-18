import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  buildSubmitInputWrites,
  buildSubmitInputPayload,
  normalizeSubmitText,
  shouldUseBracketedPaste,
} = require(path.join(process.cwd(), 'src/pty/submitInput'));

test('normalizeSubmitText normalizes CRLF and CR to LF', () => {
  assert.equal(normalizeSubmitText('a\r\nb\rc'), 'a\nb\nc');
});

test('Claude, Codex, Kiro, and Grok textarea submits send text, then delayed Enter', () => {
  assert.deepEqual(buildSubmitInputWrites('hello', { agent: 'claude' }), [
    { data: 'hello', delayMs: 0 },
    { data: '\r', delayMs: 120 },
  ]);
  assert.deepEqual(buildSubmitInputWrites('hello', { agent: 'codex' }), [
    { data: 'hello', delayMs: 0 },
    { data: '\r', delayMs: 120 },
  ]);
  assert.deepEqual(buildSubmitInputWrites('hello', { agent: 'kiro' }), [
    { data: 'hello', delayMs: 0 },
    { data: '\r', delayMs: 120 },
  ]);
  assert.deepEqual(buildSubmitInputWrites('hello', { agent: 'grok' }), [
    { data: 'hello', delayMs: 0 },
    { data: '\r', delayMs: 120 },
  ]);
});

test('multi-line submits use bracketed paste for every agent', () => {
  assert.equal(shouldUseBracketedPaste('kiro', 'a\nb'), true);
  // kiro uses deferred Enter (like claude/codex) — bracketed paste body first,
  // then \r after 120 ms to avoid the Mac readline race on submit.
  assert.deepEqual(buildSubmitInputWrites('a\nb', { agent: 'kiro' }), [
    { data: '\x1b[200~a\nb\x1b[201~', delayMs: 0 },
    { data: '\r', delayMs: 120 },
  ]);
  assert.deepEqual(buildSubmitInputWrites('a\nb', { agent: 'codex' }), [
    { data: '\x1b[200~a\nb\x1b[201~', delayMs: 0 },
    { data: '\r', delayMs: 120 },
  ]);
  assert.deepEqual(buildSubmitInputWrites('a\nb', { agent: 'grok' }), [
    { data: '\x1b[200~a\nb\x1b[201~', delayMs: 0 },
    { data: '\r', delayMs: 120 },
  ]);
});

test('non-Claude single-line submits keep the legacy raw text plus Enter path', () => {
  assert.equal(shouldUseBracketedPaste('kiro', 'hello'), false);
  // kiro uses deferred Enter (like claude/codex) to avoid Mac readline race;
  // buildSubmitInputPayload joins both writes so the payload is still 'hello\r'.
  assert.equal(buildSubmitInputPayload('hello', { agent: 'kiro' }), 'hello\r');
});

test('empty submits return an empty payload', () => {
  assert.deepEqual(buildSubmitInputWrites('   ', { agent: 'codex' }), []);
});

test('buildSubmitInputPayload is retained for compatibility', () => {
  assert.equal(buildSubmitInputPayload('hello', { agent: 'codex' }), 'hello\r');
});
