// File-link open method resolution + first-install defaults.
//
// v3.25.0: `.md` defaults to 'auto' — NoteWise Markdown Editor when installed,
// otherwise the IDE's default editor (was: Obsidian). The settings panel stores
// only overrides, and a map the old panel froze is migrated once. Quick Actions
// and CCG views start hidden on first install.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/* eslint-disable @typescript-eslint/no-var-requires */
const {
  resolveOpenMethod,
  visibleFileAssociations,
  fileAssociationOverrides,
  migrateFrozenFileAssociations,
  LEGACY_FILE_ASSOC_DEFAULTS,
  NOTEWISE_EXTENSION_ID,
  NOTEWISE_VIEW_TYPE,
} = require(path.join(process.cwd(), 'src/lib/openMethod'));

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), ...rel.split('/')), 'utf8');
}

function pkg(): any {
  return JSON.parse(read('package.json'));
}

function settingProps(): Record<string, any> {
  const conf = pkg().contributes.configuration;
  return Array.isArray(conf)
    ? Object.assign({}, ...conf.map((b: any) => b.properties || {}))
    : (conf.properties || {});
}

const DEFAULTS: Record<string, string> = settingProps()['claudeCodeLauncher.fileAssociations'].default;

// ---- resolveOpenMethod ----

test('auto .md opens NoteWise when installed, the IDE default otherwise', () => {
  assert.equal(resolveOpenMethod('.md', { '.md': 'auto' }, { notewiseInstalled: true }), 'notewise');
  assert.equal(resolveOpenMethod('.md', { '.md': 'auto' }, { notewiseInstalled: false }), 'default');
  // No entry (or a removed default stored as null) behaves like 'auto'
  assert.equal(resolveOpenMethod('.md', {}, { notewiseInstalled: true }), 'notewise');
  assert.equal(resolveOpenMethod('.md', { '.md': null }, { notewiseInstalled: true }), 'notewise');
  assert.equal(resolveOpenMethod('.md', undefined, {}), 'default');
  assert.equal(resolveOpenMethod('.markdown', {}, { notewiseInstalled: true }), 'notewise');
});

test('an explicit .md choice is kept as-is', () => {
  for (const m of ['obsidian', 'editor', 'default', 'system', 'C:\\Tools\\Typora.exe']) {
    assert.equal(resolveOpenMethod('.md', { '.md': m }, { notewiseInstalled: true }), m);
  }
  assert.equal(resolveOpenMethod('.md', { '.md': 'notewise' }, { notewiseInstalled: true }), 'notewise');
});

test('notewise without NoteWise installed falls back to the IDE default', () => {
  assert.equal(resolveOpenMethod('.md', { '.md': 'notewise' }, { notewiseInstalled: false }), 'default');
  assert.equal(resolveOpenMethod('.md', { '.md': 'notewise' }), 'default');
});

test('non-markdown extensions are untouched', () => {
  assert.equal(resolveOpenMethod('.ts', {}, { notewiseInstalled: true }), 'auto');
  assert.equal(resolveOpenMethod('.csv', { '.csv': 'excel' }, { notewiseInstalled: true }), 'excel');
  assert.equal(resolveOpenMethod('.html', { '.html': 'browser' }, {}), 'browser');
});

test('NoteWise ids match the NoteWise extension', () => {
  assert.equal(NOTEWISE_EXTENSION_ID, 'rockuen.notewise-editor');
  assert.equal(NOTEWISE_VIEW_TYPE, 'notewise.editor');
});

// ---- storage: overrides only ----

test('the panel stores only what differs from the defaults', () => {
  // Unchanged map → nothing to store
  assert.deepEqual(fileAssociationOverrides({ ...DEFAULTS }, DEFAULTS), {});
  // A changed default and an added extension are stored; the rest is not
  assert.deepEqual(
    fileAssociationOverrides({ ...DEFAULTS, '.md': 'obsidian', '.txt': 'editor' }, DEFAULTS),
    { '.md': 'obsidian', '.txt': 'editor' },
  );
  // A removed default is stored as null so the merge cannot bring it back
  const withoutCsv: Record<string, string> = { ...DEFAULTS };
  delete withoutCsv['.csv'];
  assert.deepEqual(fileAssociationOverrides(withoutCsv, DEFAULTS), { '.csv': null });
  // Junk values are not stored
  assert.deepEqual(fileAssociationOverrides({ ...DEFAULTS, '.x': '', '.y': 3 }, DEFAULTS), {});
  assert.deepEqual(fileAssociationOverrides(null, { '.md': 'auto' }), { '.md': null });
});

test('removed defaults (null) are hidden from the panel list', () => {
  assert.deepEqual(visibleFileAssociations({ '.md': 'auto', '.csv': null, '.txt': 'editor' }), { '.md': 'auto', '.txt': 'editor' });
  assert.deepEqual(visibleFileAssociations(undefined), {});
});

// ---- one-time migration of a panel-frozen map ----

test('a map the old panel froze is reduced to the user\'s own entries', () => {
  // Exactly the old default → nothing left to store
  assert.deepEqual(migrateFrozenFileAssociations({ ...LEGACY_FILE_ASSOC_DEFAULTS }, DEFAULTS), {});
  // Old default plus an added entry → only the added entry survives
  assert.deepEqual(
    migrateFrozenFileAssociations({ ...LEGACY_FILE_ASSOC_DEFAULTS, '.txt': 'editor' }, DEFAULTS),
    { '.txt': 'editor' },
  );
  // A default the user changed in the old panel is kept; .md still migrates
  assert.deepEqual(
    migrateFrozenFileAssociations({ ...LEGACY_FILE_ASSOC_DEFAULTS, '.pdf': 'browser' }, DEFAULTS),
    { '.pdf': 'browser' },
  );
  // A null synced from a v3.25 device into a v3.24 panel's rewrite is kept as a removal
  assert.deepEqual(
    migrateFrozenFileAssociations({ ...LEGACY_FILE_ASSOC_DEFAULTS, '.csv': null }, DEFAULTS),
    { '.csv': null },
  );
});

test('maps the old panel did not freeze are left alone', () => {
  // A hand-written Obsidian choice is deliberate
  assert.equal(migrateFrozenFileAssociations({ '.md': 'obsidian' }, DEFAULTS), null);
  // The owner's own map: .md already moved off Obsidian
  assert.equal(migrateFrozenFileAssociations({ ...LEGACY_FILE_ASSOC_DEFAULTS, '.md': 'notewise' }, DEFAULTS), null);
  // A legacy key missing → not a map the old panel wrote whole
  const partial: Record<string, string> = { ...LEGACY_FILE_ASSOC_DEFAULTS };
  delete partial['.svg'];
  assert.equal(migrateFrozenFileAssociations(partial, DEFAULTS), null);
  // Already-migrated overrides do not re-trigger
  assert.equal(migrateFrozenFileAssociations({ '.txt': 'editor' }, DEFAULTS), null);
  assert.equal(migrateFrozenFileAssociations(undefined, DEFAULTS), null);
});

test('the legacy snapshot differs from today\'s defaults only in .md', () => {
  const legacy = { ...LEGACY_FILE_ASSOC_DEFAULTS };
  assert.equal(legacy['.md'], 'obsidian');
  delete legacy['.md'];
  const now = { ...DEFAULTS };
  delete now['.md'];
  assert.deepEqual(legacy, now);
});

// ---- package.json ----

test('package.json defaults .md to auto (no longer Obsidian)', () => {
  assert.equal(DEFAULTS['.md'], 'auto');
});

test('Quick Actions and CCG views start hidden; session views keep new-session + settings', () => {
  const views: any[] = pkg().contributes.views['claude-code-launcher'];
  const byId = (id: string) => views.find((v) => v.id === id);
  assert.equal(byId('claudeCodeLauncher.quickActions').visibility, 'hidden');
  assert.equal(byId('claudeCodeLauncher.ccgPanel').visibility, 'hidden');
  assert.equal(byId('claudeCodeLauncher.unifiedSessions').visibility, undefined);
  assert.equal(byId('claudeCodeLauncher.sessionList').visibility, undefined);
  const titleMenus: any[] = pkg().contributes.menus['view/title'];
  const commandsFor = (view: string) =>
    titleMenus.filter((m) => m.when === `view == ${view}`).map((m) => m.command);
  const unified = commandsFor('claudeCodeLauncher.unifiedSessions');
  assert.ok(unified.includes('claudeCodeLauncher.newSessionPick'));
  assert.ok(unified.includes('claudeCodeLauncher.openSettings'));
  const split = commandsFor('claudeCodeLauncher.sessionList');
  assert.ok(split.includes('claudeCodeLauncher.newClaude'));
  assert.ok(split.includes('claudeCodeLauncher.openSettings'));
});

// ---- runtime: handlers/openFile.js against a stub vscode ----

type Call = [string, ...unknown[]];

function loadOpenFileWithStub() {
  const Module = require('module');
  const env = {
    calls: [] as Call[],
    notewise: false,
    assoc: {} as Record<string, unknown>,
    inspect: undefined as any,
  };
  const vscodeStub = {
    workspace: {
      getConfiguration: () => ({
        get: (k: string, d: unknown) => (k === 'fileAssociations' ? env.assoc : d),
        inspect: () => env.inspect,
        update: (k: string, v: unknown, target: unknown) => {
          env.calls.push(['update', k, v, target]);
          return Promise.resolve();
        },
      }),
      workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
    },
    extensions: {
      getExtension: (id: string) => (env.notewise && id === NOTEWISE_EXTENSION_ID ? { id } : undefined),
    },
    commands: {
      executeCommand: (...a: unknown[]) => {
        env.calls.push(['executeCommand', ...a.map((x: any) => (x && x.fsPath ? 'uri:' + path.basename(x.fsPath) : x))]);
        return Promise.resolve();
      },
    },
    window: {
      showTextDocument: (u: any, o: unknown) => env.calls.push(['showTextDocument', path.basename(u.fsPath), o]),
      showWarningMessage: (m: string) => env.calls.push(['warn', m]),
    },
    env: { openExternal: (u: unknown) => env.calls.push(['openExternal', String(u)]), language: 'en' },
    Uri: { file: (p: string) => ({ fsPath: p }), parse: (s: string) => ({ toString: () => s }) },
    Range: class { constructor(public line: number) {} },
    ConfigurationTarget: { Global: 1 },
  };
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (this: unknown, req: string, ...rest: unknown[]) {
    return req === 'vscode' ? 'vscode' : origResolve.call(this, req, ...rest);
  };
  require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeStub } as any;
  const modPath = path.join(process.cwd(), 'src/handlers/openFile.js');
  delete require.cache[require.resolve(modPath)];
  const mod = require(modPath);
  return { mod, env };
}

const { mod: openFile, env: stub } = loadOpenFileWithStub();
const README = path.join(process.cwd(), 'README.md');

async function openReadme(assoc: Record<string, unknown>, notewise: boolean): Promise<Call[]> {
  stub.calls = [];
  stub.assoc = assoc;
  stub.notewise = notewise;
  await openFile.handleOpenFile(README, 12, { cwd: process.cwd() });
  return stub.calls;
}

test('handleOpenFile: auto .md → NoteWise when installed', async () => {
  assert.deepEqual(await openReadme({ '.md': 'auto' }, true), [
    ['executeCommand', 'vscode.openWith', 'uri:README.md', 'notewise.editor'],
  ]);
});

test('handleOpenFile: auto .md without NoteWise → vscode.open at the line', async () => {
  const calls = await openReadme({ '.md': 'auto' }, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), ['executeCommand', 'vscode.open', 'uri:README.md']);
  assert.equal((calls[0][3] as any).selection.line, 11);
});

test('handleOpenFile: explicit choices keep their routes', async () => {
  assert.deepEqual((await openReadme({ '.md': 'notewise' }, false))[0].slice(0, 2), ['executeCommand', 'vscode.open']);
  assert.match(String((await openReadme({ '.md': 'obsidian' }, true))[0][1]), /^obsidian:\/\/open\?/);
  assert.equal((await openReadme({ '.md': 'editor' }, true))[0][0], 'showTextDocument');
});

test('handleOpenFile: a failed open shows a warning instead of a silent rejection', async () => {
  const exec = (require('vscode') as any).commands;
  const orig = exec.executeCommand;
  exec.executeCommand = () => Promise.reject(new Error('boom'));
  try {
    await openReadme({ '.md': 'auto' }, false);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(stub.calls, [['warn', 'Open file failed: boom']]);
  } finally {
    exec.executeCommand = orig;
  }
});

test('migrateFileAssociationsSetting rewrites only a frozen Global map', () => {
  stub.calls = [];
  stub.inspect = { defaultValue: DEFAULTS, globalValue: { ...LEGACY_FILE_ASSOC_DEFAULTS, '.txt': 'editor' } };
  openFile.migrateFileAssociationsSetting();
  assert.deepEqual(stub.calls, [['update', 'fileAssociations', { '.txt': 'editor' }, 1]]);

  stub.calls = [];
  stub.inspect = { defaultValue: DEFAULTS, globalValue: { ...LEGACY_FILE_ASSOC_DEFAULTS } };
  openFile.migrateFileAssociationsSetting();
  assert.deepEqual(stub.calls, [['update', 'fileAssociations', undefined, 1]]);

  stub.calls = [];
  stub.inspect = { defaultValue: DEFAULTS, globalValue: { '.md': 'obsidian' } };
  openFile.migrateFileAssociationsSetting();
  assert.deepEqual(stub.calls, []);
});

test('activation runs the migration and the panel stores overrides', () => {
  assert.match(read('src/activation.js'), /migrateFileAssociationsSetting\(\);/);
  const panel = read('src/panel/settingsPanel.js');
  assert.match(panel, /fileAssociationOverrides\(value, info && info\.defaultValue\)/);
  assert.match(panel, /visibleFileAssociations\(Object\.assign\(/);
  assert.match(panel, /\(cfg\.inspect\('fileAssociations'\) \|\| \{\}\)\.globalValue/);
});
