// Editor launcher discovery + the guard on what may be handed to a spawn.
// The folder comes from a URI anything on the machine can fire, so only an
// existing directory is ever passed on.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const { pickCliName, cliDirCandidates, isExistingDirectory } = require(
  path.join(process.cwd(), 'src/lib/editorCli')
) as {
  pickCliName: (names: string[]) => string | null;
  cliDirCandidates: (appRoot: string) => string[];
  isExistingDirectory: (folder: any) => boolean;
};

test('pickCliName: picks the launcher script out of a real bin listing', () => {
  assert.equal(pickCliName(['codium', 'codium-tunnel']), 'codium');
  assert.equal(pickCliName(['code', 'code-tunnel']), 'code');
  assert.equal(pickCliName(['cursor', 'cursor-tunnel']), 'cursor');
});

test('pickCliName: the tunnel binary is never the launcher', () => {
  assert.equal(pickCliName(['codium-tunnel']), null);
  assert.equal(pickCliName(['code-tunnel', 'code-tunnel.exe']), null);
});

test('pickCliName: empty or unusable listings return null', () => {
  assert.equal(pickCliName([]), null);
  assert.equal(pickCliName(undefined as any), null);
  assert.equal(pickCliName(['readme.md', 'notes.txt']), null);
});

test('cliDirCandidates: covers the macOS in-bundle bin and the Linux sibling bin', () => {
  const macRoot = '/Applications/VSCodium.app/Contents/Resources/app';
  const cands = cliDirCandidates(macRoot).map((p) => path.normalize(p));
  assert.ok(cands.includes(path.normalize(path.join(macRoot, 'bin'))));

  const linuxRoot = '/usr/share/codium/resources/app';
  const linuxCands = cliDirCandidates(linuxRoot).map((p) => path.normalize(p));
  assert.ok(linuxCands.includes(path.normalize('/usr/share/codium/bin')));
});

test('cliDirCandidates: no appRoot yields no candidates', () => {
  assert.deepEqual(cliDirCandidates(''), []);
});

test('isExistingDirectory: accepts a real directory, refuses a file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-launcher-test-'));
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'x');
  try {
    assert.equal(isExistingDirectory(dir), true);
    assert.equal(isExistingDirectory(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isExistingDirectory: a shell-quoting payload from a link is not a directory', () => {
  // What a command-injection attempt through the cwd parameter looks like.
  assert.equal(isExistingDirectory('C:\\dev" & calc & "'), false);
  assert.equal(isExistingDirectory('/tmp"; touch /tmp/pwned; "'), false);
  assert.equal(isExistingDirectory('C:\\definitely\\not\\here\\42'), false);
});

test('isExistingDirectory: empty and non-string input is refused', () => {
  assert.equal(isExistingDirectory(''), false);
  assert.equal(isExistingDirectory(null), false);
  assert.equal(isExistingDirectory(42), false);
});
