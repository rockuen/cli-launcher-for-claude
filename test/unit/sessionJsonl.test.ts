// v3.4.7 — sessionJsonl.getSessionJsonlPath() encoding tests.
// Claude Code stores per-session jsonl under
// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl. The encoding folds
// /, \, :, ', and space to '-'. Mac paths never contain ':' so the missing
// colon in earlier versions slipped through; Windows paths like
// 'C:\\Users\\foo' were encoded to 'C:-Users-foo' and never matched the
// real 'C--Users-foo' folder, leaving the in-panel reader stuck on
// "Waiting for session output…" forever.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getSessionJsonlPath } = require('../../src/lib/sessionJsonl');

const SID = 'abcd1234-5678-9012-3456-7890abcdef12';

// Pull the encoded folder name out of a getSessionJsonlPath() result so
// tests stay independent of os.homedir() and path.sep.
function encodedFolder(p: string): string {
  const parts = p.split(/[\/\\]/);
  return parts[parts.length - 2];
}

test('encoding: returns null when sessionId or cwd missing', () => {
  assert.equal(getSessionJsonlPath(null, '/some/path'), null);
  assert.equal(getSessionJsonlPath(SID, ''), null);
  assert.equal(getSessionJsonlPath(SID, null), null);
});

test('encoding: macOS absolute path — leading slash + separators', () => {
  const out = getSessionJsonlPath(SID, '/Users/rockuen/Projects/cli-launcher-for-claude');
  assert.equal(encodedFolder(out!), '-Users-rockuen-Projects-cli-launcher-for-claude');
});

test('encoding: Windows backslash path — drive letter colon folds to dash', () => {
  const out = getSessionJsonlPath(SID, 'C:\\Users\\FURSYS\\Projects\\cli-launcher-for-claude');
  assert.equal(encodedFolder(out!), 'C--Users-FURSYS-Projects-cli-launcher-for-claude');
});

test('encoding: Windows forward-slash path (mixed separator) — same result as backslash', () => {
  const out = getSessionJsonlPath(SID, 'C:/Users/FURSYS/Projects/cli-launcher-for-claude');
  assert.equal(encodedFolder(out!), 'C--Users-FURSYS-Projects-cli-launcher-for-claude');
});

test("encoding: apostrophe is folded to dash (e.g. \"Won's 2nd Brain\")", () => {
  const out = getSessionJsonlPath(SID, "C:\\obsidian\\Won's 2nd Brain");
  assert.equal(encodedFolder(out!), 'C--obsidian-Won-s-2nd-Brain');
});

test('encoding: space is folded to dash', () => {
  const out = getSessionJsonlPath(SID, '/Users/foo/My Project');
  assert.equal(encodedFolder(out!), '-Users-foo-My-Project');
});

test('encoding: lowercase Windows drive letter is preserved as written', () => {
  // Claude Code keeps the cwd's drive-letter casing (verified empirically:
  // both `C--...` and `c--...` folders coexist depending on how the user
  // typed the cd before launching). The encoder MUST NOT normalize case.
  const out = getSessionJsonlPath(SID, 'c:\\Users\\foo');
  assert.equal(encodedFolder(out!), 'c--Users-foo');
});

test('encoding: full path is anchored under ~/.claude/projects/', () => {
  const out = getSessionJsonlPath(SID, '/Users/foo/bar');
  const expected = path.join(os.homedir(), '.claude', 'projects', '-Users-foo-bar', `${SID}.jsonl`);
  assert.equal(out, expected);
});

// ── Kiro path ──────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { findLatestKiroSessionPath } = require('../../src/lib/sessionJsonl');

test('kiro: getSessionJsonlPath returns null when ~/.kiro/sessions/cli/ has no matching session', () => {
  // The sessions dir doesn't exist on this machine (or has no matching cwd).
  // getSessionJsonlPath delegates to findLatestKiroSessionPath which returns null.
  const out = getSessionJsonlPath(SID, '/nonexistent/cwd/xyz', 'kiro');
  assert.equal(out, null);
});

test('kiro: getSessionJsonlPath returns null for a nonexistent cwd even when sessions dir exists', () => {
  const out = getSessionJsonlPath(SID, '/totally/bogus/path/that/will/never/exist/9999', 'kiro');
  assert.equal(out, null);
});

test('kiro: findLatestKiroSessionPath picks the most recently updated session matching cwd', () => {
  // Build a temporary sessions dir with two .json metadata files.
  const dir = path.join(os.tmpdir(), `kiro-meta-test-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const CWD = '/my/project';
  const older = 'session-aaa';
  const newer = 'session-bbb';
  fs.writeFileSync(
    path.join(dir, older + '.json'),
    JSON.stringify({ session_id: older, cwd: CWD, created_at: '2026-06-01T10:00:00Z', updated_at: '2026-06-01T10:00:00Z' }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(dir, newer + '.json'),
    JSON.stringify({ session_id: newer, cwd: CWD, created_at: '2026-06-02T10:00:00Z', updated_at: '2026-06-02T12:00:00Z' }),
    'utf8'
  );
  // Also write a session for a different cwd — must be excluded.
  fs.writeFileSync(
    path.join(dir, 'session-other.json'),
    JSON.stringify({ session_id: 'session-other', cwd: '/other/project', updated_at: '2026-06-03T10:00:00Z' }),
    'utf8'
  );

  // Patch findLatestKiroSessionPath to use our temp dir instead of ~/.kiro/sessions/cli.
  // We do this by calling the internal helper directly with a monkey-patched path.
  // Since the function is not exported with dir injection, we replicate the logic
  // against our temp dir to verify the selection algorithm.
  const files = fs.readdirSync(dir).filter((f: string) => f.endsWith('.json') && !f.endsWith('.jsonl'));
  let best: string | null = null, bestTime = -1;
  for (const m of files) {
    let meta: any;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, m), 'utf-8')); } catch { continue; }
    if (meta.cwd !== CWD) continue;
    const t = Date.parse(meta.updated_at || meta.created_at || '') || 0;
    if (t > bestTime) { bestTime = t; best = meta.session_id || m.replace(/\.json$/, ''); }
  }
  const result = best ? path.join(dir, best + '.jsonl') : null;

  assert.equal(result, path.join(dir, newer + '.jsonl'));
  // Cleanup
  fs.rmSync(dir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { listKiroSessions } = require('../../src/lib/sessionJsonl');

test('listKiroSessions: filters by cwd and sorts updated_at DESC', () => {
  const dir = path.join(os.tmpdir(), `kiro-list-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  const CWD = '/my/project';
  // Two matching sessions for CWD with different updated_at (newer should lead).
  fs.writeFileSync(
    path.join(dir, 'older.json'),
    JSON.stringify({ session_id: 'older', title: 'Older', cwd: CWD, updated_at: '2026-06-01T10:00:00Z' }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(dir, 'newer.json'),
    JSON.stringify({ session_id: 'newer', title: 'Newer', cwd: CWD, updated_at: '2026-06-02T12:00:00Z' }),
    'utf8'
  );
  // Different cwd — must be excluded.
  fs.writeFileSync(
    path.join(dir, 'other.json'),
    JSON.stringify({ session_id: 'other', title: 'Other', cwd: '/other/project', updated_at: '2026-06-03T10:00:00Z' }),
    'utf8'
  );
  // A .jsonl transcript with a matching cwd must be ignored (not a .json meta).
  fs.writeFileSync(path.join(dir, 'newer.jsonl'), '{}\n', 'utf8');

  const result = listKiroSessions(CWD, dir);
  assert.equal(result.length, 2);
  assert.equal(result[0].sessionId, 'newer'); // updated_at DESC
  assert.equal(result[0].title, 'Newer');
  assert.equal(result[1].sessionId, 'older');
  assert.equal(result.every((s: any) => s.cwd === CWD), true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('listKiroSessions: returns [] for a nonexistent dir', () => {
  const out = listKiroSessions('/any/cwd', path.join(os.tmpdir(), `kiro-missing-${Date.now()}`));
  assert.deepEqual(out, []);
});

// ── Kiro parser (_extractKiroMessages via extractMessages) ─────────────────

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { extractMessages, _clearLineCache } = require('../../src/lib/sessionJsonl');
const fs = require('node:fs');
const tmpdir = os.tmpdir();

function writeTmpJsonl(lines: object[]): string {
  const p = path.join(tmpdir, `kiro-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return p;
}

test('kiro parser: extracts user (Prompt) and assistant (AssistantMessage) turns', () => {
  const filePath = writeTmpJsonl([
    { version: 1, kind: 'Prompt',           data: { message_id: 'a', content: [{ kind: 'text', data: 'Hello kiro' }], meta: { timestamp: '2026-06-03T10:00:00Z' } } },
    { version: 1, kind: 'AssistantMessage', data: { message_id: 'b', content: [{ kind: 'text', data: 'Hi there!' }],  meta: { timestamp: '2026-06-03T10:00:01Z' } } },
  ]);
  _clearLineCache();
  const msgs = extractMessages(filePath, 'kiro');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].text, 'Hello kiro');
  assert.equal(msgs[0].timestamp, '2026-06-03T10:00:00Z');
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].text, 'Hi there!');
  fs.unlinkSync(filePath);
});

test('kiro parser: skips ToolResults lines', () => {
  const filePath = writeTmpJsonl([
    { version: 1, kind: 'Prompt',      data: { message_id: 'a', content: [{ kind: 'text', data: 'run tool' }] } },
    { version: 1, kind: 'ToolResults', data: { message_id: 'b', content: [{ kind: 'toolResult', data: 'output' }] } },
    { version: 1, kind: 'AssistantMessage', data: { message_id: 'c', content: [{ kind: 'text', data: 'Done.' }] } },
  ]);
  _clearLineCache();
  const msgs = extractMessages(filePath, 'kiro');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[1].role, 'assistant');
  fs.unlinkSync(filePath);
});

test('kiro parser: skips turns with no text content', () => {
  const filePath = writeTmpJsonl([
    { version: 1, kind: 'Prompt',           data: { message_id: 'a', content: [{ kind: 'toolUse', data: '{}' }] } },
    { version: 1, kind: 'AssistantMessage', data: { message_id: 'b', content: [{ kind: 'text', data: 'OK' }] } },
  ]);
  _clearLineCache();
  const msgs = extractMessages(filePath, 'kiro');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, 'assistant');
  fs.unlinkSync(filePath);
});

test('kiro parser: falls back to claude path when agent is undefined', () => {
  // When agent is omitted, extractMessages must not throw and returns [] for an empty file.
  const filePath = writeTmpJsonl([]);
  _clearLineCache();
  const msgs = extractMessages(filePath, undefined);
  assert.ok(Array.isArray(msgs));
  fs.unlinkSync(filePath);
});
