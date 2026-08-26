// Codex (OpenAI) session listing + transcript extraction.
//
// Phase 2 surfaces codex rollouts in a dedicated 'Codex Sessions' view. Codex
// stores each conversation as ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>
// .jsonl; the resumable id is the FILENAME's trailing UUID, line 1 is a
// session_meta record carrying { id, cwd }, and titles live separately in
// ~/.codex/session_index.jsonl ({ id, thread_name }). The conversation appears
// TWICE per rollout — response_item (raw model items, includes
// <environment_context> injections + duplicate assistant texts) and event_msg
// (clean TUI turns) — extraction reads event_msg ONLY. Current Codex App builds
// wrap those clean turns as item_completed UserMessage / AgentMessage records;
// legacy CLI builds use user_message / agent_message directly.
//
// Fixtures mirror the real on-disk format captured from codex-cli 0.137
// (shape verified identical back to the 2026-03 builds).

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const {
  listCodexSessions,
  findCodexSessionPath,
  extractMessages,
  extractMessageCount,
  extractAiTitle,
  _clearLineCache,
} = require(path.join(process.cwd(), 'src/lib/sessionJsonl'));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sessions-'));
const sessionsDir = path.join(tmpRoot, 'sessions');
const indexFile = path.join(tmpRoot, 'session_index.jsonl');
const wsDir = path.join(tmpRoot, 'workspace');
fs.mkdirSync(wsDir, { recursive: true });

const ID_A = '019e9517-0c14-7670-8132-6b125ed8f2ec'; // newest, ws cwd, indexed title
const ID_B = '019e9515-df1b-7fc1-b4bd-c66dbfb8e7c9'; // middle, ws cwd, no index entry
const ID_C = '019e9511-9d36-7bc3-874f-53152c35c7be'; // other cwd

const T0 = Date.parse('2026-06-05T09:00:00Z');

// Write one rollout jsonl in the real record shape: session_meta line 1, then
// the double-surfaced conversation (response_item + event_msg) so extraction
// must pick event_msg only.
function writeRollout(
  day: string, id: string, cwd: string, mtime: number,
  turns: Array<{ user?: string; agent?: string }>,
) {
  const dir = path.join(sessionsDir, '2026', '06', day);
  fs.mkdirSync(dir, { recursive: true });
  const lines: string[] = [
    JSON.stringify({
      timestamp: new Date(mtime).toISOString(),
      type: 'session_meta',
      payload: { id, timestamp: new Date(mtime).toISOString(), cwd, originator: 'codex_cli_rs', cli_version: '0.137.0' },
    }),
    // environment_context arrives as a response_item user message — must NOT
    // surface as a dialogue turn.
    JSON.stringify({
      timestamp: new Date(mtime).toISOString(),
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>' + cwd + '</cwd>\n</environment_context>' }] },
    }),
    JSON.stringify({
      timestamp: new Date(mtime).toISOString(),
      type: 'event_msg',
      payload: { type: 'task_started', model_context_window: 272000 },
    }),
  ];
  for (const t of turns) {
    if (t.user) {
      lines.push(JSON.stringify({
        timestamp: new Date(mtime).toISOString(),
        type: 'event_msg',
        payload: { type: 'user_message', message: t.user, images: [] },
      }));
      lines.push(JSON.stringify({
        timestamp: new Date(mtime).toISOString(),
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: t.user }] },
      }));
    }
    if (t.agent) {
      // assistant text is recorded twice: response_item role=assistant AND
      // event_msg agent_message — extraction must not double-count.
      lines.push(JSON.stringify({
        timestamp: new Date(mtime).toISOString(),
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t.agent }] },
      }));
      lines.push(JSON.stringify({
        timestamp: new Date(mtime).toISOString(),
        type: 'event_msg',
        payload: { type: 'agent_message', message: t.agent, phase: null },
      }));
    }
  }
  const p = path.join(dir, `rollout-2026-06-${day}T09-00-00-${id}.jsonl`);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  const t = new Date(mtime);
  fs.utimesSync(p, t, t);
  return p;
}

const pathA = writeRollout('05', ID_A, wsDir, T0 - 1000, [
  { user: 'pencil mcp 정리해줘', agent: '전역 config.toml에서 pencil 블록을 제거했습니다.' },
  { user: '확인해줘', agent: '남은 MCP 서버 목록입니다.' },
]);

const currentPath = path.join(tmpRoot, 'current-rollout.jsonl');
fs.writeFileSync(currentPath, [
  JSON.stringify({
    timestamp: new Date(T0).toISOString(),
    type: 'response_item',
    payload: {
      type: 'message', role: 'user',
      content: [{ type: 'input_text', text: '# AGENTS.md instructions\nsecret system context' }],
    },
  }),
  JSON.stringify({
    timestamp: new Date(T0 + 1).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: { id: '1', type: 'UserMessage', content: [{ type: 'text', text: '리더뷰 고쳐줘' }] },
    },
  }),
  JSON.stringify({
    timestamp: new Date(T0 + 2).toISOString(),
    type: 'response_item',
    payload: {
      type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: '수정하겠습니다.' }],
    },
  }),
  JSON.stringify({
    timestamp: new Date(T0 + 3).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: { id: '2', type: 'Reasoning', summary_text: ['internal reasoning'] },
    },
  }),
  JSON.stringify({
    timestamp: new Date(T0 + 4).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: { id: '3', type: 'AgentMessage', content: [{ type: 'Text', text: '수정하겠습니다.' }] },
    },
  }),
  // A legacy duplicate in a transitional rollout must not render twice.
  JSON.stringify({
    timestamp: new Date(T0 + 5).toISOString(),
    type: 'event_msg',
    payload: { type: 'agent_message', message: '수정하겠습니다.' },
  }),
].join('\n') + '\n');
writeRollout('04', ID_B, wsDir, T0 - 2000, [
  { user: 'mcp 설정 어떻게 되어있어?', agent: '설정 파일을 확인하겠습니다.' },
]);
writeRollout('04', ID_C, path.join(tmpRoot, 'elsewhere'), T0 - 3000, [
  { user: 'other workspace question', agent: 'other answer' },
]);

// session_index.jsonl — only ID_A has a thread_name (ID_B falls back to its
// first user_message; a stale duplicate line checks last-write-wins).
fs.writeFileSync(indexFile, [
  JSON.stringify({ id: ID_A, thread_name: '옛 제목', updated_at: '2026-06-05T08:00:00Z' }),
  JSON.stringify({ id: ID_A, thread_name: 'MCP 설정 정리', updated_at: '2026-06-05T09:22:56Z' }),
].join('\n') + '\n');

// ─── listCodexSessions ──────────────────────────────────────────────────────

test('listCodexSessions: cwd filter + newest-first + title pairing', () => {
  const sessions = listCodexSessions(wsDir, sessionsDir, indexFile);
  assert.equal(sessions.length, 2, 'other-cwd session filtered out');
  assert.deepEqual(sessions.map((s: any) => s.sessionId), [ID_A, ID_B], 'newest first');
  // ID_A: session_index thread_name wins (last write).
  assert.equal(sessions[0].title, 'MCP 설정 정리');
  // ID_B: no index entry → first user_message fallback.
  assert.equal(sessions[1].title, 'mcp 설정 어떻게 되어있어?');
  assert.equal(sessions[0].cwd, wsDir);
  assert.ok(sessions[0].mtime > sessions[1].mtime);
});

test('listCodexSessions: no cwd → all sessions', () => {
  const sessions = listCodexSessions(null, sessionsDir, indexFile);
  assert.equal(sessions.length, 3);
});

test('listCodexSessions: cross-OS cwd fallback (parent+leaf match)', () => {
  // Same vault synced to another OS: absolute prefix differs, the last two
  // segments match (parent + leaf, case-insensitive) — sessions still listed.
  const otherOsCwd = path.join('D:', 'sync', path.basename(tmpRoot), 'workspace');
  const sessions = listCodexSessions(otherOsCwd, sessionsDir, indexFile);
  assert.equal(sessions.length, 2);
});

test('listCodexSessions: missing dir / missing index → [] / untitled', () => {
  assert.deepEqual(listCodexSessions(wsDir, path.join(tmpRoot, 'nope'), indexFile), []);
  const noIndex = listCodexSessions(wsDir, sessionsDir, path.join(tmpRoot, 'nope.jsonl'));
  assert.equal(noIndex.length, 2);
  assert.equal(noIndex[0].title, 'pencil mcp 정리해줘'); // first user_message fallback
});

// ─── findCodexSessionPath ───────────────────────────────────────────────────

test('findCodexSessionPath: resolves the rollout by trailing UUID', () => {
  assert.equal(findCodexSessionPath(ID_A, sessionsDir), pathA);
  assert.equal(findCodexSessionPath(ID_A.toUpperCase(), sessionsDir), pathA, 'case-insensitive');
  assert.equal(findCodexSessionPath('00000000-0000-0000-0000-000000000000', sessionsDir), null);
  assert.equal(findCodexSessionPath(null, sessionsDir), null);
});

// ─── extractMessages / extractMessageCount / extractAiTitle ────────────────

test('extractMessages(codex): event_msg turns only — no env-context, no duplicates', () => {
  _clearLineCache();
  const msgs = extractMessages(pathA, 'codex');
  // 2 user + 2 assistant turns; the response_item duplicates and the
  // <environment_context> injection must not appear.
  assert.equal(msgs.length, 4);
  assert.deepEqual(msgs.map((m: any) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(msgs[0].text, 'pencil mcp 정리해줘');
  assert.equal(msgs[1].text, '전역 config.toml에서 pencil 블록을 제거했습니다.');
  assert.ok(!msgs.some((m: any) => m.text.includes('<environment_context>')));
  assert.ok(msgs[0].timestamp, 'event timestamp carried through');
});

test('extractMessages(codex): current item_completed turns only — no injections or transitional duplicates', () => {
  _clearLineCache();
  const msgs = extractMessages(currentPath, 'codex');
  assert.deepEqual(msgs.map((m: any) => [m.role, m.text]), [
    ['user', '리더뷰 고쳐줘'],
    ['assistant', '수정하겠습니다.'],
  ]);
  assert.ok(!msgs.some((m: any) => m.text.includes('AGENTS.md')));
  assert.ok(msgs.every((m: any) => m.timestamp));
});

test('extractMessageCount(codex): matches extractMessages length', () => {
  _clearLineCache();
  assert.equal(extractMessageCount(pathA, 'codex'), 4);
});

test('extractAiTitle(codex): null — titles come from session_index.jsonl', () => {
  assert.equal(extractAiTitle(pathA, 'codex'), null);
});

// ─── v3.21.4: auto-title from the first user turn ──────────────────────────
// listCodexSessions falls back to the rollout's first user message when
// session_index.jsonl has no thread_name — and under project-scoped storage
// there IS no index file, so this is the only auto-title source. Two defects
// made it return '' for every real session: it only understood the legacy
// `event_msg.user_message` shape (current Codex emits `item_completed` with a
// `UserMessage` item), and it scanned a fixed 64 KB head while `session_meta`
// alone runs 18-40 KB. Un-renamed sessions all collapsed to an 8-char id.

const bigTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-title-'));
const bigSessions = path.join(bigTmp, 'sessions');
const bigWs = path.join(bigTmp, 'ws');
fs.mkdirSync(bigWs, { recursive: true });

// Writes a rollout whose session_meta carries `padKb` KB of base_instructions,
// mirroring current Codex builds, with the first user turn in `shape`.
function writeTitleRollout(id: string, padKb: number, shape: 'item_completed' | 'legacy', text: string, devPadKb = 0) {
  const dir = path.join(bigSessions, '2026', '08', '26');
  fs.mkdirSync(dir, { recursive: true });
  const meta = JSON.stringify({
    timestamp: '2026-08-26T01:46:40.000Z',
    type: 'session_meta',
    payload: {
      id, cwd: bigWs, originator: 'codex-tui', cli_version: '0.148.0-alpha.15',
      base_instructions: { text: 'x'.repeat(padKb * 1024) },
    },
  });
  const userLine = shape === 'item_completed'
    ? JSON.stringify({
        timestamp: '2026-08-26T01:46:46.285Z',
        type: 'event_msg',
        payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'input_text', text }] } },
      })
    : JSON.stringify({
        timestamp: '2026-08-26T01:46:46.285Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: text },
      });
  const p = path.join(dir, `rollout-2026-08-26T10-46-40-${id}.jsonl`);
  // Current Codex writes the developer/system instructions as response_item
  // records between session_meta and the first visible turn; on real rollouts
  // those are what push the user turn past a 64 KB head read.
  const devLines: string[] = [];
  for (let i = 0; i < devPadKb; i++) {
    devLines.push(JSON.stringify({
      timestamp: '2026-08-26T01:46:41.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'd'.repeat(1024) }] },
    }));
  }
  fs.writeFileSync(p, [meta, ...devLines, userLine].join('\n') + '\n');
  return p;
}

const TITLE_ID_NEW = '01a03bbf-7db1-7431-ba26-74b8ee9944e7';
const TITLE_ID_FAR = '01a03bbf-7db1-7431-ba26-74b8ee9944e8';
const TITLE_ID_OLD = '01a03bbf-7db1-7431-ba26-74b8ee9944e9';

test('v3.21.4: title comes from a current item_completed UserMessage', () => {
  writeTitleRollout(TITLE_ID_NEW, 20, 'item_completed', '코덱스 리더뷰 테스트 아무 답이나 해줘');
  const found = listCodexSessions(bigWs, bigSessions, path.join(bigTmp, 'no-index.jsonl'))
    .find((s: any) => s.sessionId === TITLE_ID_NEW);
  assert.ok(found, 'rollout should be listed');
  assert.equal(found.title, '코덱스 리더뷰 테스트 아무 답이나 해줘');
});

test('v3.21.4: title is still found past the 64 KB head window', () => {
  // Realistic shape: a 40 KB session_meta (the largest seen in the wild)
  // followed by ~120 KB of developer-instruction response_items, which puts
  // the first user turn past the old fixed CODEX_META_CHUNK read. That is what
  // silently blanked 28% of real rollouts, legacy record shape included.
  writeTitleRollout(TITLE_ID_FAR, 40, 'item_completed', '먼 오프셋 제목', 120);
  const found = listCodexSessions(bigWs, bigSessions, path.join(bigTmp, 'no-index.jsonl'))
    .find((s: any) => s.sessionId === TITLE_ID_FAR);
  assert.ok(found);
  assert.equal(found.title, '먼 오프셋 제목');
});

test('v3.21.4: legacy user_message rollouts keep their title', () => {
  writeTitleRollout(TITLE_ID_OLD, 20, 'legacy', '구 포맷 제목');
  const found = listCodexSessions(bigWs, bigSessions, path.join(bigTmp, 'no-index.jsonl'))
    .find((s: any) => s.sessionId === TITLE_ID_OLD);
  assert.ok(found);
  assert.equal(found.title, '구 포맷 제목');
});

test('v3.21.4: only the FIRST line of a multi-line prompt becomes the title', () => {
  const id = '01a03bbf-7db1-7431-ba26-74b8ee994500';
  writeTitleRollout(id, 20, 'item_completed', '첫 줄만 제목\n둘째 줄은 버림');
  const found = listCodexSessions(bigWs, bigSessions, path.join(bigTmp, 'no-index.jsonl'))
    .find((s: any) => s.sessionId === id);
  assert.ok(found);
  assert.equal(found.title, '첫 줄만 제목');
});

test('v3.21.4: an indexed thread_name still outranks the derived title', () => {
  const id = '01a03bbf-7db1-7431-ba26-74b8ee994501';
  writeTitleRollout(id, 20, 'item_completed', '파생 제목');
  const idx = path.join(bigTmp, 'with-index.jsonl');
  fs.writeFileSync(idx, JSON.stringify({ id, thread_name: '사용자 지정 제목' }) + '\n');
  const found = listCodexSessions(bigWs, bigSessions, idx).find((s: any) => s.sessionId === id);
  assert.ok(found);
  assert.equal(found.title, '사용자 지정 제목');
});

test('v3.21.4: an oversized session_meta line no longer drops the session', () => {
  // session_meta inlines the entire base_instructions prompt and keeps growing.
  // Once that single line outruns the head read it fails JSON.parse, cwd comes
  // back empty, and the cwd filter removes the rollout — the session vanishes
  // from the tree completely, which is far worse than losing its title.
  const id = '01a03bbf-7db1-7431-ba26-74b8ee994502';
  writeTitleRollout(id, 200, 'item_completed', '거대 메타 세션');
  const found = listCodexSessions(bigWs, bigSessions, path.join(bigTmp, 'no-index.jsonl'))
    .find((s: any) => s.sessionId === id);
  assert.ok(found, 'a rollout with a >64 KB session_meta must still be listed');
  assert.equal(found.title, '거대 메타 세션');
});
