// Kiro Sessions group support — behavioural round-trip tests.
//
// The Kiro Sessions view reuses SessionTreeDataProvider in agentMode 'kiro'.
// Group definitions, membership, ordering, nesting and sort all persist under
// kiro-only store keys (kiroSessionGroups / kiroSessionParent / ...), fully
// separate from the claude keys (claudeSessionGroups / ...). These tests inject
// a minimal `vscode` stub + a temp workspace so the real sessionStore performs
// a genuine file round-trip, then assert:
//   - kiro group membership saves/loads under the kiro key
//   - claude and kiro group stores never touch each other (independence)
//   - the kiro view build groups its sessions + lists ungrouped flat

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Module from 'node:module';

// ─── Temp workspace + fake kiro sessions dir ────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-groups-'));
const wsDir = path.join(tmpRoot, 'workspace');
const kiroDir = path.join(tmpRoot, 'kiro-sessions');
fs.mkdirSync(wsDir, { recursive: true });
fs.mkdirSync(kiroDir, { recursive: true });

// Three kiro session metas, all in the workspace cwd.
const KIRO_IDS = ['kiro-aaaa', 'kiro-bbbb', 'kiro-cccc'];
KIRO_IDS.forEach((id, i) => {
  fs.writeFileSync(
    path.join(kiroDir, `${id}.json`),
    JSON.stringify({
      session_id: id,
      title: `Kiro ${i}`,
      cwd: wsDir,
      updated_at: new Date(Date.now() - i * 1000).toISOString(),
    }),
  );
});

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
  EventEmitter: class {
    event = () => {};
    fire() {}
  },
  ThemeIcon: class { constructor(public id: string) {} },
  TreeItem: FakeTreeItem,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  DataTransferItem: class { constructor(public value: any) {} },
};

// Inject the vscode stub into the module loader before requiring the provider.
const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, [request, ...rest]);
};

// sessionJsonl reads kiro metas from ~/.kiro/sessions/cli by default; the
// listKiroSessions signature accepts an override dir as the 2nd arg, but the
// provider calls it with cwd only. We point HOME at tmpRoot and place the metas
// under <HOME>/.kiro/sessions/cli so the default path resolves to our fixtures.
const kiroDefaultDir = path.join(tmpRoot, '.kiro', 'sessions', 'cli');
fs.mkdirSync(kiroDefaultDir, { recursive: true });
for (const id of KIRO_IDS) {
  fs.copyFileSync(path.join(kiroDir, `${id}.json`), path.join(kiroDefaultDir, `${id}.json`));
}
const origHome = process.env.HOME;
process.env.HOME = tmpRoot;

const { sessionStoreGet, sessionStoreUpdate } = require('../../src/store/sessionStore');
const { SessionTreeDataProvider } = require('../../src/tree/SessionTreeDataProvider');

// Restore loader after require so other test files aren't affected.
(Module as any)._load = origLoad;

function reset() {
  // Wipe the sessions.json between tests for a clean store.
  const f = path.join(wsDir, '.claude-launcher', 'sessions.json');
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

test('kiro provider _storeKey resolves to kiro-prefixed keys', () => {
  const kiro = new SessionTreeDataProvider({}, 'kiro');
  assert.equal(kiro._storeKey('groups'), 'kiroSessionGroups');
  assert.equal(kiro._storeKey('parent'), 'kiroSessionParent');
  assert.equal(kiro._storeKey('sortOrder'), 'kiroSessionSortOrder');

  const claude = new SessionTreeDataProvider({}, 'claude');
  assert.equal(claude._storeKey('groups'), 'claudeSessionGroups');
  assert.equal(claude._storeKey('parent'), 'claudeSessionParent');
});

test('kiro group membership saves + loads under the kiro key', () => {
  reset();
  const kiro = new SessionTreeDataProvider({}, 'kiro');
  kiro._moveToGroup(['kiro-aaaa', 'kiro-bbbb'], 'Work');
  // Persisted under the kiro key, NOT the claude key.
  assert.deepEqual(sessionStoreGet('kiroSessionGroups', {}), { Work: ['kiro-aaaa', 'kiro-bbbb'] });
  assert.deepEqual(sessionStoreGet('claudeSessionGroups', {}), {});
});

test('kiro and claude group stores are fully independent', () => {
  reset();
  const kiro = new SessionTreeDataProvider({}, 'kiro');
  const claude = new SessionTreeDataProvider({}, 'claude');
  kiro._moveToGroup(['kiro-aaaa'], 'KiroGroup');
  claude._moveToGroup(['claude-xyz'], 'ClaudeGroup');
  assert.deepEqual(sessionStoreGet('kiroSessionGroups', {}), { KiroGroup: ['kiro-aaaa'] });
  assert.deepEqual(sessionStoreGet('claudeSessionGroups', {}), { ClaudeGroup: ['claude-xyz'] });
  // Moving a kiro session must never appear in the claude store.
  const claudeGroups = sessionStoreGet('claudeSessionGroups', {});
  assert.equal(JSON.stringify(claudeGroups).includes('kiro-aaaa'), false);
});

test('kiro build groups its sessions and lists the rest ungrouped', () => {
  reset();
  const kiro = new SessionTreeDataProvider({}, 'kiro');
  // Group one session; the other two stay ungrouped.
  sessionStoreUpdate('kiroSessionGroups', { Work: ['kiro-aaaa'] });
  const roots = kiro._buildKiroSessions();
  // First node = the custom group 'Work'.
  const groupNode = roots.find((n: any) => n.contextValue === 'customGroup');
  assert.ok(groupNode, 'expected a customGroup node');
  assert.equal(groupNode._groupName, 'Work');
  assert.equal(groupNode._agentMode, 'kiro');
  assert.equal(groupNode._children.length, 1);
  assert.equal(groupNode._children[0]._sessionId, 'kiro-aaaa');
  // Ungrouped sessions appear flat after the group.
  const ungrouped = roots.filter((n: any) => n.contextValue === 'kiroSession');
  const ungroupedIds = ungrouped.map((n: any) => n._sessionId).sort();
  assert.deepEqual(ungroupedIds, ['kiro-bbbb', 'kiro-cccc']);
});

test('kiro nesting persists under the kiro parent key and renders as children', () => {
  reset();
  const kiro = new SessionTreeDataProvider({}, 'kiro');
  const res = kiro.setSessionParent('kiro-bbbb', 'kiro-aaaa');
  assert.equal(res.ok, true);
  assert.deepEqual(sessionStoreGet('kiroSessionParent', {}), { 'kiro-bbbb': 'kiro-aaaa' });
  assert.deepEqual(sessionStoreGet('claudeSessionParent', {}), {});
  const roots = kiro._buildKiroSessions();
  const parent = roots.find((n: any) => n._sessionId === 'kiro-aaaa');
  assert.ok(parent, 'parent session should be a root node');
  assert.ok(Array.isArray(parent._children) && parent._children.length === 1);
  assert.equal(parent._children[0]._sessionId, 'kiro-bbbb');
  assert.equal(parent._children[0].contextValue, 'subSession');
  // The nested child must NOT also appear at root level.
  const rootIds = roots.filter((n: any) => n.contextValue === 'kiroSession' || n.contextValue === 'subSession').map((n: any) => n._sessionId);
  assert.equal(rootIds.includes('kiro-bbbb'), false);
});

test('kiro provider uses kiro-scoped DnD MIME types', () => {
  const kiro = new SessionTreeDataProvider({}, 'kiro');
  const claude = new SessionTreeDataProvider({}, 'claude');
  // No overlap between the two providers' session/group MIMEs.
  assert.notEqual(kiro._sessionMime, claude._sessionMime);
  assert.notEqual(kiro._groupMime, claude._groupMime);
  assert.match(kiro._sessionMime, /kirosessions/);
  assert.match(kiro._groupMime, /kirogroups/);
  // dropMimeTypes carries only this agent's pair.
  assert.deepEqual(kiro.dropMimeTypes.sort(), [kiro._groupMime, kiro._sessionMime].sort());
  assert.equal(kiro.dropMimeTypes.includes(claude._sessionMime), false);
});

test('cleanup temp workspace', () => {
  process.env.HOME = origHome;
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});
