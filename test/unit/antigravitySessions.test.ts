// Antigravity (agy) session listing + tree-group support.
//
// Phase 1 surfaces agy CLI conversations in a dedicated 'Antigravity Sessions'
// view, reusing SessionTreeDataProvider in agentMode 'antigravity'. Two layers
// are covered here:
//   1. listAntigravitySessions() — parses ~/.gemini/antigravity-cli/history.jsonl
//      (append-only log: dedupe by conversationId, cwd filter, newest first,
//      defensive field/timestamp handling).
//   2. The provider in 'antigravity' mode — group store keys are antigravity-
//      scoped (never touch claude/kiro), build groups + Recent Sessions, nest,
//      and DnD MIME isolation.
//
// NOTE: the history.jsonl path + line schema come from the work-PC handoff
// (agy v1.0.5). These tests pin the parser against fixtures; an end-to-end
// check needs a logged-in agy that actually writes the file.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Module from 'node:module';

// ─── Temp workspace + fake ~/.gemini/antigravity-cli ────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sessions-'));
const wsDir = path.join(tmpRoot, 'workspace');
fs.mkdirSync(wsDir, { recursive: true });

// History file under the default home-relative path the provider reads.
const agyDir = path.join(tmpRoot, '.gemini', 'antigravity-cli');
fs.mkdirSync(agyDir, { recursive: true });
const historyPath = path.join(agyDir, 'history.jsonl');

// Helper: write history.jsonl from an array of line objects.
function writeHistory(lines: any[]) {
  fs.writeFileSync(historyPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

// Three conversations in the workspace cwd (+ one in another cwd that must be
// filtered out). conv-a newest, conv-c oldest.
const T0 = Date.parse('2026-06-04T20:00:00Z');
writeHistory([
  { conversationId: 'conv-c', workspace: wsDir, display: 'Oldest', timestamp: new Date(T0 - 3000).toISOString() },
  { conversationId: 'conv-b', workspace: wsDir, display: 'Middle', timestamp: new Date(T0 - 2000).toISOString() },
  { conversationId: 'conv-a', workspace: wsDir, display: 'Newest', timestamp: new Date(T0 - 1000).toISOString() },
  { conversationId: 'conv-other', workspace: path.join(tmpRoot, 'elsewhere'), display: 'Other cwd', timestamp: new Date(T0).toISOString() },
]);

// ─── Minimal vscode stub (mirrors kiroSessionGroups.test) ───────────────────
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

// Point HOME + USERPROFILE at tmpRoot so os.homedir() (used by
// listAntigravitySessions' default path) resolves to our fixture dir.
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

// ─── Parser: listAntigravitySessions ────────────────────────────────────────

test('listAntigravitySessions parses + filters by cwd, newest first', () => {
  const out = listAntigravitySessions(wsDir);
  // conv-other is a different cwd → filtered out.
  assert.deepEqual(out.map((s: any) => s.sessionId), ['conv-a', 'conv-b', 'conv-c']);
  assert.equal(out[0].title, 'Newest');
  assert.equal(out[0].cwd, wsDir);
  assert.ok(out[0].mtime > out[1].mtime && out[1].mtime > out[2].mtime);
});

test('listAntigravitySessions returns every cwd when none requested', () => {
  const out = listAntigravitySessions(undefined as any);
  assert.equal(out.length, 4);
});

test('listAntigravitySessions dedupes by conversationId — latest record wins', (t) => {
  const file = path.join(tmpRoot, 'dedup.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ conversationId: 'dup', workspace: wsDir, display: 'First title', timestamp: new Date(T0 - 5000).toISOString() }),
    JSON.stringify({ conversationId: 'dup', workspace: wsDir, display: 'Updated title', timestamp: new Date(T0).toISOString() }),
  ].join('\n'));
  t.after(() => { try { fs.unlinkSync(file); } catch {} });
  const out = listAntigravitySessions(wsDir, file);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Updated title'); // newest line's title
});

test('listAntigravitySessions tolerates field-name drift (conversation_id/cwd/title/updated_at)', (t) => {
  const file = path.join(tmpRoot, 'drift.jsonl');
  fs.writeFileSync(file, JSON.stringify({
    conversation_id: 'snake', cwd: wsDir, title: 'Snake fields', updated_at: new Date(T0).toISOString(),
  }) + '\n');
  t.after(() => { try { fs.unlinkSync(file); } catch {} });
  const out = listAntigravitySessions(wsDir, file);
  assert.equal(out.length, 1);
  assert.equal(out[0].sessionId, 'snake');
  assert.equal(out[0].title, 'Snake fields');
  assert.ok(out[0].mtime > 0);
});

test('listAntigravitySessions normalizes epoch-seconds + epoch-ms timestamps', (t) => {
  const file = path.join(tmpRoot, 'ts.jsonl');
  const secs = Math.floor(T0 / 1000);
  fs.writeFileSync(file, [
    JSON.stringify({ conversationId: 'sec', workspace: wsDir, display: 'Seconds', timestamp: secs }),
    JSON.stringify({ conversationId: 'ms', workspace: wsDir, display: 'Millis', timestamp: T0 + 10000 }),
  ].join('\n'));
  t.after(() => { try { fs.unlinkSync(file); } catch {} });
  const out = listAntigravitySessions(wsDir, file);
  // ms (later) sorts before sec; both normalize to epoch-ms in the same era.
  assert.deepEqual(out.map((s: any) => s.sessionId), ['ms', 'sec']);
  assert.ok(Math.abs(out[1].mtime - T0) < 2000); // 'sec' ~ T0 after *1000
});

test('listAntigravitySessions skips malformed lines + lines with no id, returns [] on missing file', (t) => {
  const file = path.join(tmpRoot, 'bad.jsonl');
  fs.writeFileSync(file, [
    'not json at all',
    JSON.stringify({ workspace: wsDir, display: 'no id' }),
    JSON.stringify({ conversationId: 'good', workspace: wsDir, display: 'Good' }),
    '',
  ].join('\n'));
  t.after(() => { try { fs.unlinkSync(file); } catch {} });
  const out = listAntigravitySessions(wsDir, file);
  assert.deepEqual(out.map((s: any) => s.sessionId), ['good']);
  assert.deepEqual(listAntigravitySessions(wsDir, path.join(tmpRoot, 'nope.jsonl')), []);
});

test('listAntigravitySessions cwd match is drive-case + slash insensitive (Windows)', (t) => {
  const file = path.join(tmpRoot, 'winpath.jsonl');
  fs.writeFileSync(file, JSON.stringify({
    conversationId: 'winc', workspace: 'C:\\Proj\\App', display: 'Win', timestamp: T0,
  }) + '\n');
  t.after(() => { try { fs.unlinkSync(file); } catch {} });
  // VSCode may hand us a lowercase drive + forward slashes.
  assert.equal(listAntigravitySessions('c:/Proj/App', file).length, 1);
  assert.equal(listAntigravitySessions('C:\\Proj\\App', file).length, 1);
  assert.equal(listAntigravitySessions('C:\\Other', file).length, 0);
});

test('listAntigravitySessions matches the same workspace across OSes by basename', (t) => {
  // Cross-platform OneDrive-synced vault: a session created on Windows carries a
  // Windows workspace path; the same vault on macOS has a different absolute
  // path but the same leaf folder name, so the basename fallback should match.
  const file = path.join(tmpRoot, 'xplat-agy.jsonl');
  fs.writeFileSync(file, JSON.stringify({
    conversationId: 'xp', workspace: "c:\\Obsidian\\Won's 2nd Brain", display: 'Cross', timestamp: T0,
  }) + '\n');
  t.after(() => { try { fs.unlinkSync(file); } catch {} });
  assert.equal(listAntigravitySessions("/Users/rockuen/obsidian/Won's 2nd Brain", file).length, 1);
  assert.equal(listAntigravitySessions('/Users/rockuen/obsidian/other-vault', file).length, 0);
});

test('listKiroSessions matches the same workspace across OSes by basename', (t) => {
  // Same cross-platform basename fallback for the Kiro session list.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-xplat-'));
  fs.writeFileSync(path.join(dir, 'k1.json'), JSON.stringify({
    session_id: 'k1', title: 'Win session', cwd: "c:\\Obsidian\\Won's 2nd Brain",
    updated_at: new Date(T0).toISOString(),
  }));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  // Same vault, macOS path → basename "won's 2nd brain" matches.
  assert.equal(listKiroSessions("/Users/rockuen/obsidian/Won's 2nd Brain", dir).length, 1);
  // Exact Windows path still matches.
  assert.equal(listKiroSessions("c:/Obsidian/Won's 2nd Brain", dir).length, 1);
  // Different workspace basename → no match.
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
  // No bleed across stores.
  assert.equal(JSON.stringify(sessionStoreGet('claudeSessionGroups', {})).includes('conv-a'), false);
  assert.equal(JSON.stringify(sessionStoreGet('kiroSessionGroups', {})).includes('conv-a'), false);
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
  assert.deepEqual(item.command.arguments[1], { agent: 'antigravity', antigravityResume: true, cwd: wsDir });
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
