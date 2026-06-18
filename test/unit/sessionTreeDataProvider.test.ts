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
  // _buildGroups ends with `return groups;` and the next method down the file
  // is _loadSessions. The lazy multi-line match tolerates v3.6.9's comment
  // block between the two; the structural invariant is just adjacency in
  // source order, not literal whitespace.
  assert.match(treeSrc, /return groups;[\s\S]*?_loadSessions\(/);
  assert.equal(/contextValue\s*=\s*['"]sessionsRoot['"]/.test(treeSrc), false);
  assert.equal(/ThemeIcon\(['"]list-tree['"]\)/.test(treeSrc), false);
});

test('v3.6.9: _loadSessions accepts protectedIds + archivedIds sets', () => {
  // Group members must bypass the top-30 hot path and load up to a 100 cap;
  // archived members must skip title/firstMsg parsing entirely. Both behaviours
  // are driven by the two id sets passed in from _buildGroups.
  assert.match(treeSrc, /_loadSessions\s*\(\s*protectedIds\s*=\s*new Set\(\)\s*,\s*archivedIds\s*=\s*new Set\(\)\s*\)/);
  assert.match(treeSrc, /const PROTECTED_CAP\s*=\s*100/);
  assert.match(treeSrc, /protectedExtras\.length\s*>=\s*PROTECTED_CAP/);
});

test('v3.6.9: archived sessions skip title/firstMsg extraction', () => {
  // The archived loop must NOT call _getFileMeta — only stat-derived label,
  // and items must carry _archived = true so downstream UI can identify them.
  assert.match(treeSrc, /archivedExtras\b/);
  assert.match(treeSrc, /item\._archived\s*=\s*true/);
  // The archived block uses sessionId substring as label fallback.
  assert.match(treeSrc, /sessionId\.substring\(0,\s*8\)/);
});

test('v3.6.9: archived group flag surfaces in label + icon', () => {
  // makeGroupNode reads archivedGroups (Set built from
  // claudeSessionGroupArchived) and flips the leaf prefix + folder icon.
  assert.match(treeSrc, /claudeSessionGroupArchived/);
  assert.match(treeSrc, /ThemeIcon\('archive'\)/);
  assert.match(treeSrc, /📦/);
});

test('v3.6.9: _buildGroups partitions ids into protected vs archived', () => {
  // The Set partition must consult archivedGroups when iterating customGroups
  // so that a session in both a regular group AND an archive bucket lands on
  // the cheap archived path (archive wins).
  assert.match(treeSrc, /const archivedGroups\s*=\s*new Set\(sessionStoreGet\(['"]claudeSessionGroupArchived['"]/);
  assert.match(treeSrc, /this\._loadSessions\(\s*protectedIds\s*,\s*archivedIds\s*\)/);
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

test('v3.5.9: live session stashes _jsonlPath + _fileSize for lazy metadata', () => {
  // The pre-built metaRow (which called extractMessageCount on every refresh)
  // is gone. Session items now carry just the path + size so getChildren can
  // build the row on first expand.
  assert.match(treeSrc, /item\._jsonlPath\s*=\s*file\.path/);
  assert.match(treeSrc, /item\._fileSize\s*=\s*file\.size/);
});

test('v3.5.9: trash session stashes _jsonlPath + _fileSize for lazy metadata', () => {
  // Trash items also defer to getChildren — but the lazy path skips
  // extractMessageCount entirely for trash, so even on expand the cost is
  // a single stat + relTime format.
  assert.match(treeSrc, /item\._jsonlPath\s*=\s*fullPath/);
  assert.match(treeSrc, /item\._fileSize\s*=\s*st\.size/);
});

test('v3.5.9: getChildren composes metaRow lazily on first expand', () => {
  // The lazy composition lives inside getChildren and memoizes on
  // _composedChildren so re-expand after collapse doesn't re-run extract.
  assert.match(treeSrc, /element\._jsonlPath\s*&&\s*element\.contextValue\s*!==\s*['"]sessionMeta['"]/);
  assert.match(treeSrc, /element\._composedChildren/);
  assert.match(treeSrc, /contextValue\s*=\s*['"]sessionMeta['"]/);
});

test('v3.5.9: trash branch in getChildren skips extractMessageCount', () => {
  // The metaLabel ternary must use `trashed` as the test, with the trashed
  // arm producing a "trashed · " label WITHOUT calling extractMessageCount.
  // We check structurally: extractMessageCount only appears in the non-
  // trashed branch (inside the IIFE).
  assert.match(treeSrc, /trashed[\s\S]{0,200}?\?\s*`trashed · [\s\S]*?:\s*\(function\(\)[\s\S]*?extractMessageCount/);
});

test('v3.5.9: refresh() is debounced via _refreshTimer', () => {
  assert.match(treeSrc, /this\._refreshTimer/);
  assert.match(treeSrc, /this\._REFRESH_DEBOUNCE_MS/);
  // The debounce body must clear and re-fire onDidChange.
  assert.match(treeSrc, /if \(this\._refreshTimer\) return;[\s\S]*?setTimeout\([\s\S]*?this\._onDidChangeTreeData\.fire\(\)/);
});

test('v3.5.9: _getFileMeta caches extractAiTitle + extractFirstUserMessage by {mtime, size}', () => {
  assert.match(treeSrc, /_getFileMeta\s*\(\s*filePath\s*,\s*mtime\s*,\s*size\s*\)/);
  assert.match(treeSrc, /this\._fileMetaCache/);
  assert.match(treeSrc, /this\._FILE_META_CACHE_MAX/);
  // Cache hit path: mtime + size both match
  assert.match(treeSrc, /cached\.mtime === mtime\s*&&\s*cached\.size === size/);
  // Miss path: extract + store
  assert.match(treeSrc, /aiTitle:\s*extractAiTitle\(filePath\),\s*firstMsg:\s*extractFirstUserMessage\(filePath\)/);
});

test('v3.5.9: sub-sessions attach to _subSessions (not _children)', () => {
  // The lazy getChildren composes [metaRow, ...subSessions]; mixing them
  // into _children would conflate metadata with siblings and break the
  // sort logic.
  assert.match(treeSrc, /parentItem\._subSessions\s*=\s*parentItem\._subSessions\s*\|\|\s*\[\]/);
  assert.match(treeSrc, /parentItem\._subSessions\.push\(item\)/);
  // No leftover sub-session attachment using _children
  assert.equal(
    /parentItem\._children\s*=\s*parentItem\._children\s*\|\|\s*\[\];\s*parentItem\._children\.push/.test(treeSrc),
    false,
    'sub-session attach should no longer use _children',
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
  // extractMessageCount is imported from sessionJsonl; the destructure may
  // carry additional names after it (e.g. listKiroSessions added for the
  // Kiro Sessions tree group) before closing the require.
  assert.match(treeSrc, /extractMessageCount[\s\S]*?\}\s*=\s*require\(['"]\.\.\/lib\/sessionJsonl['"]\)/);
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
  // Legitimate `.None` leaf rows: the shared metadata row (live + trash),
  // the kiro session item, the kiro trash item, the antigravity + codex + grok
  // session items, the unified view's other-agent session leaf
  // (_loadOtherAgentItems builds kiro/codex/grok/agy leaves for the merged tree),
  // and the v3.11 search "no match" placeholder row.
  // Caret-bearing rows (groups, sessions with children) must use
  // Collapsed/Expanded instead.
  const noneCount = (treeSrc.match(/TreeItemCollapsibleState\.None/g) || []).length;
  assert.ok(
    noneCount <= 9,
    `expected ≤ 9 None usages (metadata row + kiro session + kiro trash leaf + antigravity session leaf + codex session leaf + grok session leaf + unified other-agent leaf + search no-match row), got ${noneCount}`,
  );
});

test('v3.11: setFilter normalizes and _matchesText is case-insensitive substring', () => {
  // setFilter trims + lowercases into _filterText and bypasses the debounce;
  // _matchesText does a lowercased includes() so search is case-insensitive.
  assert.match(treeSrc, /setFilter\(text\)\s*\{/);
  assert.match(treeSrc, /\(text \|\| ''\)\.trim\(\)\.toLowerCase\(\)/);
  assert.match(treeSrc, /this\._filterText\s*=\s*next/);
  assert.match(treeSrc, /_matchesText\(text\)\s*\{/);
  assert.match(treeSrc, /String\(text \|\| ''\)\.toLowerCase\(\)\.includes\(this\._filterText\)/);
});

test('v3.11: _buildGroups applies the name filter before grouping', () => {
  // The filtered leaf set feeds itemMap / recentItems so empty groups collapse
  // out (makeGroupNode null), groups force-expand, and a no-match placeholder
  // row replaces the misleading empty-view welcome during a search.
  assert.match(treeSrc, /const filterActive\s*=\s*!!this\._filterText/);
  assert.match(treeSrc, /allItems\.filter\(\(it\)\s*=>\s*this\._matchesText\(it\._searchText \|\| it\.label\)\)/);
  assert.match(treeSrc, /\(filterActive \|\| exp\.has\(name\)\)/);
  assert.match(treeSrc, /filterActive && groups\.length === 0\)\s*return \[this\._noMatchRow\(\)\]/);
});

test('v3.11: split-view _buildAgentGroups also honors the filter', () => {
  // Drops non-matching items from itemMap up front so kiro/codex/grok/agy views
  // search too, and shows the same no-match placeholder when empty.
  assert.match(treeSrc, /itemMap\.delete\(sid\)/);
  assert.match(treeSrc, /filterActive && out\.length === 0\)\s*return \[this\._noMatchRow\(\)\]/);
});

test('v3.11: session leaves carry _searchText for full-title matching', () => {
  // Labels truncate to 40 chars; _searchText holds the full title so a match
  // on text past char 40 still works (set on claude, archived + other-agent).
  assert.match(treeSrc, /item\._searchText\s*=\s*displayText/);
  assert.match(treeSrc, /item\._searchText\s*=\s*label/);
});

test('v3.11: search + new-session i18n keys present in both locales', () => {
  for (const src of [enSrc, koSrc]) {
    assert.match(src, /searchSessionsPrompt:/);
    assert.match(src, /searchSessionsPlaceholder:/);
    assert.match(src, /searchNoMatch:/);
    assert.match(src, /newSessionPickPlaceholder:/);
  }
});

test('v3.11: activation registers new-session picker + search commands', () => {
  const actSrc = fs.readFileSync(path.join(repoRoot, 'src/activation.js'), 'utf8');
  assert.match(actSrc, /registerCommand\('claudeCodeLauncher\.newSessionPick'/);
  assert.match(actSrc, /registerCommand\('claudeCodeLauncher\.searchSessions'/);
  assert.match(actSrc, /registerCommand\('claudeCodeLauncher\.clearSessionFilter'/);
  // New-session button shows the model picker (pickAgent), not a fixed agent.
  assert.match(actSrc, /newSessionPick'[\s\S]{0,200}?pickAgent\(/);
  // Search toggles the context key that reveals the clear-filter button.
  assert.match(actSrc, /'claudeCodeLauncher\.sessionFilterActive'/);
});

test('v3.11: package.json wires commands + unified view-title placement', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const cmds = pkg.contributes.commands.map((c: any) => c.command);
  for (const id of [
    'claudeCodeLauncher.newSessionPick',
    'claudeCodeLauncher.searchSessions',
    'claudeCodeLauncher.clearSessionFilter',
  ]) {
    assert.ok(cmds.includes(id), `missing command ${id}`);
  }
  const unified = pkg.contributes.menus['view/title'].filter(
    (m: any) => typeof m.when === 'string' && /unifiedSessions/.test(m.when),
  );
  const newBtn = unified.find((m: any) => m.command === 'claudeCodeLauncher.newSessionPick');
  const settings = unified.find((m: any) => m.command === 'claudeCodeLauncher.openSettings');
  assert.ok(newBtn, 'new-session button missing from unified view/title');
  assert.ok(settings, 'settings button missing from unified view/title');
  // New-session sits to the LEFT of settings (lower navigation order).
  assert.ok(newBtn.group < settings.group, 'new-session must be left of settings');
  const clear = unified.find((m: any) => m.command === 'claudeCodeLauncher.clearSessionFilter');
  assert.ok(clear && /sessionFilterActive/.test(clear.when), 'clear-filter must be gated by sessionFilterActive');
});

test('v3.10: unified store keys reuse claude physical keys', () => {
  // The unified view shares claude's store so existing groups / Resume Later /
  // Trash carry over with no migration; non-claude sessions join the same keys.
  assert.match(
    treeSrc,
    /unified:\s*\{[\s\S]*?groups:\s*'claudeSessionGroups'[\s\S]*?titles:\s*'claudeSessionTitles'[\s\S]*?\}/,
  );
});

test('v3.10: UNIFIED_OTHER_AGENTS covers kiro/antigravity/codex/grok', () => {
  assert.match(treeSrc, /UNIFIED_OTHER_AGENTS\s*=\s*\[/);
  for (const a of ['kiro', 'antigravity', 'codex', 'grok']) {
    assert.match(treeSrc, new RegExp(`agent:\\s*'${a}'`));
  }
});

test('v3.10: _agentIcon maps agent → model svg with a claude fallback', () => {
  assert.match(treeSrc, /_agentIcon\(agent\)/);
  assert.match(treeSrc, /\$\{agent\}-idle\.svg/);
  assert.match(treeSrc, /claude-idle\.svg/);
});

test('v3.10: _loadOtherAgentItems tags _agent + _unified on each leaf', () => {
  assert.match(treeSrc, /_loadOtherAgentItems\(\)/);
  assert.match(treeSrc, /item\._agent\s*=\s*spec\.agent/);
  assert.match(treeSrc, /item\._unified\s*=\s*true/);
});

test('v3.10: unified _buildGroups folds in other agents + model icons', () => {
  assert.match(treeSrc, /_buildGroups\(opts\s*=\s*\{\}\)/);
  assert.match(treeSrc, /const unified\s*=\s*!!opts\.unified/);
  assert.match(treeSrc, /allItems\.push\(\.\.\.this\._loadOtherAgentItems\(\)\)/);
  assert.match(treeSrc, /it\.iconPath\s*=\s*this\._agentIcon\('claude'\)/);
  // getChildren routes unified mode through _buildGroups with the flag set.
  assert.match(treeSrc, /_buildGroups\(\{\s*unified:\s*this\._agentMode === 'unified'\s*\}\)/);
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
