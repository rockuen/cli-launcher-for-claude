// v3.30.2 — Open File / Open Folder handlers end to end, against a stub
// `vscode` and a recording child_process.spawn: what the user selected →
// which process starts with which arguments.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const childProcess = require('child_process');

type Call = unknown[];
const calls: Call[] = [];
let assoc: Record<string, unknown> = {};

const vscodeStub = {
  workspace: {
    getConfiguration: () => ({
      get: (k: string, d: unknown) => (k === 'fileAssociations' ? assoc : k === 'fileLocator' ? { enabled: false } : d),
      inspect: () => undefined,
      update: () => Promise.resolve(),
    }),
    workspaceFolders: [],
  },
  extensions: { getExtension: () => undefined },
  commands: { executeCommand: (...a: unknown[]) => { calls.push(['executeCommand', ...a]); return Promise.resolve(); } },
  window: {
    showTextDocument: (u: any, o: any) => calls.push(['showTextDocument', u.fsPath, o && o.selection ? o.selection.line : null]),
    showWarningMessage: (m: string) => calls.push(['warn', m]),
    showQuickPick: () => Promise.resolve(undefined),
  },
  env: { openExternal: () => Promise.resolve(true), language: 'en' },
  Uri: { file: (p: string) => ({ fsPath: p }), parse: (s: string) => ({ toString: () => s }) },
  Range: class { constructor(public line: number) {} },
  ConfigurationTarget: { Global: 1 },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (this: unknown, req: string, ...rest: unknown[]) {
  return req === 'vscode' ? 'vscode' : origResolve.call(this, req, ...rest);
};
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeStub } as any;

const origSpawn = childProcess.spawn;
childProcess.spawn = (command: string, args: string[], options: any) => {
  calls.push(['spawn', command, args, options && options.windowsVerbatimArguments === true]);
  return { on() { return this; }, unref() {} };
};
process.on('exit', () => { childProcess.spawn = origSpawn; });

const root = process.cwd();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleOpenFolder } = require(path.join(root, 'src/handlers/openFolder.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleOpenFile } = require(path.join(root, 'src/handlers/openFile.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { openFolderCommand } = require(path.join(root, 'src/lib/pathSelection.js'));

function expectedSpawn(target: string, reveal: boolean): Call {
  const c = openFolderCommand(target, { reveal });
  return ['spawn', c.command, c.args, c.options.windowsVerbatimArguments === true];
}

const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'clf-openpath-'));
const vault = path.join(tree, "Won's 2nd Brain");
fs.mkdirSync(path.join(vault, '4. Projects', 'foo'), { recursive: true });
fs.mkdirSync(path.join(vault, 'a,b'), { recursive: true });
fs.writeFileSync(path.join(vault, 'note.md'), '# x\n');
process.on('exit', () => fs.rmSync(tree, { recursive: true, force: true }));
const entry = { cwd: vault };

test('Open Folder: a folder printed with a trailing slash opens itself (not Documents)', () => {
  calls.length = 0;
  handleOpenFolder('4. Projects/foo/', entry);
  assert.deepEqual(calls, [expectedSpawn(path.join(vault, '4. Projects', 'foo'), false)]);
  if (process.platform === 'win32') {
    assert.deepEqual(calls[0][2], ['"' + path.join(vault, '4. Projects', 'foo') + '"']);
    assert.equal(calls[0][3], true);
  }
});

test('Open Folder: a folder with a comma', () => {
  calls.length = 0;
  handleOpenFolder(path.join(vault, 'a,b') + path.sep, entry);
  assert.deepEqual(calls, [expectedSpawn(path.join(vault, 'a,b'), false)]);
});

test('Open Folder on a file reveals the file', () => {
  calls.length = 0;
  handleOpenFolder('`note.md:3`', entry);
  assert.deepEqual(calls, [expectedSpawn(path.join(vault, 'note.md'), true)]);
});

test('Open Folder: a wrapped selection with a particle still resolves', () => {
  calls.length = 0;
  handleOpenFolder(`${vault}${path.sep}4. Projects${path.sep}\n   foo에`, entry);
  assert.deepEqual(calls, [expectedSpawn(path.join(vault, '4. Projects', 'foo'), false)]);
});

test('Open Folder: nothing found warns and starts nothing', () => {
  calls.length = 0;
  handleOpenFolder('no/such/folder', entry);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'warn');
  assert.match(String(calls[0][1]), /no\/such\/folder/);
});

test('Open File on a folder opens the folder instead of "File not found"', async () => {
  calls.length = 0;
  await handleOpenFile('4. Projects/foo', 0, entry);
  assert.deepEqual(calls, [expectedSpawn(path.join(vault, '4. Projects', 'foo'), false)]);
});

test('Open File reads the line from the selection', async () => {
  calls.length = 0;
  assoc = { '.md': 'editor' };
  await handleOpenFile('`note.md:12`를', 0, entry);
  assert.deepEqual(calls, [['showTextDocument', path.join(vault, 'note.md'), 11]]);
});

test('Open File: an explicit line argument wins over the text', async () => {
  calls.length = 0;
  assoc = { '.md': 'editor' };
  await handleOpenFile('note.md:12', 4, entry);
  assert.deepEqual(calls, [['showTextDocument', path.join(vault, 'note.md'), 3]]);
});

test('Open File: nothing found warns with the selection', async () => {
  calls.length = 0;
  await handleOpenFile('missing-file.txt', 0, entry);
  assert.deepEqual(calls, [['warn', 'File not found: missing-file.txt']]);
});

test('a long multi-row selection is shown on one shortened line in the warning', async () => {
  calls.length = 0;
  await handleOpenFile('no such\n   file ' + 'x'.repeat(200), 0, entry);
  assert.equal(calls.length, 1);
  const msg = String(calls[0][1]);
  assert.ok(!msg.includes('\n'));
  assert.ok(msg.endsWith('…'));
  calls.length = 0;
  handleOpenFolder('no such\n   folder', entry);
  assert.deepEqual(calls, [['warn', 'Cannot open folder (invalid or partial path): no such folder']]);
});

test('a folder path with a row of prose after it opens the folder (last resort)', async () => {
  calls.length = 0;
  handleOpenFolder(`${path.join(vault, '4. Projects')}\nsome prose here`, entry);
  assert.deepEqual(calls, [expectedSpawn(path.join(vault, '4. Projects'), false)]);
  calls.length = 0;
  await handleOpenFile(`${path.join(vault, '4. Projects')}\nsome prose here`, 0, entry);
  assert.deepEqual(calls, [expectedSpawn(path.join(vault, '4. Projects'), false)]);
});

test('a name selected a few characters short opens the file, but only after the exact searches', async () => {
  const dir = path.join(vault, '50-resources', '261109 임직원판매');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '26년 11월 LIST_배송지.xlsx'), 'x');
  calls.length = 0;
  assoc = { '.xlsx': 'editor' };
  await handleOpenFile('50-resources\\261109 임직원판매\\26년 11월 LIST_배송지.xls', 0, entry);
  assert.deepEqual(calls, [['showTextDocument', path.join(dir, '26년 11월 LIST_배송지.xlsx'), null]]);
  // An exact name found by the walk under cwd beats a longer name next to the text.
  fs.mkdirSync(path.join(vault, 'config'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'config', 'app.yml.bak'), 'x');
  fs.mkdirSync(path.join(vault, 'services', 'x', 'config'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'services', 'x', 'config', 'app.yml'), 'x');
  calls.length = 0;
  assoc = { '.yml': 'editor', '.bak': 'editor' };
  await handleOpenFile('config/app.yml', 0, entry);
  assert.deepEqual(calls, [['showTextDocument', path.join(vault, 'services', 'x', 'config', 'app.yml'), null]]);
});

test('brace selections still open every expansion', async () => {
  fs.mkdirSync(path.join(vault, 'worker-1'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'worker-2'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'worker-1', 'a.md'), 'x');
  fs.writeFileSync(path.join(vault, 'worker-2', 'a.md'), 'x');
  calls.length = 0;
  handleOpenFolder('`worker-{1,2}/a.md`', entry);
  assert.deepEqual(calls, [
    expectedSpawn(path.join(vault, 'worker-1', 'a.md'), true),
    expectedSpawn(path.join(vault, 'worker-2', 'a.md'), true),
  ]);
  calls.length = 0;
  assoc = { '.md': 'editor' };
  await handleOpenFile('worker-{1,2}/a.md', 0, entry);
  assert.deepEqual(calls, [
    ['showTextDocument', path.join(vault, 'worker-1', 'a.md'), null],
    ['showTextDocument', path.join(vault, 'worker-2', 'a.md'), null],
  ]);
});
