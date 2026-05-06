// v3.5.0 — SessionTreeDataProvider source-level invariants.
// SessionTreeDataProvider depends on the `vscode` module which isn't
// available in node:test, so these tests verify the v3.5.0 redesign at
// the source level (string patterns over the file contents). Live tree
// behaviour is exercised through build + manual install verification.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = process.cwd();
const treeSrc = fs.readFileSync(
  path.join(repoRoot, 'src/tree/SessionTreeDataProvider.js'),
  'utf8',
);
const enSrc = fs.readFileSync(path.join(repoRoot, 'src/i18n/en.js'), 'utf8');
const koSrc = fs.readFileSync(path.join(repoRoot, 'src/i18n/ko.js'), 'utf8');
const jsonlSrc = fs.readFileSync(path.join(repoRoot, 'src/lib/sessionJsonl.js'), 'utf8');

test('Tree returns root groups directly without a Sessions wrapper', () => {
  // _buildGroups ends with `return groups;` and there is no rootNode/list-tree dance.
  // CRLF-tolerant: tsc emits \r\n on Windows.
  assert.match(treeSrc, /\s+return groups;\s+\}\s+_loadSessions\(/);
  assert.equal(/contextValue\s*=\s*['"]sessionsRoot['"]/.test(treeSrc), false);
  assert.equal(/ThemeIcon\(['"]list-tree['"]\)/.test(treeSrc), false);
});

test('No leftover sessionsRoot i18n key', () => {
  assert.equal(/sessionsRoot/.test(enSrc), false);
  assert.equal(/sessionsRoot/.test(koSrc), false);
  assert.equal(/t\(['"]sessionsRoot['"]\)/.test(treeSrc), false);
});

test('_expandedGroups defaults to Resume Later only', () => {
  assert.match(
    treeSrc,
    /this\._expandedGroups\s*=\s*new Set\(\[t\('resumeLaterGroup'\)\]\)/,
  );
});

test('Live session TreeItem uses CollapsibleState.Collapsed', () => {
  assert.match(
    treeSrc,
    /new vscode\.TreeItem\(label,\s*vscode\.TreeItemCollapsibleState\.Collapsed\);[\s\S]*?claudeCodeLauncher\.resumeSession/,
  );
});

test('Trash item TreeItem uses CollapsibleState.Collapsed', () => {
  assert.match(
    treeSrc,
    /new vscode\.TreeItem\(label,\s*vscode\.TreeItemCollapsibleState\.Collapsed\);\s*item\.description = dateStr;\s*item\.iconPath = new vscode\.ThemeIcon\('trash'\)/,
  );
});

test('Live session attaches a sessionMeta child row', () => {
  assert.match(
    treeSrc,
    /const metaRow = new vscode\.TreeItem\(metaLabel,[\s\S]*?contextValue = 'sessionMeta'[\s\S]*?item\._children = \[metaRow\]/,
  );
});

test('Trash session attaches a sessionMeta child row', () => {
  assert.match(
    treeSrc,
    /const trashMeta = new vscode\.TreeItem\([\s\S]*?contextValue = 'sessionMeta'[\s\S]*?item\._children = \[trashMeta\]/,
  );
});

test('_cmp keeps sessionMeta rows ahead of sub-sessions', () => {
  assert.match(
    treeSrc,
    /if \(a\.contextValue === 'sessionMeta'\) return -1;\s*if \(b\.contextValue === 'sessionMeta'\) return 1;/,
  );
});

test('extractMessageCount exported from sessionJsonl', () => {
  assert.match(jsonlSrc, /function extractMessageCount\s*\(/);
  assert.match(jsonlSrc, /module\.exports\s*=\s*\{[\s\S]*?extractMessageCount[\s\S]*?\}/);
  assert.match(treeSrc, /extractMessageCount\s*\}\s*=\s*require\(['"]\.\.\/lib\/sessionJsonl['"]\)/);
});

test('_relTime helper exists with the expected branch ladder', () => {
  // We don't assert exact output — just that the time bucket structure is in
  // place so locale switches don't silently lose a branch.
  assert.match(treeSrc, /function _relTime\(mtime\)/);
  assert.match(treeSrc, /isKo\s*=\s*\(vscode\.env\.language \|\| ''\)\.startsWith\('ko'\)/);
  assert.match(treeSrc, /'방금 전'/);
  assert.match(treeSrc, /'어제'/);
});

test('No CollapsibleState.None on session/trash item rows', () => {
  // The only legitimate `.None` left is the empty-group fallback in
  // makeGroupNode and the two metadata leaf rows (live session + trash).
  // Live: 1, Trash: 1, makeGroupNode: 1 → ≤ 3.
  const noneCount = (treeSrc.match(/TreeItemCollapsibleState\.None/g) || []).length;
  assert.ok(
    noneCount <= 3,
    `expected ≤ 3 None usages (group fallback + 2 metadata rows), got ${noneCount}`,
  );
});

test('No U+3000 ideographic space prefix workaround remains', () => {
  assert.equal(
    /　/.test(treeSrc),
    false,
    'U+3000 ideographic space should be removed from tree provider',
  );
});

test('No PREFIX constant declaration remains in tree provider', () => {
  assert.equal(
    /const\s+PREFIX\s*=/.test(treeSrc),
    false,
    'v3.4.13 PREFIX constant declaration should be removed',
  );
});

test('No legacy v3.4.13–v3.4.15 padding/prefix comment block remains', () => {
  assert.equal(/leaf-only sub-groups don't reserve/.test(treeSrc), false);
  assert.equal(/U\+3000 IDEOGRAPHIC/.test(treeSrc), false);
  assert.equal(/padded-SVG approach/.test(treeSrc), false);
});

test('padded-SVG icon files were deleted', () => {
  const a = path.join(repoRoot, 'icons/comment-discussion-padded.svg');
  const b = path.join(repoRoot, 'icons/comment-draft-padded.svg');
  assert.equal(fs.existsSync(a), false, 'comment-discussion-padded.svg should be removed');
  assert.equal(fs.existsSync(b), false, 'comment-draft-padded.svg should be removed');
});
