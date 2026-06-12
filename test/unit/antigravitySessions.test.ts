// Antigravity (agy) session listing + tree-group support.
//
// Phase 1 surfaces agy CLI conversations in a dedicated 'Antigravity Sessions'
// view, reusing SessionTreeDataProvider in agentMode 'antigravity'. Two layers
// are covered here:
//   1. listAntigravitySessions() — pairs ~/.gemini/antigravity-cli/history.jsonl
//      metadata { display, workspace, timestamp } with the resumable id from
//      each conversations/<id>.db filename (agy v1.0.5 does NOT put the id on the
//      history line; the .db FILENAME is the id `agy --conversation <id>` takes).
//      Pairing is by recency rank. cwd filter (exact + cross-OS fallback),
//      newest-first.
//   2. The provider in 'antigravity' mode — antigravity-scoped store keys,
//      group build + Recent Sessions, resume command payload, nesting, DnD MIME.
//
// Verified against the real on-disk format captured from a logged-in agy.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Module from 'node:module';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sessions-'));
const wsDir = path.join(tmpRoot, 'workspace');
fs.mkdirSync(wsDir, { recursive: true });

const T0 = Date.parse('2026-06-04T20:00:00Z');

// Write a fake agy session store: history.jsonl (display/workspace/timestamp —
// NO id, matching the real format) + conversations/<id>.db with mtime pinned to
// the session timestamp so recency-rank pairing is deterministic in tests.
function writeAgy(baseDir: string, sessions: any[]) {
  const convDir = path.join(baseDir, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });
  const lines = sessions.map((s) =>
    JSON.stringify({ display: s.display, workspace: s.workspace, timestamp: s.timestamp }),
  );
  fs.writeFileSync(path.join(baseDir, 'history.jsonl'), lines.join('\n') + '\n');
  for (const s of sessions) {
    const p = path.join(convDir, s.id + '.db');
    fs.writeFileSync(p, 'db');
    const t = new Date(s.timestamp);
    fs.utimesSync(p, t, t);
  }
}

// Home-relative fixture (the provider reads ~/.gemini/antigravity-cli/...).
const agyHomeDir = path.join(tmpRoot, '.gemini', 'antigravity-cli');
writeAgy(agyHomeDir, [
  { id: 'conv-a', display: 'Newest', workspace: wsDir, timestamp: T0 - 1000 },
  { id: 'conv-b', display: 'Middle', workspace: wsDir, timestamp: T0 - 2000 },
  { id: 'conv-c', display: 'Oldest', workspace: wsDir, timestamp: T0 - 3000 },
  { id: 'conv-other', display: 'Other cwd', workspace: path.join(tmpRoot, 'elsewhere'), timestamp: T0 },
]);

// ─── Minimal vscode stub ────────────────────────────────────────────────────
class FakeTreeItem {
  label: any;
  collapsibleState: any;
  contextValue: any;
  constructor(label: any, collapsibleState: any) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}
const vscodeStub: any = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: wsDir } }],
    getConfiguration: () => ({ get: (_k: string, d: any) => d }),
  },
  window: {},
  env: { language: 'en' },
  EventEmitter: class { event = () => {}; fire() {} },
  ThemeIcon: class { constructor(public id: string) {} },
  TreeItem: FakeTreeItem,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  DataTransferItem: class { constructor(public value: any) {} },
};

const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, [request, ...rest]);
};

const origHome = process.env.HOME;
const origUserProfile = process.env.USERPROFILE;
process.env.HOME = tmpRoot;
process.env.USERPROFILE = tmpRoot;

const { listAntigravitySessions, listKiroSessions } = require('../../src/lib/sessionJsonl');
const { sessionStoreGet, sessionStoreUpdate } = require('../../src/store/sessionStore');
const { SessionTreeDataProvider } = require('../../src/tree/SessionTreeDataProvider');

(Module as any)._load = origLoad;

function reset() {
  const f = path.join(wsDir, '.claude-launcher', 'sessions.json');
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

// Per-test temp agy store helper (uses _file/_convDir injection).
function tmpAgy(name: string, sessions: any[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-' + name + '-'));
  writeAgy(dir, sessions);
  return {
    dir,
    hist: path.join(dir, 'history.jsonl'),
    conv: path.join(dir, 'conversations'),
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

// ─── Parser: listAntigravitySessions ────────────────────────────────────────

test('listAntigravitySessions pairs history metadata with .db ids, filters cwd, newest first', () => {
  const out = listAntigravitySessions(wsDir);
  // conv-other is a different cwd → filtered out; rest newest-first.
  assert.deepEqual(out.map((s: any) => s.sessionId), ['conv-a', 'conv-b', 'conv-c']);
  assert.equal(out[0].title, 'Newest');
  assert.equal(out[0].cwd, wsDir);
  assert.ok(out[0].mtime > out[1].mtime && out[1].mtime > out[2].mtime);
});

test('listAntigravitySessions returns every cwd when none requested', () => {
  assert.equal(listAntigravitySessions(undefined as any).length, 4);
});

test('listAntigravitySessions resume id is the .db filename, not from the history line', (t) => {
  // The real history line has no id; the id must come from conversations/<id>.db.
  const a = tmpAgy('dbid', [{ id: 'real-db-id', display: 'Has db', workspace: wsDir, timestamp: T0 }]);
  t.after(a.cleanup);
  const out = listAntigravitySessions(wsDir, a.hist, a.conv);
  assert.equal(out.length, 1);
  assert.equal(out[0].sessionId, 'real-db-id');
  assert.equal(out[0].title, 'Has db');
});

test('listAntigravitySessions returns [] when history has entries but no .db files', (t) => {
  // No conversations dir → no resumable ids → nothing to show.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-nodb-'));
  fs.writeFileSync(path.join(dir, 'history.jsonl'),
    JSON.stringify({ display: 'Orphan', workspace: wsDir, timestamp: T0 }) + '\n');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const out = listAntigravitySessions(wsDir, path.join(dir, 'history.jsonl'), path.join(dir, 'conversations'));
  assert.deepEqual(out, []);
});

test('listAntigravitySessions honors an explicit id on the history line (future-proof)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-explicit-'));
  fs.mkdirSync(path.join(dir, 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'history.jsonl'),
    JSON.stringify({ conversationId: 'explicit-id', display: 'Explicit', workspace: wsDir, timestamp: T0 }) + '\n');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const out = listAntigravitySessions(wsDir, path.join(dir, 'history.jsonl'), path.join(dir, 'conversations'));
  assert.equal(out.length, 1);
  assert.equal(out[0].sessionId, 'explicit-id'); // used directly, no .db needed
});

test('listAntigravitySessions tolerates field-name drift (title/cwd/updated_at)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-drift-'));
  fs.mkdirSync(path.join(dir, 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'conversations', 'd1.db'), 'db');
  fs.writeFileSync(path.join(dir, 'history.jsonl'),
    JSON.stringify({ title: 'Drift', cwd: wsDir, updated_at: new Date(T0).toISOString() }) + '\n');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const out = listAntigravitySessions(wsDir, path.join(dir, 'history.jsonl'), path.join(dir, 'conversations'));
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Drift');
  assert.equal(out[0].sessionId, 'd1');
  assert.ok(out[0].mtime > 0);
});

test('listAntigravitySessions normalizes epoch-seconds + epoch-ms timestamps', (t) => {
  const secs = Math.floor(T0 / 1000);
  const a = tmpAgy('ts', [
    { id: 'sec', display: 'Seconds', workspace: wsDir, timestamp: T0 - 5000 },
    { id: 'ms', display: 'Millis', workspace: wsDir, timestamp: T0 + 10000 },
  ]);
  // Overwrite history with raw epoch-seconds + epoch-ms values to exercise _antigravityTs.
  fs.writeFileSync(a.hist, [
    JSON.stringify({ display: 'Seconds', workspace: wsDir, timestamp: secs }),
    JSON.stringify({ display: 'Millis', workspace: wsDir, timestamp: T0 + 10000 }),
  ].join('\n'));
  t.after(a.cleanup);
  const out = listAntigravitySessions(wsDir, a.hist, a.conv);
  // 'ms' (T0+10s) is newer than 'sec' (~T0) → sorts first. Both normalized to ms.
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'Millis');
  assert.ok(Math.abs(out[1].mtime - T0) < 2000); // 'Seconds' ~ T0 after *1000
});

test('listAntigravitySessions skips malformed lines, returns [] on missing files', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bad-'));
  fs.mkdirSync(path.join(dir, 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'conversations', 'g.db'), 'db');
  fs.writeFileSync(path.join(dir, 'history.jsonl'), [
    'not json at all',
    JSON.stringify({ display: 'Good', workspace: wsDir, timestamp: T0 }),
    '',
  ].join('\n'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const out = listAntigravitySessions(wsDir, path.join(dir, 'history.jsonl'), path.join(dir, 'conversations'));
  assert.deepEqual(out.map((s: any) => s.title), ['Good']);
  // Missing history + missing conv dir → [].
  assert.deepEqual(listAntigravitySessions(wsDir, path.join(dir, 'nope.jsonl'), path.join(dir, 'noconv')), []);
});

test('listAntigravitySessions cwd match is drive-case + slash insensitive (Windows)', (t) => {
  const a = tmpAgy('win', [{ id: 'winc', display: 'Win', workspace: 'C:\\Proj\\App', timestamp: T0 }]);
  t.after(a.cleanup);
  assert.equal(listAntigravitySessions('c:/Proj/App', a.hist, a.conv).length, 1);
  assert.equal(listAntigravitySessions('C:\\Proj\\App', a.hist, a.conv).length, 1);
  assert.equal(listAntigravitySessions('C:\\Other', a.hist, a.conv).length, 0);
});

test('listAntigravitySessions matches the same workspace across OSes by trailing segments', (t) => {
  const a = tmpAgy('xplat', [
    { id: 'xp', display: 'Cross', workspace: "c:\\Obsidian\\Won's 2nd Brain", timestamp: T0 },
  ]);
  t.after(a.cleanup);
  // Same vault on macOS (parent + leaf match) → shown.
  assert.equal(listAntigravitySessions("/Users/rockuen/obsidian/Won's 2nd Brain", a.hist, a.conv).length, 1);
  // Different leaf → not shown.
  assert.equal(listAntigravitySessions('/Users/rockuen/obsidian/other-vault', a.hist, a.conv).length, 0);
});

test('listKiroSessions matches the same workspace across OSes by trailing segments', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-xplat-'));
  fs.writeFileSync(path.join(dir, 'k1.json'), JSON.stringify({
    session_id: 'k1', title: 'Win session', cwd: "c:\\Obsidian\\Won's 2nd Brain",
    updated_at: new Date(T0).toISOString(),
  }));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  assert.equal(listKiroSessions("/Users/rockuen/obsidian/Won's 2nd Brain", dir).length, 1);
  assert.equal(listKiroSessions("c:/Obsidian/Won's 2nd Brain", dir).length, 1);
  assert.equal(listKiroSessions('/Users/rockuen/obsidian/iloom-workspace', dir).length, 0);
});

// ─── Provider: agentMode 'antigravity' ──────────────────────────────────────

test('antigravity provider _storeKey resolves to antigravity-prefixed keys', () => {
  const agy = new SessionTreeDataProvider({}, 'antigravity');
  assert.equal(agy._storeKey('groups'), 'antigravitySessionGroups');
  assert.equal(agy._storeKey('parent'), 'antigravitySessionParent');
  assert.equal(agy._storeKey('sortOrder'), 'antigravitySessionSortOrder');
  assert.equal(agy._storeKey('titles'), 'antigravitySessionTitles');
});

test('antigravity group store is independent of claude + kiro', () => {
  reset();
  const agy = new SessionTreeDataProvider({}, 'antigravity');
  const claude = new SessionTreeDataProvider({}, 'claude');
  const kiro = new SessionTreeDataProvider({}, 'kiro');
  agy._moveToGroup(['conv-a'], 'AgyGroup');
  claude._moveToGroup(['claude-x'], 'ClaudeGroup');
  kiro._moveToGroup(['kiro-x'], 'KiroGroup');
  assert.deepEqual(sessionStoreGet('antigravitySessionGroups', {}), { AgyGroup: ['conv-a'] });
  assert.deepEqual(sessionStoreGet('claudeSessionGroups', {}), { ClaudeGroup: ['claude-x'] });
  assert.deepEqual(sessionStoreGet('kiroSessionGroups', {}), { KiroGroup: ['kiro-x'] });
  assert.equal(JSON.stringify(sessionStoreGet('claudeSessionGroups', {})).includes('conv-a'), false);
});

test('antigravity build groups its conversations + lists the rest under Recent Sessions', () => {
  reset();
  const agy = new SessionTreeDataProvider({}, 'antigravity');
  sessionStoreUpdate('antigravitySessionGroups', { Work: ['conv-a'] });
  const roots = agy._buildAntigravitySessions();
  const groupNode = roots.find((n: any) => n.contextValue === 'customGroup');
  assert.ok(groupNode, 'expected a customGroup node');
  assert.equal(groupNode._groupName, 'Work');
  assert.equal(groupNode._agentMode, 'antigravity');
  assert.equal(groupNode._children.length, 1);
  assert.equal(groupNode._children[0]._sessionId, 'conv-a');
  const recent = roots.find((n: any) => n.contextValue === 'recentGroup');
  assert.ok(recent, 'expected a recentGroup node');
  const ungrouped = recent._children
    .filter((n: any) => n.contextValue === 'antigravitySession')
    .map((n: any) => n._sessionId)
    .sort();
  assert.deepEqual(ungrouped, ['conv-b', 'conv-c']);
});

test('antigravity session item carries the conversation-resume command', () => {
  reset();
  const agy = new SessionTreeDataProvider({}, 'antigravity');
  const roots = agy._buildAntigravitySessions();
  const recent = roots.find((n: any) => n.contextValue === 'recentGroup');
  const item = recent._children.find((n: any) => n._sessionId === 'conv-a');
  assert.ok(item, 'conv-a should be present');
  assert.equal(item.command.command, 'claudeCodeLauncher.resumeSession');
  assert.equal(item.command.arguments[0], 'conv-a');
  assert.deepEqual(item.command.arguments[1], { agent: 'antigravity', antigravityResume: true, cwd: wsDir, title: 'Newest' });
});

test('antigravity nesting persists under the antigravity parent key + renders as children', () => {
  reset();
  const agy = new SessionTreeDataProvider({}, 'antigravity');
  const res = agy.setSessionParent('conv-b', 'conv-a');
  assert.equal(res.ok, true);
  assert.deepEqual(sessionStoreGet('antigravitySessionParent', {}), { 'conv-b': 'conv-a' });
  assert.deepEqual(sessionStoreGet('claudeSessionParent', {}), {});
  const roots = agy._buildAntigravitySessions();
  const recent = roots.find((n: any) => n.contextValue === 'recentGroup');
  const parent = recent._children.find((n: any) => n._sessionId === 'conv-a');
  assert.ok(parent && Array.isArray(parent._children) && parent._children.length === 1);
  assert.equal(parent._children[0]._sessionId, 'conv-b');
  assert.equal(parent._children[0].contextValue, 'subSession');
});

test('antigravity provider uses antigravity-scoped DnD MIME types', () => {
  const agy = new SessionTreeDataProvider({}, 'antigravity');
  const claude = new SessionTreeDataProvider({}, 'claude');
  const kiro = new SessionTreeDataProvider({}, 'kiro');
  assert.notEqual(agy._sessionMime, claude._sessionMime);
  assert.notEqual(agy._sessionMime, kiro._sessionMime);
  assert.notEqual(agy._groupMime, kiro._groupMime);
  assert.match(agy._sessionMime, /antigravitysessions/);
  assert.match(agy._groupMime, /antigravitygroups/);
  assert.deepEqual(agy.dropMimeTypes.sort(), [agy._groupMime, agy._sessionMime].sort());
});

test('cleanup temp workspace', () => {
  process.env.HOME = origHome;
  if (origUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = origUserProfile;
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});
