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
