// v3.24.1 — the reader's incremental message cache.
//
// The reader re-renders every time its session file changes, and used to
// re-read and re-parse the WHOLE jsonl each time, synchronously on the
// extension host thread that also pumps PTY output. A big session froze every
// terminal for 0.5-1 s per poll while its agent was writing. The cache now
// parses only the bytes appended since its last read. These tests pin the
// cases where that can go wrong: growth, half-written lines, multi-byte text
// on a read-chunk boundary, a file replaced underneath it, and the two agents
// (codex, grok) whose messages depend on more than one line.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const {
  extractMessages,
  extractMessageCount,
  extractAiTitle,
  listCodexSessions,
  _clearLineCache,
} = require(path.join(process.cwd(), 'src/lib/sessionJsonl'));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'incremental-reader-'));
let seq = 0;
function tmpFile(name = 'session.jsonl'): string {
  return path.join(tmpRoot, `${seq++}-${name}`);
}
function line(o: object): string {
  return JSON.stringify(o) + '\n';
}
function assistant(text: string): object {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
}
function user(text: string): object {
  return { type: 'user', message: { role: 'user', content: text } };
}
// A cold, cache-free read of the same bytes — what the old whole-file parse returned.
function fresh(p: string, agent?: string) {
  _clearLineCache();
  return extractMessages(p, agent);
}

test('growth: appended turns appear, and match a cold parse of the whole file', () => {
  const p = tmpFile();
  fs.writeFileSync(p, line(user('first')) + line(assistant('one')));
  _clearLineCache();
  assert.deepEqual(extractMessages(p).map((m: any) => m.text), ['first', 'one']);

  fs.appendFileSync(p, line(user('second')) + line(assistant('two')));
  const grown = extractMessages(p);
  assert.deepEqual(grown.map((m: any) => m.text), ['first', 'one', 'second', 'two']);
  assert.deepEqual(grown, fresh(p));
  assert.equal(extractMessageCount(p), 4);
});

test('a half-written last line is not shown until it completes, then shown once', () => {
  const p = tmpFile();
  const full = line(assistant('streamed'));
  fs.writeFileSync(p, line(user('q')) + full.slice(0, 20));
  _clearLineCache();
  assert.deepEqual(extractMessages(p).map((m: any) => m.text), ['q']);

  fs.appendFileSync(p, full.slice(20));
  assert.deepEqual(extractMessages(p).map((m: any) => m.text), ['q', 'streamed']);
  fs.appendFileSync(p, line(assistant('next')));
  assert.deepEqual(extractMessages(p).map((m: any) => m.text), ['q', 'streamed', 'next']);
});

test('a complete record without its trailing newline counts, and is not repeated later', () => {
  const p = tmpFile();
  fs.writeFileSync(p, line(user('q')) + JSON.stringify(assistant('no newline yet')));
  _clearLineCache();
  assert.deepEqual(extractMessages(p).map((m: any) => m.text), ['q', 'no newline yet']);

  fs.appendFileSync(p, '\n' + line(assistant('after')));
  const msgs = extractMessages(p);
  assert.deepEqual(msgs.map((m: any) => m.text), ['q', 'no newline yet', 'after']);
  assert.deepEqual(msgs, fresh(p));
});

test('multi-byte text that straddles the 4 MB read-chunk boundary survives intact', () => {
  const p = tmpFile();
  // ~4.6 MB of Korean (3 bytes per character), so at least one line spans the
  // first chunk boundary and its characters are cut between two reads.
  const texts: string[] = [];
  let body = '';
  let bytes = 0;
  for (let i = 0; bytes < 4.6 * 1024 * 1024; i++) {
    const t = `${i}번째 답변 — 한글 본문 `.repeat(40);
    texts.push(t);
    const l = line(assistant(t));
    body += l;
    bytes += Buffer.byteLength(l);
  }
  fs.writeFileSync(p, body);
  assert.ok(fs.statSync(p).size > 4 * 1024 * 1024, 'fixture must cross a read chunk');
  _clearLineCache();
  const msgs = extractMessages(p);
  assert.equal(msgs.length, texts.length);
  assert.deepEqual(msgs.map((m: any) => m.text), texts);
});

test('after an append, only the new bytes are read — not the whole file again', () => {
  const p = tmpFile();
  const filler = line(assistant('x'.repeat(4000)));
  fs.writeFileSync(p, filler.repeat(1200)); // ~4.8 MB
  _clearLineCache();
  assert.equal(extractMessages(p).length, 1200);

  const appended = line(assistant('new turn'));
  fs.appendFileSync(p, appended);
  // The CommonJS module object itself — the one sessionJsonl calls through.
  const fsModule = require('fs');
  const realReadSync = fsModule.readSync;
  let bytesRead = 0;
  fsModule.readSync = (...args: any[]) => {
    const n = (realReadSync as any)(...args);
    bytesRead += n;
    return n;
  };
  let msgs;
  try {
    msgs = extractMessages(p);
  } finally {
    fsModule.readSync = realReadSync;
  }
  assert.equal(msgs.length, 1201);
  assert.equal(msgs[1200].text, 'new turn');
  // The appended line plus the append-only checks (4 KB head + 256-byte probe,
  // before and after reading) — a constant, whatever the file's size.
  assert.ok(bytesRead < Buffer.byteLength(appended) + 16 * 1024, `read ${bytesRead} bytes of a 4.8 MB file for a ${Buffer.byteLength(appended)}-byte append`);
});

test('a file replaced underneath the cache (shrunk or rewritten) is parsed again', () => {
  const p = tmpFile();
  fs.writeFileSync(p, line(user('old 1')) + line(assistant('old 2')) + line(assistant('old 3')));
  _clearLineCache();
  assert.equal(extractMessages(p).length, 3);

  // Shrunk.
  fs.writeFileSync(p, line(user('new 1')));
  assert.deepEqual(extractMessages(p).map((m: any) => m.text), ['new 1']);

  // Same prefix length, different bytes, then longer: the probe must catch it.
  fs.writeFileSync(p, line(user('NEW 1')) + line(assistant('NEW 2')));
  assert.deepEqual(extractMessages(p).map((m: any) => m.text), ['NEW 1', 'NEW 2']);
});

test('returned arrays are snapshots — later appends do not mutate them', () => {
  const p = tmpFile();
  fs.writeFileSync(p, line(user('a')));
  _clearLineCache();
  const before = extractMessages(p);
  fs.appendFileSync(p, line(assistant('b')));
  extractMessages(p);
  assert.equal(before.length, 1);
});

function bumpMtime(p: string) {
  const t = new Date(Date.now() + 10_000);
  fs.utimesSync(p, t, t);
}

test('a same-size rewrite in place (nothing appended) is parsed again', () => {
  const p = tmpFile();
  fs.writeFileSync(p, line(user('ORIGINAL')) + line(assistant('reply')));
  _clearLineCache();
  extractMessages(p);
  fs.writeFileSync(p, line(user('EDITED!!')) + line(assistant('reply')));
  bumpMtime(p);
  assert.deepEqual(extractMessages(p).map((m: any) => m.text), ['EDITED!!', 'reply']);
});

test('an edit near the start of the file is caught even when lines are appended too', () => {
  const p = tmpFile();
  // The long second line keeps the edit out of the 256-byte window before the
  // offset, so only the head fingerprint can notice it.
  const long = line(assistant('x'.repeat(600)));
  fs.writeFileSync(p, line(user('ORIGINAL')) + long);
  _clearLineCache();
  extractMessages(p);
  fs.writeFileSync(p, line(user('EDITED!!')) + long + line(assistant('new')));
  assert.deepEqual(extractMessages(p).map((m: any) => m.text), ['EDITED!!', 'x'.repeat(600), 'new']);
});

test('ai-title follows renames appended while a reader is open', () => {
  const p = tmpFile();
  fs.writeFileSync(p, line(user('q')) + line({ type: 'ai-title', aiTitle: 'First title' }));
  _clearLineCache();
  extractMessages(p);
  assert.equal(extractAiTitle(p), 'First title');

  fs.appendFileSync(p, line(assistant('a')) + line({ type: 'ai-title', aiTitle: 'Renamed' }));
  extractMessages(p);
  assert.equal(extractAiTitle(p), 'Renamed');
});

test('ai-title gives the same answer whether or not a reader has parsed the file', () => {
  const p = tmpFile();
  // A title buried between the 64 KB head and 64 KB tail windows.
  const filler = line(assistant('y'.repeat(70 * 1024)));
  fs.writeFileSync(p, filler + line({ type: 'ai-title', aiTitle: 'buried' }) + filler);
  _clearLineCache();
  const cold = extractAiTitle(p);
  extractMessages(p);
  assert.equal(extractAiTitle(p), cold);
});

test('gjc: a title written to the session header later is picked up', () => {
  const p = tmpFile();
  fs.writeFileSync(p, line({ type: 'session', cwd: '/w', title: '' }) + line({ type: 'message', message: { role: 'user', content: 'hi' } }));
  _clearLineCache();
  extractMessages(p, 'gjc');
  assert.equal(extractAiTitle(p, 'gjc'), null);
  fs.appendFileSync(p, line({ type: 'session', cwd: '/w', title: 'Named later' }));
  extractMessages(p, 'gjc');
  assert.equal(extractAiTitle(p, 'gjc'), 'Named later');
});

test('codex: legacy turns are dropped once a current-shape turn is appended', () => {
  const p = tmpFile();
  const legacy = (type: string, message: string) => ({ type: 'event_msg', payload: { type, message } });
  const completed = (itemType: string, text: string) => ({
    type: 'event_msg', payload: { type: 'item_completed', item: { type: itemType, content: [{ type: 'text', text }] } },
  });
  fs.writeFileSync(p, line(legacy('user_message', 'legacy q')) + line(legacy('agent_message', 'legacy a')));
  _clearLineCache();
  assert.deepEqual(extractMessages(p, 'codex').map((m: any) => m.text), ['legacy q', 'legacy a']);

  fs.appendFileSync(p, line(completed('UserMessage', 'current q')) + line(completed('AgentMessage', 'current a')));
  const msgs = extractMessages(p, 'codex');
  assert.deepEqual(msgs.map((m: any) => m.text), ['current q', 'current a']);
  assert.deepEqual(msgs, fresh(p, 'codex'));
});

test('grok: a chunk run split across two reads stays one message', () => {
  const p = tmpFile('updates.jsonl');
  const chunk = (sessionUpdate: string, text: string) => ({ params: { update: { sessionUpdate, content: { text } } } });
  fs.writeFileSync(p, line(chunk('user_message_chunk', 'hello')) + line(chunk('agent_message_chunk', 'Hel')));
  _clearLineCache();
  assert.deepEqual(extractMessages(p, 'grok').map((m: any) => m.text), ['hello', 'Hel']);

  fs.appendFileSync(p, line(chunk('agent_message_chunk', 'lo there')));
  const msgs = extractMessages(p, 'grok');
  assert.deepEqual(msgs.map((m: any) => m.text), ['hello', 'Hello there']);
  assert.deepEqual(msgs, fresh(p, 'grok'));
});

test('codex list: cached session_meta follows a rollout that is replaced by a smaller one', () => {
  const dir = path.join(tmpRoot, 'codex-sessions');
  const shard = path.join(dir, '2026', '10', '08');
  fs.mkdirSync(shard, { recursive: true });
  const id = '019e9517-0c14-7670-8132-6b125ed8f2ec';
  const rollout = path.join(shard, `rollout-2026-10-08T10-00-00-${id}.jsonl`);
  const meta = (cwd: string, pad = '') => line({ type: 'session_meta', payload: { id, cwd, base_instructions: pad } });
  const noIndex = path.join(tmpRoot, 'no-index.jsonl');

  fs.writeFileSync(rollout, meta('/ws/a', 'x'.repeat(2000)));
  _clearLineCache();
  assert.equal(listCodexSessions('/ws/a', dir, noIndex).length, 1);
  // Growth keeps the cached meta.
  fs.appendFileSync(rollout, line({ type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }));
  assert.equal(listCodexSessions('/ws/a', dir, noIndex).length, 1);
  // A smaller file is a different rollout: re-read.
  fs.writeFileSync(rollout, meta('/ws/b'));
  assert.equal(listCodexSessions('/ws/a', dir, noIndex).length, 0);
  assert.equal(listCodexSessions('/ws/b', dir, noIndex).length, 1);
});

test('codex list: a rollout that cannot be read for a moment is not forgotten', () => {
  const dir = path.join(tmpRoot, 'codex-sessions-locked');
  const shard = path.join(dir, '2026', '10', '08');
  fs.mkdirSync(shard, { recursive: true });
  const id = '019e9518-0c14-7670-8132-6b125ed8f2ec';
  const rollout = path.join(shard, `rollout-2026-10-08T11-00-00-${id}.jsonl`);
  const noIndex = path.join(tmpRoot, 'no-index.jsonl');
  fs.writeFileSync(rollout, line({ type: 'session_meta', payload: { id, cwd: '/ws/c' } }));
  _clearLineCache();

  // One EBUSY, the way an antivirus scan briefly holding the file looks.
  const fsModule = require('fs');
  const realOpen = fsModule.openSync;
  let fail = true;
  fsModule.openSync = (p: any, ...rest: any[]) => {
    if (fail && String(p) === rollout) {
      fail = false;
      const err: any = new Error('EBUSY: resource busy or locked');
      err.code = 'EBUSY';
      throw err;
    }
    return realOpen(p, ...rest);
  };
  try {
    assert.equal(listCodexSessions('/ws/c', dir, noIndex).length, 0);
  } finally {
    fsModule.openSync = realOpen;
  }
  assert.equal(listCodexSessions('/ws/c', dir, noIndex).length, 1);
});

test.after(() => {
  _clearLineCache();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
