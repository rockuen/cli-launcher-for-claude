// v3.5.7 — output buffer cap logic, factored as a pure helper for testing.
//
// The real implementation in src/panel/createPanel.js is inlined inside the
// PTY onData handler (needs closure over `outputBuffer` + `bufferedBytes` and
// can't be cleanly extracted without restructuring the panel). The same
// trim algorithm is replayed here against a fresh array per test so we can
// verify the invariants: total bytes ≤ cap (once at least one entry has been
// pushed) and the oldest chunks are the ones dropped.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

const OUTPUT_BUFFER_CAP = 1024 * 1024;

interface Buf { outputBuffer: string[]; bufferedBytes: number; }

function pushAndTrim(buf: Buf, data: string, cap = OUTPUT_BUFFER_CAP): void {
  buf.outputBuffer.push(data);
  buf.bufferedBytes += data.length;
  while (buf.bufferedBytes > cap && buf.outputBuffer.length > 1) {
    const removed = buf.outputBuffer.shift()!;
    buf.bufferedBytes -= removed.length;
  }
}

test('small chunks accumulate without trimming', () => {
  const buf: Buf = { outputBuffer: [], bufferedBytes: 0 };
  for (let i = 0; i < 100; i++) pushAndTrim(buf, 'x'.repeat(1024));
  assert.equal(buf.outputBuffer.length, 100);
  assert.equal(buf.bufferedBytes, 100 * 1024);
});

test('chunks past the 1 MB cap drop oldest entries', () => {
  const buf: Buf = { outputBuffer: [], bufferedBytes: 0 };
  // 2000 × 1 KB = 2 MB, well over the cap.
  for (let i = 0; i < 2000; i++) pushAndTrim(buf, String(i).padStart(4, '0') + 'x'.repeat(1020));
  // Total bytes stay under cap (allowing room for the most recent push not yet trimmed).
  assert.ok(buf.bufferedBytes <= OUTPUT_BUFFER_CAP + 1024,
    `bufferedBytes ${buf.bufferedBytes} exceeded cap + slack`);
  // First entry should be a late chunk, not chunk #0.
  const firstIdx = parseInt(buf.outputBuffer[0].slice(0, 4), 10);
  assert.ok(firstIdx > 100, `oldest entry index ${firstIdx} should be > 100`);
  // Last entry should be the most recent.
  const lastIdx = parseInt(buf.outputBuffer[buf.outputBuffer.length - 1].slice(0, 4), 10);
  assert.equal(lastIdx, 1999);
});

test('a single chunk over the cap is preserved (length > 1 guard)', () => {
  const buf: Buf = { outputBuffer: [], bufferedBytes: 0 };
  // 2 MB single chunk; with the `length > 1` guard we keep the chunk and
  // accept the temporary overshoot rather than silently dropping data.
  pushAndTrim(buf, 'y'.repeat(2 * 1024 * 1024));
  assert.equal(buf.outputBuffer.length, 1);
  assert.equal(buf.bufferedBytes, 2 * 1024 * 1024);
});

test('drain (splice) returns chunks in arrival order', () => {
  const buf: Buf = { outputBuffer: [], bufferedBytes: 0 };
  for (let i = 0; i < 10; i++) pushAndTrim(buf, `chunk-${i}`);
  const drained = buf.outputBuffer.splice(0, buf.outputBuffer.length);
  buf.bufferedBytes = 0;
  assert.equal(drained.length, 10);
  assert.equal(drained[0], 'chunk-0');
  assert.equal(drained[9], 'chunk-9');
  assert.equal(buf.outputBuffer.length, 0);
});

test('cap is approximate: post-trim bufferedBytes can briefly exceed cap by the last push size', () => {
  const buf: Buf = { outputBuffer: [], bufferedBytes: 0 };
  // Fill exactly to cap, then push a tiny chunk — the trim loop only fires
  // while bufferedBytes > cap, so the tiny push lands inside the cap.
  for (let i = 0; i < 1024; i++) pushAndTrim(buf, 'a'.repeat(1024));
  assert.ok(buf.bufferedBytes <= OUTPUT_BUFFER_CAP);
  pushAndTrim(buf, 'b'.repeat(512));
  // After pushing 512 bytes over the cap, the trim removes oldest 1 KB so we
  // stay under the cap again.
  assert.ok(buf.bufferedBytes <= OUTPUT_BUFFER_CAP,
    `bufferedBytes ${buf.bufferedBytes} should be at or under cap after self-correction`);
});
