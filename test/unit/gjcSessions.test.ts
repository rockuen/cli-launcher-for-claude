// Gajae Code (gjc) session listing + transcript extraction.
//
// gjc stores sessions as <agentDir>/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl.
// Line 1 is a `{type:"session", id, title?, timestamp, cwd}` header; dialogue
// lines are `{type:"message", message:{role, content}}` (content = string or an
// array of text blocks). The launcher tracks the file STEM as the session id and
// reads cwd/title from the header. Reader extraction surfaces user + assistant
// turns only.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const {
  listGjcSessions,
  findGjcSessionPath,
  extractMessages,
  extractMessageCount,
  extractAiTitle,
  _clearLineCache,
} = require(path.join(process.cwd(), 'src/lib/sessionJsonl'));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gjc-sessions-'));
const sessionsDir = path.join(tmpRoot, 'sessions');
const wsDir = path.join(tmpRoot, 'workspace');
fs.mkdirSync(wsDir, { recursive: true });

const STEM_A = '2026-06-20T08-49-25-874Z_019ee438-7570-7000-848c-94dbf8363d66';
const STEM_B = '2026-06-20T08-50-10-000Z_019ee439-1111-7222-8333-abcdefabcdef';
const STEM_C = '2026-06-20T08-51-00-000Z_019ee43a-9999-7000-8000-deaddeaddead';
const T0 = Date.parse('2026-06-20T08:49:25Z');

// The encoded-cwd dir name is gjc-internal — the launcher reads header.cwd, not
// the dir name — so any stable per-cwd name works for the fixture.
function encDir(cwd: string): string {
  return '--' + cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--';
}

function writeGjcSession(
  stem: string,
  cwd: string,
  mtime: number,
  title: string | null,
  turns: Array<{ user?: unknown; assistant?: unknown; noise?: boolean }>,
) {
  const dir = path.join(sessionsDir, encDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date(mtime).toISOString();
  const lines: string[] = [];
  const header: Record<string, unknown> = { type: 'session', id: stem.split('_')[1], timestamp: ts, cwd };
  if (title) { header.title = title; header.titleSource = 'auto'; }
  lines.push(JSON.stringify(header));
  // A non-message entry (must be skipped by the extractor).
  lines.push(JSON.stringify({ type: 'model_change', id: 'm', parentId: null, timestamp: ts, model: 'anthropic/claude-opus-4-8' }));
  for (const t of turns) {
    if (t.user !== undefined) {
      lines.push(JSON.stringify({ type: 'message', timestamp: ts, message: { role: 'user', content: t.user } }));
    }
    if (t.noise) {
      // A non-user/assistant role (must be skipped).
      lines.push(JSON.stringify({ type: 'message', timestamp: ts, message: { role: 'system', content: 'system noise' } }));
    }
    if (t.assistant !== undefined) {
      lines.push(JSON.stringify({ type: 'message', timestamp: ts, message: { role: 'assistant', content: t.assistant } }));
    }
  }
  const file = path.join(dir, stem + '.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const d = new Date(mtime);
  fs.utimesSync(file, d, d);
  return file;
}

// A: header title; string user content + array assistant content + a skipped role.
const pathA = writeGjcSession(STEM_A, wsDir, T0 + 2000, 'Gajae OK check', [
  { user: 'Reply only OK.', assistant: [{ type: 'text', text: 'OK.' }], noise: true },
  { user: '다시 확인', assistant: '확인했습니다.' },
]);
// B: NO header title → first user message is the title fallback.
writeGjcSession(STEM_B, wsDir, T0 + 1000, null, [
  { user: '세션 경로 알려줘', assistant: 'session.jsonl 입니다.' },
]);
// C: a different cwd (excluded by the cwd filter).
writeGjcSession(STEM_C, path.join(tmpRoot, 'elsewhere'), T0, 'Other cwd', [
  { user: 'other', assistant: 'other answer' },
]);

test('listGjcSessions: cwd filter + newest-first + title (header / first-message fallback)', () => {
  const sessions = listGjcSessions(wsDir, sessionsDir);
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map((s: any) => s.sessionId), [STEM_A, STEM_B]);
  assert.equal(sessions[0].title, 'Gajae OK check');
  assert.equal(sessions[1].title, '세션 경로 알려줘'); // header had no title → first user msg
  assert.equal(sessions[0].cwd, wsDir);
  assert.ok(sessions[0].mtime > sessions[1].mtime);
});

test('listGjcSessions: no cwd → all sessions, missing dir → []', () => {
  assert.equal(listGjcSessions(null, sessionsDir).length, 3);
  assert.deepEqual(listGjcSessions(wsDir, path.join(tmpRoot, 'missing')), []);
});

test('listGjcSessions: cross-OS cwd fallback (parent+leaf match)', () => {
  const otherOsCwd = path.join('D:', 'sync', path.basename(tmpRoot), 'workspace');
  assert.equal(listGjcSessions(otherOsCwd, sessionsDir).length, 2);
});

test('findGjcSessionPath: resolves the jsonl by file stem', () => {
  assert.equal(findGjcSessionPath(STEM_A, sessionsDir), pathA);
  assert.equal(findGjcSessionPath(STEM_A, sessionsDir, wsDir), pathA);
  assert.equal(findGjcSessionPath('missing', sessionsDir), null);
  assert.equal(findGjcSessionPath('', sessionsDir), null);
});

test('extractMessages(gjc): user/assistant only; string + array content; skips non-message/other roles', () => {
  _clearLineCache();
  const msgs = extractMessages(pathA, 'gjc');
  assert.equal(msgs.length, 4);
  assert.deepEqual(msgs.map((m: any) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(msgs[0].text, 'Reply only OK.');
  assert.equal(msgs[1].text, 'OK.');
  assert.equal(msgs[2].text, '다시 확인');
  assert.ok(!msgs.some((m: any) => m.text.includes('system noise')));
  assert.ok(!msgs.some((m: any) => m.text.includes('claude-opus')));
});

test('extractMessageCount(gjc): matches extractMessages length', () => {
  _clearLineCache();
  assert.equal(extractMessageCount(pathA, 'gjc'), 4);
});

test('extractAiTitle(gjc): reads the session header title (not null like codex/grok)', () => {
  _clearLineCache();
  assert.equal(extractAiTitle(pathA, 'gjc'), 'Gajae OK check');
});
