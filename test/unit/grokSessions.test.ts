// Grok (xAI) session listing + transcript extraction.
//
// Grok stores sessions as ~/.grok/sessions/<encoded-cwd>/<session-id>/ with
// summary.json metadata and updates.jsonl ACP events. Reader extraction uses
// user_message_chunk + agent_message_chunk only, skipping thoughts/hooks.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const {
  listGrokSessions,
  findGrokSessionPath,
  findGrokEventsPath,
  extractMessages,
  extractMessageCount,
  extractAiTitle,
  _toEpochMs,
  _clearLineCache,
} = require(path.join(process.cwd(), 'src/lib/sessionJsonl'));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-sessions-'));
const sessionsDir = path.join(tmpRoot, 'sessions');
const wsDir = path.join(tmpRoot, 'workspace');
fs.mkdirSync(wsDir, { recursive: true });

const ID_A = '019edaba-a64d-75c2-98fb-eb2c4b846f50';
const ID_B = '019edabb-1111-7222-8333-abcdefabcdef';
const ID_C = '019edabc-9999-7000-8000-deaddeaddead';
const T0 = Date.parse('2026-06-18T01:00:00Z');

function writeGrokSession(id: string, cwd: string, mtime: number, title: string, turns: Array<{ user?: string; agent?: string; thought?: string }>) {
  const group = encodeURIComponent(cwd);
  const dir = path.join(sessionsDir, group, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
    info: {
      id,
      cwd,
      generated_title: title,
      created_at: new Date(mtime - 500).toISOString(),
      updated_at: new Date(mtime).toISOString(),
      current_model_id: 'grok-build',
    },
  }, null, 2));
  const lines: string[] = [
    JSON.stringify({ method: 'session/update', params: { update: { sessionUpdate: 'hook_execution', content: { text: 'hidden hook' } } } }),
  ];
  for (const t of turns) {
    if (t.user) {
      lines.push(JSON.stringify({
        timestamp: new Date(mtime).toISOString(),
        method: 'session/update',
        params: { update: { sessionUpdate: 'user_message_chunk', content: { text: t.user } } },
      }));
    }
    if (t.thought) {
      lines.push(JSON.stringify({
        timestamp: new Date(mtime).toISOString(),
        method: 'session/update',
        params: { update: { sessionUpdate: 'agent_thought_chunk', content: { text: t.thought } } },
      }));
    }
    if (t.agent) {
      lines.push(JSON.stringify({
        timestamp: new Date(mtime).toISOString(),
        method: 'session/update',
        params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: t.agent } } },
      }));
    }
  }
  const updatesPath = path.join(dir, 'updates.jsonl');
  fs.writeFileSync(updatesPath, lines.join('\n') + '\n');
  const d = new Date(mtime);
  fs.utimesSync(updatesPath, d, d);
  return updatesPath;
}

const pathA = writeGrokSession(ID_A, wsDir, T0, 'Grok OK check', [
  { user: 'Reply only OK.', thought: 'The user asked for OK.', agent: 'OK.' },
  { user: '다시 확인', agent: '확인했습니다.' },
]);
writeGrokSession(ID_B, wsDir, T0 - 1000, '', [
  { user: '세션 경로 알려줘', agent: 'summary.json과 updates.jsonl입니다.' },
]);
writeGrokSession(ID_C, path.join(tmpRoot, 'elsewhere'), T0 - 2000, 'Other cwd', [
  { user: 'other', agent: 'other answer' },
]);

test('listGrokSessions: cwd filter + newest-first + title fallback', () => {
  const sessions = listGrokSessions(wsDir, sessionsDir);
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map((s: any) => s.sessionId), [ID_A, ID_B]);
  assert.equal(sessions[0].title, 'Grok OK check');
  assert.equal(sessions[1].title, '세션 경로 알려줘');
  assert.equal(sessions[0].cwd, wsDir);
  assert.ok(sessions[0].mtime > sessions[1].mtime);
});

test('listGrokSessions: no cwd → all sessions, missing dir → []', () => {
  assert.equal(listGrokSessions(null, sessionsDir).length, 3);
  assert.deepEqual(listGrokSessions(wsDir, path.join(tmpRoot, 'missing')), []);
});

test('listGrokSessions: cross-OS cwd fallback (parent+leaf match)', () => {
  const otherOsCwd = path.join('D:', 'sync', path.basename(tmpRoot), 'workspace');
  assert.equal(listGrokSessions(otherOsCwd, sessionsDir).length, 2);
});

test('findGrokSessionPath: resolves updates.jsonl by session id', () => {
  assert.equal(findGrokSessionPath(ID_A, sessionsDir), pathA);
  assert.equal(findGrokSessionPath(ID_A, sessionsDir, wsDir), pathA);
  assert.equal(findGrokSessionPath(ID_C, sessionsDir, wsDir), null, 'cwd filter excludes other workspace');
  assert.equal(findGrokSessionPath('missing', sessionsDir), null);
});

test('extractMessages(grok): visible user/agent chunks only', () => {
  _clearLineCache();
  const msgs = extractMessages(pathA, 'grok');
  assert.equal(msgs.length, 4);
  assert.deepEqual(msgs.map((m: any) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(msgs[0].text, 'Reply only OK.');
  assert.equal(msgs[1].text, 'OK.');
  assert.ok(!msgs.some((m: any) => m.text.includes('hidden hook')));
  assert.ok(!msgs.some((m: any) => m.text.includes('The user asked')));
});

test('extractMessageCount(grok): matches extractMessages length', () => {
  _clearLineCache();
  assert.equal(extractMessageCount(pathA, 'grok'), 4);
});

test('extractAiTitle(grok): null — titles come from summary.json', () => {
  assert.equal(extractAiTitle(pathA, 'grok'), null);
});

test('_toEpochMs: grok unix seconds do not become 1970', () => {
  // Live grok updates.jsonl `timestamp` for 2026-08-21 02:20:15 UTC.
  const sec = 1787278815;
  const ms = _toEpochMs(sec);
  assert.equal(ms, 1787278815000);
  const d = new Date(ms);
  assert.equal(d.getUTCFullYear(), 2026);
  assert.equal(d.getUTCMonth(), 7);
  assert.equal(d.getUTCDate(), 21);
  assert.equal(_toEpochMs(1787278812409), 1787278812409, 'already-ms left alone');
  assert.ok(_toEpochMs('2026-08-21T02:20:15Z') >= 1e12);
});

test('extractMessages(grok): unix-second timestamp + agentTimestampMs', () => {
  const id = '01a0221e-3016-7460-9c2a-e48cf50b5491';
  const dir = path.join(sessionsDir, encodeURIComponent(wsDir), id);
  fs.mkdirSync(dir, { recursive: true });
  const sec = 1787278815;
  const ms = 1787278812409;
  fs.writeFileSync(path.join(dir, 'updates.jsonl'), [
    JSON.stringify({
      timestamp: sec,
      method: 'session/update',
      params: {
        update: { sessionUpdate: 'user_message_chunk', content: { text: 'hello' } },
        _meta: { agentTimestampMs: ms },
      },
    }),
    JSON.stringify({
      timestamp: sec + 3,
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } } },
    }),
  ].join('\n') + '\n');
  _clearLineCache();
  const msgs = extractMessages(path.join(dir, 'updates.jsonl'), 'grok');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].timestamp, ms, 'prefers agentTimestampMs (already ms)');
  assert.equal(msgs[1].timestamp, (sec + 3) * 1000, 'unix seconds scaled to ms');
  assert.equal(new Date(msgs[0].timestamp).getUTCFullYear(), 2026);
  assert.equal(findGrokEventsPath(id, sessionsDir, wsDir), null, 'no events.jsonl yet');
});

test('grok input theme uses near-white typed text, not dark gray', () => {
  const client = fs.readFileSync(path.join(process.cwd(), 'src/panel/webviewClient.js'), 'utf8');
  const grokDark = client.slice(client.indexOf('grok:'), client.indexOf('gjc:'));
  assert.match(grokDark, /inputFg:\s*'#f4f4f5'/);
  assert.match(grokDark, /muted:\s*'#a1a1aa'/);
  assert.doesNotMatch(grokDark, /muted:\s*'#52525b'/);
  const styles = fs.readFileSync(path.join(process.cwd(), 'src/panel/webviewStyles.js'), 'utf8');
  assert.match(styles, /--accent-input-fg/);
  const html = fs.readFileSync(path.join(process.cwd(), 'src/panel/webviewContent.js'), 'utf8');
  assert.match(html, /--accent-input-fg:\s*#f4f4f5/);
});
