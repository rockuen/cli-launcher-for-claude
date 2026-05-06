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
