// PTY chunk pacing tests — verify that large chunks are split into safe
// pieces with event-loop yields in between, that small chunks pass through
// unchanged, and that the ANSI-aware boundary finder never cuts inside a
// CSI/OSC sequence.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

const {
  sendPtyChunkPaced,
  findSafeBoundary,
  SMALL_CHUNK,
  PIECE_SIZE,
} = require('../../src/lib/ptyChunk');

function fakePanel(): { webview: { postMessage: (m: any) => boolean }, sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    webview: {
      postMessage(m: any): boolean {
        if (m && m.type === 'output') sent.push(m.data);
        return true;
      },
    },
  };
}

test('small chunks are forwarded unchanged in one postMessage', async () => {
  const panel = fakePanel();
  await sendPtyChunkPaced(panel, 'hello world');
  assert.equal(panel.sent.length, 1);
  assert.equal(panel.sent[0], 'hello world');
});

test('empty / null input is a no-op', async () => {
  const panel = fakePanel();
  await sendPtyChunkPaced(panel, '');
  await sendPtyChunkPaced(panel, null);
  await sendPtyChunkPaced(panel, undefined);
  assert.equal(panel.sent.length, 0);
});

test('large plain-text chunks are split into pieces that round-trip the original', async () => {
  const panel = fakePanel();
  const data = 'a'.repeat(20000);
  await sendPtyChunkPaced(panel, data);
  assert.ok(panel.sent.length > 1, 'expected multiple pieces');
  for (const piece of panel.sent) {
    assert.ok(piece.length <= PIECE_SIZE + 32, `piece longer than allowed: ${piece.length}`);
  }
  assert.equal(panel.sent.join(''), data);
});

test('chunk equal to SMALL_CHUNK is still a single message (boundary case)', async () => {
  const panel = fakePanel();
  const data = 'x'.repeat(SMALL_CHUNK);
  await sendPtyChunkPaced(panel, data);
  assert.equal(panel.sent.length, 1);
  assert.equal(panel.sent[0], data);
});

test('disposed entry short-circuits before any message is sent', async () => {
  const panel = fakePanel();
  const entry = { _disposed: true };
  await sendPtyChunkPaced(panel, 'x'.repeat(20000), entry);
  assert.equal(panel.sent.length, 0);
});

test('entry disposed mid-flush stops sending immediately', async () => {
  const panel = fakePanel();
  const entry: { _disposed: boolean } = { _disposed: false };
  // postMessage flips the disposed flag after the first piece arrives.
  panel.webview.postMessage = (m: any) => {
    if (m && m.type === 'output') panel.sent.push(m.data);
    entry._disposed = true;
    return true;
  };
  await sendPtyChunkPaced(panel, 'x'.repeat(20000), entry);
  assert.equal(panel.sent.length, 1, 'should send one piece then bail');
});

test('findSafeBoundary keeps a CSI sequence intact when it straddles the target', () => {
  // Construct data where a CSI sequence (`\x1b[31m`) starts at index 4090
  // and would otherwise be cut by a target at 4092.
  const prefix = 'a'.repeat(4090);
  const csi = '\x1b[31m';
  const suffix = 'rest';
  const data = prefix + csi + suffix; // length 4090 + 5 + 4 = 4099
  const safe = findSafeBoundary(data, 4092);
  // Either advance past the whole CSI (>= 4095) or fall back before the ESC.
  assert.ok(safe >= 4090 + csi.length, `expected boundary past CSI end, got ${safe}`);
});

test('findSafeBoundary keeps an OSC (title set) intact when it straddles the target', () => {
  const prefix = 'b'.repeat(4000);
  // OSC for title set: ESC ] 0 ; some-title BEL
  const osc = '\x1b]0;hello world\x07';
  const suffix = 'after';
  const data = prefix + osc + suffix;
  const target = 4005; // inside the OSC
  const safe = findSafeBoundary(data, target);
  assert.ok(safe >= prefix.length + osc.length, `expected boundary past OSC end, got ${safe}`);
});

test('findSafeBoundary leaves plain text alone (cuts exactly at target)', () => {
  const data = 'a'.repeat(10000);
  assert.equal(findSafeBoundary(data, 4096), 4096);
});

test('findSafeBoundary forwards a lone trailing ESC at end-of-data', () => {
  // ESC as the very last byte and target == data.length → end-of-payload path.
  // xterm.js's stateful VT parser buffers a partial escape across writes, so
  // sending the trailing ESC and letting the next PTY chunk complete the
  // sequence on a follow-up postMessage is safe.
  const data = 'a'.repeat(4090) + '\x1b';
  assert.equal(findSafeBoundary(data, 4091), 4091);
});

test('findSafeBoundary advances past an ESC sequence that straddles target', () => {
  // ESC at 4090 + a single intermediate byte (treated as a 2-byte sequence)
  // plus following text. target 4091 would cut right after ESC; the boundary
  // should advance past the whole sequence.
  const data = 'a'.repeat(4090) + '\x1bm' + 'rest';
  const safe = findSafeBoundary(data, 4091);
  assert.ok(safe >= 4092, `expected boundary past ESC sequence, got ${safe}`);
});

test('findSafeBoundary returns target when no ESC is in the scan window', () => {
  const data = 'a'.repeat(10000);
  assert.equal(findSafeBoundary(data, 5000), 5000);
});

test('findSafeBoundary clamps to data.length when target overshoots', () => {
  const data = 'abc';
  assert.equal(findSafeBoundary(data, 100), 3);
});

test('ANSI-heavy large chunk round-trips correctly', async () => {
  // Mimic a Claude Code render frame: lots of CSI codes interleaved with text.
  const frame = '\x1b[2J\x1b[H' + ('\x1b[33mfoo\x1b[0m bar baz\n'.repeat(500));
  assert.ok(frame.length > PIECE_SIZE * 2);
  const panel = fakePanel();
  await sendPtyChunkPaced(panel, frame);
  assert.ok(panel.sent.length > 1);
  assert.equal(panel.sent.join(''), frame);
});
