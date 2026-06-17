// Unit tests for store/sessionStore.js — deterministic serialization,
// corruption-healing sanitize, and the device-local migration that evicts
// `claudeSessions` (open-tab state) from the git-synced file into workspaceState.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');

// Load src/store/sessionStore.js with a faked `vscode`. When `wsFolder` is
// given it becomes workspaceFolders[0].fsPath so the store reads/writes a real
// temp sessions.json.
function withSessionStore(wsFolder: string | null, fn: (mod: any) => void) {
  const modulePath = path.join(process.cwd(), 'src/store/sessionStore.js');
  const statePath = path.join(process.cwd(), 'src/state.js');
  delete require.cache[require.resolve(modulePath)];
  delete require.cache[require.resolve(statePath)];

  const origLoad = (Module as any)._load;
  (Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'vscode') {
      return {
        workspace: {
          workspaceFolders: wsFolder ? [{ uri: { fsPath: wsFolder } }] : undefined,
        },
      };
    }
    return origLoad.apply(this, [request, ...rest]);
  };
  try {
    fn(require(modulePath));
  } finally {
    (Module as any)._load = origLoad;
  }
}

test('stableStringify sorts object keys deeply and is order-independent', () => {
  withSessionStore(null, (mod) => {
    const a = mod.stableStringify({ b: 1, a: { d: 4, c: 3 } });
    const b = mod.stableStringify({ a: { c: 3, d: 4 }, b: 1 });
    assert.equal(a, b, 'identical logical state serializes byte-identically');
    assert.equal(a, '{\n  "a": {\n    "c": 3,\n    "d": 4\n  },\n  "b": 1\n}');
  });
});

test('sanitizeStore drops blank/duplicate ids inside *SessionGroups', () => {
  withSessionStore(null, (mod) => {
    const out = mod.sanitizeStore({
      claudeSessionGroups: { G: ['a', '', 'a', 'b', null] },
      kiroSessionGroups: { H: ['x', 'x'] },
    });
    assert.deepEqual(out.claudeSessionGroups.G, ['a', 'b']);
    assert.deepEqual(out.kiroSessionGroups.H, ['x']);
  });
});

test('sanitizeStore drops "" key in sort-order/parent and dedupes saved/archived', () => {
  withSessionStore(null, (mod) => {
    const out = mod.sanitizeStore({
      claudeSessionSortOrder: { '': 20, x: 10 },
      claudeSessionParent: { '': 'p', y: 'q' },
      claudeSavedSessions: [{ sessionId: 's1' }, { sessionId: 's1' }, { sessionId: '' }, { sessionId: 's2' }],
      claudeArchivedSessions: [{ sessionId: 'a1' }, { sessionId: 'a1' }],
    });
    assert.deepEqual(out.claudeSessionSortOrder, { x: 10 });
    assert.deepEqual(out.claudeSessionParent, { y: 'q' });
    assert.deepEqual(out.claudeSavedSessions.map((s: any) => s.sessionId), ['s1', 's2']);
    assert.deepEqual(out.claudeArchivedSessions.map((s: any) => s.sessionId), ['a1']);
  });
});

test('sessionStoreUpdate writes sanitized + sorted output to disk', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-store-'));
  try {
    withSessionStore(ws, (mod) => {
      mod.sessionStoreUpdate('claudeSessionGroups', { G: ['a', '', 'a'] });
      mod.sessionStoreUpdate('aaa', 1);
      const raw = fs.readFileSync(path.join(ws, '.claude-launcher', 'sessions.json'), 'utf8');
      const parsed = JSON.parse(raw);
      assert.deepEqual(parsed.claudeSessionGroups.G, ['a'], 'group cleaned on write');
      // Keys are sorted: "aaa" before "claudeSessionGroups".
      assert.ok(raw.indexOf('"aaa"') < raw.indexOf('"claudeSessionGroups"'), 'keys sorted');
    });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('migrate evicts device-local claudeSessions from the file into workspaceState', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-store-'));
  try {
    const dir = path.join(ws, '.claude-launcher');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'sessions.json');
    fs.writeFileSync(file, JSON.stringify({
      claudeSessions: [{ sessionId: 'tab1', cwd: ws }],
      claudeSessionGroups: { G: ['x'] },
    }));

    withSessionStore(ws, (mod) => {
      const localStore: Record<string, any> = {};
      const fakeContext = {
        workspaceState: {
          get: (k: string) => localStore[k],
          update: (k: string, v: any) => { localStore[k] = v; return Promise.resolve(); },
        },
      };
      mod.migrateFromWorkspaceState(fakeContext);

      const after = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(after.claudeSessions, undefined, 'claudeSessions evicted from synced file');
      assert.deepEqual(after.claudeSessionGroups, { G: ['x'] }, 'shared metadata preserved');
      assert.deepEqual(localStore.claudeSessions, [{ sessionId: 'tab1', cwd: ws }], 'seeded into workspaceState');
    });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
