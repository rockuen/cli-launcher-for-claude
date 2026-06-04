// Kiro reader path resolution — regression guard for the cross-session bleed.
//
// Bug (pre-3.7.2): getSessionJsonlPath() ignored the session id for kiro and
// always returned findLatestKiroSessionPath(cwd). Two kiro sessions in one cwd
// therefore both rendered whichever session wrote most recently — opening tab
// B showed tab A's transcript. Fix: when the real id is known (a Tree-resume,
// or a fresh session the reader has discovered + pinned), read <id>.jsonl
// directly; only an unknown placeholder id falls back to cwd-latest discovery.
//
// os.homedir() reads USERPROFILE on Windows and HOME on macOS/Linux — override
// both so the fixtures resolve cross-platform (see kiroSessionGroups.test.ts).

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-reader-'));
const cliDir = path.join(tmpRoot, '.kiro', 'sessions', 'cli');
fs.mkdirSync(cliDir, { recursive: true });
const CWD = path.join(tmpRoot, 'ws');

const A = 'aaaaaaaa-1111-2222-3333-444444444444'; // older
const B = 'bbbbbbbb-5555-6666-7777-888888888888'; // newer → cwd-latest

function writeSession(id: string, updatedAt: string) {
  fs.writeFileSync(
    path.join(cliDir, id + '.json'),
    JSON.stringify({ session_id: id, cwd: CWD, updated_at: updatedAt, title: id.slice(0, 4) }),
  );
  fs.writeFileSync(
    path.join(cliDir, id + '.jsonl'),
    '{"kind":"Prompt","data":{"content":[{"kind":"text","data":"hi from ' + id.slice(0, 4) + '"}]}}\n',
  );
}
writeSession(A, '2026-06-04T00:10:00.000Z');
writeSession(B, '2026-06-04T00:20:00.000Z');

const origHome = process.env.HOME;
const origUserProfile = process.env.USERPROFILE;
process.env.HOME = tmpRoot;
process.env.USERPROFILE = tmpRoot;

const { getSessionJsonlPath, findLatestKiroSessionPath } = require('../../src/lib/sessionJsonl');

test('a known kiro session id resolves to its OWN transcript (no cross-session bleed)', () => {
  const pA = getSessionJsonlPath(A, CWD, 'kiro');
  const pB = getSessionJsonlPath(B, CWD, 'kiro');
  assert.ok(pA && pA.endsWith(A + '.jsonl'), 'A resolves to A.jsonl');
  assert.ok(pB && pB.endsWith(B + '.jsonl'), 'B resolves to B.jsonl');
  assert.notEqual(pA, pB, 'distinct sessions must resolve to distinct files');
});

test('the older kiro session is NOT pulled to the newest (the actual bug)', () => {
  const pA = getSessionJsonlPath(A, CWD, 'kiro');
  const latest = findLatestKiroSessionPath(CWD);
  assert.ok(latest.endsWith(B + '.jsonl'), 'cwd-latest is B (the newer session)');
  assert.notEqual(pA, latest, 'A must not resolve to the latest transcript');
});

test('an unknown placeholder id falls back to cwd-latest discovery', () => {
  const fake = getSessionJsonlPath('00000000-0000-0000-0000-000000000000', CWD, 'kiro');
  const latest = findLatestKiroSessionPath(CWD);
  assert.equal(fake, latest, 'a placeholder UUID with no file on disk falls back to cwd-latest');
});

test('cleanup temp workspace', () => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = origUserProfile;
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});
