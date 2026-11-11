// v3.30.2 — reading a selection / link target as a path, and opening folders.
//
// Regression cover for "Open Folder opens Documents" and "Open File / Open
// Folder can't find a path I selected" (see src/lib/pathSelection.js):
//   - explorer.exe falls back to Documents for `"C:\a b\\"` (Node's quoting of
//     a folder with spaces and a trailing backslash) and for an unquoted comma;
//   - selections arrive wrapped across rows, quoted, with particles, line
//     suffixes, file:// URLs and Git Bash paths.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sel = require(path.join(process.cwd(), 'src/lib/pathSelection'));

const W = { platform: 'win32' };
const P = { platform: 'linux' };
const readings = (raw: string, opts = W) =>
  sel.pathCandidates(raw, opts).map((c: { path: string; line: number }) => (c.line ? `${c.path}@${c.line}` : c.path));

// ── pathCandidates ────────────────────────────────────────────────────────

test('the literal text is always the first reading', () => {
  assert.equal(readings('C:\\dev\\foo')[0], 'C:\\dev\\foo');
  assert.equal(readings('한글 폴더')[0], '한글 폴더');
  assert.equal(readings('C:\\Program Files (x86)')[0], 'C:\\Program Files (x86)');
});

test('quotes, backticks and trailing punctuation are stripped', () => {
  assert.ok(readings('`src/foo.ts`').includes('src/foo.ts'));
  assert.ok(readings('"C:\\a b\\c"').includes('C:\\a b\\c'));
  assert.ok(readings('C:\\dev\\foo.').includes('C:\\dev\\foo'));
  assert.ok(readings('C:\\dev\\foo,').includes('C:\\dev\\foo'));
  assert.ok(readings('「C:\\dev\\foo」').includes('C:\\dev\\foo'));
});

test('balanced brackets stay, a stray one goes', () => {
  assert.deepEqual(readings('C:\\Program Files (x86)'), ['C:\\Program Files (x86)']);
  assert.ok(readings('(C:\\dev\\foo').includes('C:\\dev\\foo'));
  assert.ok(readings('C:\\dev\\foo)').includes('C:\\dev\\foo'));
});

test('tool-call lines yield their argument', () => {
  assert.ok(readings('Read(src/foo.ts)').includes('src/foo.ts'));
  assert.ok(readings('⏺ Write(C:\\x\\y.md)').includes('C:\\x\\y.md'));
  // A file with a (line,col) suffix is not a tool call, and neither is a
  // name with a number in parentheses: "2" / "12" could match some folder.
  assert.ok(!readings('foo.cs(12,5)').includes('12,5'));
  assert.ok(!readings('Backup(2)').includes('2'));
  assert.ok(!readings('Makefile(12)').includes('12'));
  assert.ok(readings('Makefile(12)').includes('Makefile@12'));
});

test('Korean particles glued to a path are a reading, after the literal', () => {
  const r = readings('C:\\dev\\foo에');
  assert.deepEqual(r.slice(0, 2), ['C:\\dev\\foo에', 'C:\\dev\\foo']);
  assert.ok(readings('`README.md`를').includes('README.md'));
  assert.ok(readings('src/foo에서').includes('src/foo'));
  // Never after a separator or a space: those Hangul words are names.
  assert.ok(!readings('foo/문서').includes('foo/'));
  assert.ok(!readings('한글 폴더').includes('한글 '));
});

test('line suffixes: :L, :L:C, (L,C), #L', () => {
  assert.ok(readings('src/foo.ts:12').includes('src/foo.ts@12'));
  assert.ok(readings('src/foo.ts:12:5').includes('src/foo.ts@12'));
  assert.ok(readings('foo.cs(12,5)').includes('foo.cs@12'));
  assert.ok(readings('README.md#L20').includes('README.md@20'));
  assert.ok(readings('README.md#L20-L30').includes('README.md@20'));
  assert.ok(readings('C:\\x\\foo.ts:7').includes('C:\\x\\foo.ts@7'));
  // A bare drive is not "path C, line …".
  assert.ok(!readings('C:\\x').some((r: string) => r.startsWith('C@')));
});

test('file:// URLs are decoded; /C:/ loses its leading slash on Windows', () => {
  assert.equal(readings('file:///C:/Users/x%20y/a.md')[0], 'C:/Users/x y/a.md');
  // Two slashes, the drive where the host goes.
  assert.equal(readings('file://C:/dev/foo')[0], 'C:/dev/foo');
  assert.equal(readings('file://c:/dev/a%20b')[0], 'c:/dev/a b');
  assert.equal(readings('file:///home/me/a%20b.txt', P)[0], '/home/me/a b.txt');
});

test('a file:// host never becomes a UNC path (no SMB connection to a host from agent output)', () => {
  for (const r of readings('file://attacker.example/share/x')) assert.ok(!r.startsWith('//') && !r.startsWith('\\\\'), r);
  assert.equal(readings('file://attacker.example/share/x')[0], '/share/x');
});

test('Git Bash and WSL drive paths map to drive letters on Windows only', () => {
  assert.equal(readings('/c/dev/foo/')[0], 'C:/dev/foo/');
  assert.equal(readings('/mnt/d/data')[0], 'D:/data');
  // A bare "/d" is not read as a drive.
  assert.deepEqual(readings('/d'), ['/d']);
  assert.deepEqual(readings('/c/dev/foo', P), ['/c/dev/foo']);
  // Not a drive: a longer first segment stays as it is.
  assert.deepEqual(readings('/usr/bin'), ['/usr/bin']);
});

test('a path wrapped across rows is joined (no space and one space), then each row', () => {
  const r = readings("  ⏺ C:\\obsidian\\Won's 2nd\n    Brain\\notes\n");
  assert.ok(r.includes("C:\\obsidian\\Won's 2ndBrain\\notes"));
  assert.ok(r.includes("C:\\obsidian\\Won's 2nd Brain\\notes"));
  assert.ok(r.indexOf("C:\\obsidian\\Won's 2nd Brain\\notes") < r.indexOf('Brain\\notes'));
  assert.ok(readings('C:\\very\\long\\pa\r\nth\\x.md').includes('C:\\very\\long\\path\\x.md'));
});

test('row caps: no join past 6 rows, at most 10 rows read', () => {
  const many = Array.from({ length: 30 }, (_, i) => `row${i}`).join('\n');
  const r = readings(many);
  assert.ok(!r.some((x: string) => x.includes('row0row1')));
  assert.ok(r.includes('row9'));
  assert.ok(!r.includes('row10'));
});

test('blank input has no readings', () => {
  assert.deepEqual(readings(''), []);
  assert.deepEqual(readings('  \n \n'), []);
  assert.deepEqual(sel.pathCandidates(undefined, W), []);
});

test('long input is not read at all, and punctuation runs stay linear', () => {
  assert.deepEqual(readings('a'.repeat(9000)), []);
  // A `[…]+$` regex took ~0.14 s on this and grows quadratically.
  const input = 'x' + '.'.repeat(8000) + 'y';
  const t0 = process.hrtime.bigint();
  sel.pathCandidates(input, W);
  sel.fallbackQuery(input, W);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 60, `took ${ms} ms`);
});

test('previewText: one line, shortened', () => {
  assert.equal(sel.previewText('  a\n   b  '), 'a b');
  assert.equal(sel.previewText('x'.repeat(100)), 'x'.repeat(80) + '…');
  assert.equal(sel.previewText(undefined), '');
});

test('fallbackQuery: the cleaned selection without its line suffix', () => {
  assert.deepEqual(sel.fallbackQuery('`src/foo.ts:12`를', W), { path: 'src/foo.ts', line: 12 });
  assert.deepEqual(sel.fallbackQuery('slack-manifests/x.yaml', W), { path: 'slack-manifests/x.yaml', line: 0 });
  assert.deepEqual(sel.fallbackQuery('', W), { path: '', line: 0 });
});

// ── resolveSelection / findUnderCwd against a real tree ───────────────────

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clf-pathsel-'));
  const mk = (rel: string) => fs.mkdirSync(path.join(root, rel), { recursive: true });
  const touch = (rel: string) => { mk(path.dirname(rel)); fs.writeFileSync(path.join(root, rel), 'x'); };
  mk("Won's 2nd Brain/4. Projects/foo");
  mk('한글 폴더');
  touch('src/handlers/openFolder.js');
  touch('deep/a/b/slack-manifests/x.yaml');
  touch('README.md');
  return root;
}

test('resolveSelection: the first reading that exists wins, with line and kind', () => {
  const root = makeTree();
  try {
    const vault = path.join(root, "Won's 2nd Brain");
    let hit = sel.resolveSelection('4. Projects/foo/', vault);
    assert.equal(hit.isDir, true);
    assert.equal(path.resolve(hit.path), path.join(vault, '4. Projects', 'foo'));

    hit = sel.resolveSelection('`src/handlers/openFolder.js:80`', root);
    assert.equal(hit.isDir, false);
    assert.equal(hit.line, 80);
    assert.equal(hit.path, path.join(root, 'src', 'handlers', 'openFolder.js'));

    hit = sel.resolveSelection('README.md를', root);
    assert.equal(hit.path, path.join(root, 'README.md'));

    hit = sel.resolveSelection('한글 폴더', root);
    assert.equal(hit.path, path.join(root, '한글 폴더'));

    // Wrapped at the space in "2nd Brain" (Ink drops the space).
    const wrapped = `${root}${path.sep}Won's 2nd\n   Brain${path.sep}4. Projects`;
    hit = sel.resolveSelection(wrapped, root);
    assert.equal(hit.path, path.join(vault, '4. Projects'));

    assert.equal(sel.resolveSelection('no/such/thing.txt', root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveSelection: a name selected a few characters short completes to the one file it starts', () => {
  const root = makeTree();
  try {
    const dir = path.join(root, '50-resources', '261109 임직원판매');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '26년 11월 LIST_배송지.xlsx'), 'x');
    fs.writeFileSync(path.join(dir, 'a.md'), 'x');
    fs.writeFileSync(path.join(dir, 'a.mdx'), 'x');
    const short = { completeShort: true };
    // Only on request: the plain pass never guesses.
    assert.equal(sel.resolveSelection('50-resources\\261109 임직원판매\\26년 11월 LIST_배송지.xls', root), null);
    // The drag stopped before the last "x" (the case from the screenshot).
    let hit = sel.resolveSelection('50-resources\\261109 임직원판매\\26년 11월 LIST_배송지.xls', root, short);
    assert.equal(hit && hit.path, path.join(dir, '26년 11월 LIST_배송지.xlsx'));
    hit = sel.resolveSelection('`50-resources/261109 임직원판매/26년 11월 LIST_배송지.xl`', root, short);
    assert.equal(hit && hit.path, path.join(dir, '26년 11월 LIST_배송지.xlsx'));
    // An exact name is found by the plain pass first.
    assert.equal(sel.resolveSelection('50-resources/261109 임직원판매/a.md', root).path, path.join(dir, 'a.md'));
    // Two candidates: no guess.
    assert.equal(sel.resolveSelection('50-resources/261109 임직원판매/a.m', root, short), null);
    // The name has not reached an extension, or too much is missing: no guess.
    assert.equal(sel.resolveSelection('50-resources/261109 임직원판매/26년 11월 LIST', root, short), null);
    assert.equal(sel.resolveSelection('50-resources/261109 임직원판매/26년 11월 LIST_배.x', root, short), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveSelection: one row of a multi-row selection never resolves to a folder', () => {
  const root = makeTree();
  try {
    // The first half of a wrapped path, selected only in part: "<root>/src/" + "hand".
    assert.equal(sel.resolveSelection(`${root}${path.sep}src${path.sep}\n   hand`, root), null);
    // A row that names a file still opens (path plus some text on the next row).
    const hit = sel.resolveSelection('README.md\nsome other words', root);
    assert.equal(hit.path, path.join(root, 'README.md'));
    // The joined rows may still name a folder.
    const joined = sel.resolveSelection(`${root}${path.sep}src${path.sep}\n   handlers`, root);
    assert.equal(joined.path, path.join(root, 'src', 'handlers'));
    assert.equal(joined.isDir, true);
    // partialDirs (the callers' last resort) accepts the folder a row names.
    const last = sel.resolveSelection(`${root}${path.sep}src\nsome prose`, root, { partialDirs: true });
    assert.equal(last.path, path.join(root, 'src'));
    assert.equal(last.isDir, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveSelection: file:// URL to a real file', () => {
  const root = makeTree();
  try {
    const url = 'file:///' + path.join(root, 'README.md').replace(/\\/g, '/').replace(/^\//, '').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:');
    const hit = sel.resolveSelection(url, null);
    assert.ok(hit, url);
    assert.equal(path.resolve(hit.path), path.join(root, 'README.md'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveSelection: Git Bash path on Windows', { skip: process.platform !== 'win32' }, () => {
  const root = makeTree();
  try {
    const bash = '/' + root[0].toLowerCase() + root.slice(2).replace(/\\/g, '/') + '/README.md';
    const hit = sel.resolveSelection(bash, null);
    assert.ok(hit, bash);
    assert.equal(path.resolve(hit.path).toLowerCase(), path.join(root, 'README.md').toLowerCase());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findUnderCwd: basename walk, full-suffix match preferred, dirs on request', () => {
  const root = makeTree();
  try {
    let hit = sel.findUnderCwd(root, 'slack-manifests/x.yaml', { dirs: false });
    assert.equal(hit.path, path.join(root, 'deep', 'a', 'b', 'slack-manifests', 'x.yaml'));
    assert.equal(hit.isDir, false);
    assert.equal(sel.findUnderCwd(root, 'slack-manifests', { dirs: false }), null);
    hit = sel.findUnderCwd(root, 'slack-manifests/', { dirs: true });
    assert.equal(hit.isDir, true);
    assert.equal(sel.findUnderCwd(null, 'x.yaml', { dirs: true }), null);
    assert.equal(sel.findUnderCwd(root, '..', { dirs: true }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── openFolderCommand ─────────────────────────────────────────────────────

test('Windows: verbatim quoted path, trailing separator dropped (no Documents fallback)', () => {
  const c = sel.openFolderCommand("C:\\obsidian\\Won's 2nd Brain\\4. Projects\\foo\\", W);
  // By full path, so a stray explorer.exe in the current directory never runs.
  assert.equal(sel.openFolderCommand('C:\\x', { platform: 'win32', systemRoot: 'C:\\Windows' }).command, 'C:\\Windows\\explorer.exe');
  assert.ok(path.win32.isAbsolute(c.command) && /\\explorer\.exe$/i.test(c.command), c.command);
  assert.deepEqual(c.args, ["\"C:\\obsidian\\Won's 2nd Brain\\4. Projects\\foo\""]);
  assert.equal(c.options.windowsVerbatimArguments, true);
  assert.equal(c.options.detached, true);
  assert.deepEqual(sel.openFolderCommand('C:/a,b/c//', W).args, ['"C:\\a,b\\c"']);
});

test('Windows: a drive root keeps its backslash', () => {
  assert.deepEqual(sel.openFolderCommand('C:\\', W).args, ['"C:\\"']);
  assert.deepEqual(sel.openFolderCommand('D:/', W).args, ['"D:\\"']);
});

test('Windows: a file is revealed with /select', () => {
  assert.deepEqual(sel.openFolderCommand('C:\\a,b\\f,1.txt', { platform: 'win32', reveal: true }).args, ['/select,"C:\\a,b\\f,1.txt"']);
});

test('Windows: a path with a double quote is refused', () => {
  assert.throws(() => sel.openFolderCommand('C:\\a"b', W));
});

test('macOS reveals with open -R; Linux opens the containing folder', () => {
  assert.deepEqual(sel.openFolderCommand('/Users/me/a b', { platform: 'darwin' }).args, ['/Users/me/a b']);
  assert.deepEqual(sel.openFolderCommand('/Users/me/f.txt', { platform: 'darwin', reveal: true }).args, ['-R', '/Users/me/f.txt']);
  const l = sel.openFolderCommand('/home/me/f.txt', { platform: 'linux', reveal: true });
  assert.equal(l.command, 'xdg-open');
  assert.deepEqual(l.args, ['/home/me']);
});
