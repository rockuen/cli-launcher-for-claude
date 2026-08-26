// v3.5.5 — sessionJsonl line-cache tests.
//
// extractAiTitle, extractMessages, and extractMessageCount used to each do a
// fresh `fs.readFileSync + JSON.parse` per call. A single render tick in the
// split-pane reader called extractAiTitle *and* extractMessages back-to-back,
// so a 4 MB jsonl turned into 8 MB read + 2 full parse passes per poll. The
// {mtime, size}-keyed cache makes repeat reads of an unchanged snapshot share
// one parse and invalidates automatically when the file actually changes.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const {
  extractAiTitle,
  extractMessages,
  extractMessageCount,
  _clearLineCache,
} = require('../../src/lib/sessionJsonl');

function makeJsonl(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sj-cache-'));
  const p = path.join(dir, 'session.jsonl');
  fs.writeFileSync(p, lines.join('\n'));
  return p;
}

function cleanup(p: string): void {
  try { fs.unlinkSync(p); } catch {}
  try { fs.rmdirSync(path.dirname(p)); } catch {}
}

test('missing file: extractAiTitle returns null, extractMessages [] without throwing', () => {
  _clearLineCache();
  assert.equal(extractAiTitle('/no/such/path-xyz.jsonl'), null);
  assert.deepEqual(extractMessages('/no/such/path-xyz.jsonl'), []);
  assert.equal(extractMessageCount('/no/such/path-xyz.jsonl'), 0);
});

test('extractAiTitle reads the latest ai-title line (cache returns same on repeat)', () => {
  _clearLineCache();
  const p = makeJsonl([
    '{"type":"ai-title","aiTitle":"first"}',
    '{"type":"ai-title","aiTitle":"latest"}',
  ]);
  try {
    assert.equal(extractAiTitle(p), 'latest');
    assert.equal(extractAiTitle(p), 'latest'); // second call hits cache
  } finally { cleanup(p); }
});

test('extractMessages and extractAiTitle share the cache (consistent across two calls)', () => {
  _clearLineCache();
  const p = makeJsonl([
    '{"type":"ai-title","aiTitle":"shared"}',
    '{"type":"user","message":{"role":"user","content":"hi"}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}',
  ]);
  try {
    const title1 = extractAiTitle(p);
    const msgs1 = extractMessages(p);
    const title2 = extractAiTitle(p);
    const msgs2 = extractMessages(p);
    assert.equal(title1, 'shared');
    assert.equal(title2, 'shared');
    assert.equal(msgs1.length, 2);
    assert.equal(msgs2.length, 2);
    assert.deepEqual(msgs1, msgs2);
  } finally { cleanup(p); }
});

test('cache invalidates when the file content (size) changes', () => {
  _clearLineCache();
  const p = makeJsonl(['{"type":"ai-title","aiTitle":"v1"}']);
  try {
    assert.equal(extractAiTitle(p), 'v1');
    // Rewrite with longer content so size differs (mtime alone has coarse
    // resolution on some filesystems, but size is exact).
    fs.writeFileSync(p, '{"type":"ai-title","aiTitle":"version-two-different-size"}');
    assert.equal(extractAiTitle(p), 'version-two-different-size');
  } finally { cleanup(p); }
});

test('cache invalidates when mtime advances even if size matches', () => {
  _clearLineCache();
  const p = makeJsonl(['{"type":"ai-title","aiTitle":"AAA"}']);
  try {
    assert.equal(extractAiTitle(p), 'AAA');
    // Same length, different content. Force mtime far enough into the future
    // that any filesystem timestamp resolution still registers a change.
    fs.writeFileSync(p, '{"type":"ai-title","aiTitle":"BBB"}');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(p, future, future);
    assert.equal(extractAiTitle(p), 'BBB');
  } finally { cleanup(p); }
});

test('_clearLineCache forces a re-read even when the file is unchanged', () => {
  _clearLineCache();
  const p = makeJsonl(['{"type":"ai-title","aiTitle":"keepme"}']);
  try {
    assert.equal(extractAiTitle(p), 'keepme');
    _clearLineCache();
    // Even after a forced clear, the on-disk content is still authoritative.
    assert.equal(extractAiTitle(p), 'keepme');
  } finally { cleanup(p); }
});

test('extractMessageCount uses the cache consistently with extractMessages', () => {
  _clearLineCache();
  const p = makeJsonl([
    '{"type":"user","message":{"role":"user","content":"q1"}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"a1"}]}}',
    '{"type":"user","message":{"role":"user","content":"q2"}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"a2"}]}}',
  ]);
  try {
    assert.equal(extractMessageCount(p), 4);
    assert.equal(extractMessages(p).length, 4);
    assert.equal(extractMessageCount(p), 4); // cache reuse
  } finally { cleanup(p); }
});

test('v3.5.6 cap: files over MAX_CACHEABLE_BYTES are read but not cached', () => {
  _clearLineCache();
  // Build a jsonl just over the 2 MB cache cap. Each line is small but we
  // pad with a comment line of plain text so the file size crosses the
  // threshold without inflating the parsed-object count too much. (Lines
  // that fail JSON.parse are silently dropped by _splitJsonLines, so the
  // padding is invisible to extractMessages output.)
  const lines: string[] = ['{"type":"ai-title","aiTitle":"giant"}'];
  const padding = 'x'.repeat(2048);
  // Need > 2 MB total bytes. 2048-char padding × ~1100 lines = ~2.25 MB.
  for (let i = 0; i < 1100; i++) lines.push(padding);
  const p = makeJsonl(lines);
  try {
    // First call: read + parse, returns 'giant'. NOT cached because oversize.
    assert.equal(extractAiTitle(p), 'giant');
    // Second call: should also work (re-parsed from disk, cache miss again).
    // We can't directly observe the lack of caching from inside the public
    // API, but we can at least confirm correctness is preserved.
    assert.equal(extractAiTitle(p), 'giant');
    // Now add several small files that SHOULD cache — verify they slot in
    // alongside the oversized one without the giant pinning a slot.
    const smallPaths: string[] = [];
    for (let i = 0; i < 5; i++) {
      const sp = makeJsonl([`{"type":"ai-title","aiTitle":"small-${i}"}`]);
      smallPaths.push(sp);
      assert.equal(extractAiTitle(sp), `small-${i}`);
    }
    // After clearing & re-reading the small files, the giant's absence from
    // the cache means there's no LRU pressure to evict.
    for (const sp of smallPaths) {
      assert.match(String(extractAiTitle(sp)), /^small-\d$/);
    }
    for (const sp of smallPaths) cleanup(sp);
  } finally { cleanup(p); }
});

test('v3.5.6 cap: oversized file behavior matches v3.5.4 (no caching, always reads)', () => {
  _clearLineCache();
  const lines = ['{"type":"ai-title","aiTitle":"v1"}'];
  for (let i = 0; i < 1100; i++) lines.push('y'.repeat(2048));
  const p = makeJsonl(lines);
  try {
    assert.equal(extractAiTitle(p), 'v1');
    // File mutates AT SAME SIZE — would normally hit cache because size
    // unchanged. But oversize files aren't cached, so we get the new value.
    const newLines = ['{"type":"ai-title","aiTitle":"v2"}'];
    for (let i = 0; i < 1100; i++) newLines.push('y'.repeat(2048));
    fs.writeFileSync(p, newLines.join('\n'));
    assert.equal(extractAiTitle(p), 'v2');
  } finally { cleanup(p); }
});

test('LRU eviction: cache size stays bounded under many distinct paths', () => {
  _clearLineCache();
  const paths: string[] = [];
  try {
    // _LINE_CACHE_MAX is 20; create 25 distinct sessions and read each once.
    for (let i = 0; i < 25; i++) {
      const p = makeJsonl([`{"type":"ai-title","aiTitle":"s${i}"}`]);
      paths.push(p);
      assert.equal(extractAiTitle(p), `s${i}`);
    }
    // The oldest entries should have been evicted, but every file is still
    // readable from disk, so a re-read just refills the cache.
    for (let i = 0; i < paths.length; i++) {
      assert.equal(extractAiTitle(paths[i]), `s${i}`);
    }
  } finally {
    for (const p of paths) cleanup(p);
  }
});

// ─── v3.21.3: windowed title extraction ────────────────────────────────────
// extractAiTitle reads a 64 KB head + 64 KB tail instead of the whole jsonl.
// _loadSessions calls it on up to 130 files per refresh, synchronously, on the
// extension host thread; at whole-file scan that measured 4.5 s on a 259 MB
// working set, which stalls PTY output and freezes the launcher UI. These
// tests pin the window's two edges and the boundary the window deliberately
// does not cover.

const PAD_LINE = 'z'.repeat(4096); // unparseable filler, dropped by _splitJsonLines
const PAD_COUNT = 64; // 64 x 4 KB = 256 KB, comfortably past head + tail

test('v3.21.3: title at EOF is found on a file far larger than the window', () => {
  _clearLineCache();
  const lines: string[] = [];
  for (let i = 0; i < PAD_COUNT; i++) lines.push(PAD_LINE);
  lines.push('{"type":"ai-title","aiTitle":"at-the-end"}');
  const p = makeJsonl(lines);
  try {
    assert.ok(fs.statSync(p).size > 128 * 1024);
    assert.equal(extractAiTitle(p), 'at-the-end');
  } finally { cleanup(p); }
});

test('v3.21.3: title on line 1 is found on a file far larger than the window', () => {
  // Covers a session titled early that then grew without ever being retitled,
  // and gjc's `type:"session"` header, which is always the first line.
  _clearLineCache();
  const lines: string[] = ['{"type":"ai-title","aiTitle":"at-the-start"}'];
  for (let i = 0; i < PAD_COUNT; i++) lines.push(PAD_LINE);
  const p = makeJsonl(lines);
  try {
    assert.ok(fs.statSync(p).size > 128 * 1024);
    assert.equal(extractAiTitle(p), 'at-the-start');
  } finally { cleanup(p); }
});

test('v3.21.3: latest title still wins when head and tail both carry one', () => {
  _clearLineCache();
  const lines: string[] = ['{"type":"ai-title","aiTitle":"stale"}'];
  for (let i = 0; i < PAD_COUNT; i++) lines.push(PAD_LINE);
  lines.push('{"type":"ai-title","aiTitle":"current"}');
  const p = makeJsonl(lines);
  try {
    assert.equal(extractAiTitle(p), 'current');
  } finally { cleanup(p); }
});

test('v3.21.3: a title buried mid-file outside the window is not read', () => {
  // Documents the deliberate boundary rather than a bug. Claude Code appends
  // each rewritten ai-title, so the winning one is always near EOF; across 663
  // real sessions in two vaults the windowed read matched the whole-file scan
  // exactly. A title that is *only* mid-file would need a full scan to find,
  // which is the cost this change exists to remove.
  _clearLineCache();
  const lines: string[] = [];
  for (let i = 0; i < PAD_COUNT; i++) lines.push(PAD_LINE);
  lines.push('{"type":"ai-title","aiTitle":"buried"}');
  for (let i = 0; i < PAD_COUNT; i++) lines.push(PAD_LINE);
  const p = makeJsonl(lines);
  try {
    assert.equal(extractAiTitle(p), null);
  } finally { cleanup(p); }
});

test('v3.21.3: a resident line-cache snapshot is reused instead of re-reading', () => {
  // The reader panels parse the whole file via extractMessages; extractAiTitle
  // must ride that snapshot rather than paying a second (windowed) read.
  _clearLineCache();
  const lines: string[] = ['{"type":"ai-title","aiTitle":"cached-title"}'];
  for (let i = 0; i < 4; i++) {
    lines.push('{"type":"user","message":{"role":"user","content":"q"}}');
  }
  const p = makeJsonl(lines);
  try {
    assert.equal(extractMessages(p).length, 4); // populates the line cache
    assert.equal(extractAiTitle(p), 'cached-title');
    // And it must still invalidate on a real content change.
    fs.writeFileSync(p, '{"type":"ai-title","aiTitle":"rewritten-and-longer"}');
    assert.equal(extractAiTitle(p), 'rewritten-and-longer');
  } finally { cleanup(p); }
});
