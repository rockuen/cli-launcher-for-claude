// Tab labels — claudeCodeLauncher.tabTitle.*: hide the leading date the rename
// prefix adds, and cut long titles with '…', so many open tabs stay readable.
// Pins the date matcher (configured format first, then a bare date), the
// code-point truncation, and the panel glue: every tab-title write goes through
// panel/panelTitle, which keeps the ⚠ / done decoration outside the limit and
// redraws open tabs when the settings change.
// v3.32.0 — tabTitle.compactTabCount / compactLength: once that many launcher
// tabs are open, each is cut to four characters and '…' (date dropped), and a
// tab opening or closing redraws the others.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { stripDatePrefix } = require('../../src/lib/renamePrefix');
const { MIN_LENGTH, DEFAULT_COMPACT_LENGTH, truncateLabel, isCompact, formatTabLabel } = require('../../src/lib/tabLabel');

const ROOT = process.cwd();

// ---- stripDatePrefix ----

test('the default YYMMDD_ prefix is dropped', () => {
  assert.equal(stripDatePrefix('261028_뉴트S&OP 보충', 'YYMMDD_'), '뉴트S&OP 보충');
  assert.equal(stripDatePrefix('261012_쿠시노A441D 단종', 'YYMMDD_'), '쿠시노A441D 단종');
});

test('a custom format is matched with its literals', () => {
  assert.equal(stripDatePrefix('[2026.10.28] 회의', '[YYYY.MM.DD] '), '회의');
  assert.equal(stripDatePrefix('261028-0930 배포', 'YYMMDD-HHmm '), '배포');
  // Regex metacharacters in the format are literal: '.' must not match '-'.
  assert.equal(stripDatePrefix('[2026-10-28] 회의', '[YYYY.MM.DD] '), '[2026-10-28] 회의');
});

test('a bare date is dropped even when the format does not match', () => {
  assert.equal(stripDatePrefix('261028 S&OP 발표', 'YYMMDD_'), 'S&OP 발표');
  assert.equal(stripDatePrefix('20261028_task', 'YYMMDD_'), 'task');
  assert.equal(stripDatePrefix('2026-10-28 task', 'YYMMDD_'), 'task');
  assert.equal(stripDatePrefix('261028.task', ''), 'task');
  assert.equal(stripDatePrefix('261028-task', undefined), 'task');
});

test('titles without a leading date are left alone', () => {
  assert.equal(stripDatePrefix('Claude Code (16)', 'YYMMDD_'), 'Claude Code (16)');
  assert.equal(stripDatePrefix('2026 plan', 'YYMMDD_'), '2026 plan');
  assert.equal(stripDatePrefix('261028뉴트', 'YYMMDD_'), '261028뉴트'); // bare date needs a separator
  assert.equal(stripDatePrefix('task 261028_x', 'YYMMDD_'), 'task 261028_x'); // only at the start
  assert.equal(stripDatePrefix('1234567_x', 'YYMMDD_'), '1234567_x'); // 7 digits is not a date
});

test('a leading number that is not a real date stays (order numbers, item codes)', () => {
  assert.equal(stripDatePrefix('100000 users load test', 'YYMMDD_'), '100000 users load test');
  assert.equal(stripDatePrefix('123456 - login bug', 'YYMMDD_'), '123456 - login bug');
  assert.equal(stripDatePrefix('999999_x', 'YYMMDD_'), '999999_x');
  assert.equal(stripDatePrefix('261328_x', 'YYMMDD_'), '261328_x'); // month 13
  assert.equal(stripDatePrefix('261032_x', 'YYMMDD_'), '261032_x'); // day 32
  // 24:60 is no time, so the format does not match; the bare date still goes.
  assert.equal(stripDatePrefix('261028-2460 x', 'YYMMDD-HHmm '), '2460 x');
});

test('a format that ends in a token does not stop inside a longer number', () => {
  assert.equal(stripDatePrefix('261028_task', 'YYMMDD'), 'task');
  assert.equal(stripDatePrefix('20261028_task', 'YYMMDD'), 'task'); // the bare 8-digit date, not '28_task'
  assert.equal(stripDatePrefix('123456789 x', 'YYMMDD'), '123456789 x');
  assert.equal(stripDatePrefix('2026 plan', 'YY'), '2026 plan');
});

test('separators after the prefix go with it', () => {
  assert.equal(stripDatePrefix('261028_ - task', 'YYMMDD_'), 'task');
  assert.equal(stripDatePrefix('261028__task', 'YYMMDD_'), 'task');
});

test('a title that is only a date is not emptied', () => {
  assert.equal(stripDatePrefix('261028_', 'YYMMDD_'), '261028_');
  assert.equal(stripDatePrefix('261028_   ', 'YYMMDD_'), '261028_   ');
});

test('a format with no date token strips nothing of its own', () => {
  assert.equal(stripDatePrefix('x_task', 'x_'), 'x_task');
  assert.equal(stripDatePrefix(null, 'YYMMDD_'), '');
});

// ---- truncateLabel ----

test('titles over the limit end in … and keep the limit in characters', () => {
  const out = truncateLabel('261028 S&OP 매출 전망 발표 스크립트', 10);
  assert.equal(out, '261028 S&…');
  assert.equal(Array.from(out).length, 10);
  assert.equal(truncateLabel('가나다라마바사아자차카', 5), '가나다라…');
});

test('the cut never ends on a dangling space or half a character', () => {
  assert.equal(truncateLabel('ab   cdefgh', 5), 'ab…');
  assert.equal(truncateLabel('😀😀😀😀😀', 4), '😀😀😀…');
  const family = '👨‍👩‍👧‍👦';
  assert.equal(truncateLabel(family.repeat(5), 4), family.repeat(3) + '…');
  // Decomposed Hangul (macOS file names): 한 is three code points, one character.
  const nfd = '한글abc'.normalize('NFD');
  assert.equal(truncateLabel(nfd, 4).normalize('NFC'), '한글a…');
});

test('limits of 1–3 count as 4, so a tab never becomes a bare …', () => {
  assert.equal(MIN_LENGTH, 4);
  for (const max of [1, 2, 3, 4]) assert.equal(truncateLabel('abcdefgh', max), 'abc…');
  assert.equal(truncateLabel('abcd', 1), 'abcd');
});

test('0, negative, blank or non-numeric limits mean no limit', () => {
  const long = 'x'.repeat(300);
  for (const max of [0, -1, NaN, undefined, null, 'abc']) {
    assert.equal(truncateLabel(long, max as any), long);
  }
  assert.equal(truncateLabel('short', 5), 'short');
  assert.equal(truncateLabel('short', 20), 'short');
});

// ---- formatTabLabel ----

test('both steps off leave the title as it is', () => {
  assert.equal(formatTabLabel('261028_뉴트S&OP 보충', {}), '261028_뉴트S&OP 보충');
  assert.equal(formatTabLabel('261028_뉴트S&OP 보충', undefined), '261028_뉴트S&OP 보충');
});

test('the length is counted after the date is hidden', () => {
  const opts = { hideDatePrefix: true, datePrefixFormat: 'YYMMDD_', maxLength: 8 };
  assert.equal(formatTabLabel('261028_뉴트S&OP 보충', opts), '뉴트S&OP…');
  assert.equal(formatTabLabel('261028_짧은 이름', opts), '짧은 이름');
  assert.equal(formatTabLabel('261028_짧은 이름', { maxLength: 8 }), '261028_…');
});

// ---- compact (crowded tab bar) ----

test('compact starts at the tab count, not before; 0 or blank means never', () => {
  assert.equal(isCompact(8, 8), true);
  assert.equal(isCompact(9, 8), true);
  assert.equal(isCompact(7, 8), false);
  for (const at of [0, -1, NaN, undefined, null, 'abc']) assert.equal(isCompact(50, at as any), false);
  assert.equal(isCompact(undefined as any, 1), false);
});

test('crowded tabs keep four characters and …; shorter names and fewer tabs are untouched', () => {
  assert.equal(DEFAULT_COMPACT_LENGTH, 5);
  const opts = { compactTabCount: 8, compactLength: 5, tabCount: 8 };
  assert.equal(formatTabLabel('뉴트S&OP 보충 발표', opts), '뉴트S&…');
  assert.equal(formatTabLabel('Claude Code (16)', opts), 'Clau…');
  assert.equal(formatTabLabel('짧은이름', opts), '짧은이름');
  assert.equal(formatTabLabel('다섯글자임', opts), '다섯글자임');
  assert.equal(formatTabLabel('뉴트S&OP 보충 발표', { ...opts, tabCount: 7 }), '뉴트S&OP 보충 발표');
  assert.equal(formatTabLabel('뉴트S&OP 보충 발표', { ...opts, tabCount: undefined }), '뉴트S&OP 보충 발표');
});

test('compact drops the date even when hideDatePrefix is off', () => {
  const opts = { datePrefixFormat: 'YYMMDD_', compactTabCount: 3, compactLength: 5, tabCount: 3 };
  assert.equal(formatTabLabel('261116_탭 이름 줄이기', opts), '탭 이름…');
  assert.equal(formatTabLabel('261116_탭 이름 줄이기', { ...opts, tabCount: 2 }), '261116_탭 이름 줄이기');
  // A title that is only a date keeps it, and is cut like any other.
  assert.equal(formatTabLabel('261116_', opts), '2611…');
});

test('compact never makes a tab longer, and a blank compact length is 5', () => {
  const t = 'abcdefghijklmnop';
  const on = { compactTabCount: 2, tabCount: 2 };
  assert.equal(formatTabLabel(t, { ...on, maxLength: 4, compactLength: 10 }), 'abc…');
  assert.equal(formatTabLabel(t, { ...on, maxLength: 12, compactLength: 6 }), 'abcde…');
  assert.equal(formatTabLabel(t, { ...on, maxLength: 12, compactLength: 6, tabCount: 1 }), 'abcdefghijk…');
  for (const len of [0, -3, undefined, null, NaN, 'x']) {
    assert.equal(formatTabLabel(t, { ...on, compactLength: len as any }), 'abcd…');
  }
  assert.equal(formatTabLabel(t, { ...on, compactLength: 2 }), 'abc…'); // 1–3 count as 4
});

// ---- panel glue ----

function loadPanelTitle(settings: Record<string, unknown>) {
  const Module = require('node:module');
  const vscodeStub = {
    workspace: {
      getConfiguration: () => ({ get: (k: string, d: unknown) => (k in settings ? settings[k] : d) }),
    },
  };
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (this: unknown, req: string, ...rest: unknown[]) {
    return req === 'vscode' ? 'vscode' : origResolve.call(this, req, ...rest);
  };
  require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeStub } as any;
  const file = path.join(ROOT, 'src/panel/panelTitle.js');
  delete require.cache[require.resolve(file)];
  try {
    return require(file);
  } finally {
    Module._resolveFilename = origResolve;
  }
}

test('setPanelTitle shortens only the name; ⚠ and done stay outside the limit', () => {
  const settings: Record<string, unknown> = { 'tabTitle.hideDatePrefix': true, 'tabTitle.maxLength': 6 };
  const { setPanelTitle, refreshPanelTitles, tabLabel } = loadPanelTitle(settings);
  const entry: any = { title: '261028_S&OP 매출 전망', panel: { title: '' } };

  setPanelTitle(entry);
  assert.equal(entry.panel.title, 'S&OP…');
  assert.equal(entry.title, '261028_S&OP 매출 전망', 'the session keeps its full name');

  setPanelTitle(entry, { prefix: '⚠ ' });
  assert.equal(entry.panel.title, '⚠ S&OP…');
  setPanelTitle(entry, { suffix: ' (done)' });
  assert.equal(entry.panel.title, 'S&OP… (done)');

  // A settings change redraws the tab as it is now (still done), not as a bare name.
  settings['tabTitle.maxLength'] = 0;
  refreshPanelTitles(new Map([[1, entry]]));
  assert.equal(entry.panel.title, 'S&OP 매출 전망 (done)');
  settings['tabTitle.hideDatePrefix'] = false;
  refreshPanelTitles(new Map([[1, entry]]));
  assert.equal(entry.panel.title, '261028_S&OP 매출 전망 (done)');

  // A closed tab is skipped, a throwing panel setter does not escape.
  const closed: any = { title: 'x', panel: { title: 'old' }, _disposed: true };
  refreshPanelTitles(new Map([[2, closed]]));
  assert.equal(closed.panel.title, 'old');
  const broken: any = { title: 'x', panel: { set title(_v: string) { throw new Error('disposed'); } } };
  assert.doesNotThrow(() => setPanelTitle(broken));

  assert.equal(tabLabel('260101_새 탭'), '260101_새 탭');
});

test('open tabs go compact together at the count, and back below it', () => {
  const settings: Record<string, unknown> = {
    'tabTitle.hideDatePrefix': true,
    'tabTitle.maxLength': 20,
    'tabTitle.compactTabCount': 3,
    'tabTitle.compactLength': 5,
  };
  const { setPanelTitle, refreshPanelTitles, openTabCount, tabLabel } = loadPanelTitle(settings);
  // panelTitle counts the tabs in the shared state, so the test fills it (and
  // puts back whatever was there).
  const state = require(path.join(ROOT, 'src/state.js'));
  const saved = new Map(state.panels);
  state.panels.clear();
  const mk = (title: string, viewColumn: number): any => ({ title, panel: { title: '', viewColumn } });
  try {
    const a = mk('261116_S&OP 매출 전망 발표', 1);
    const b = mk('261116_런처 탭 줄이기', 1);
    state.panels.set(1, a).set(2, b);
    refreshPanelTitles(state.panels);
    assert.equal(openTabCount(), 2);
    assert.equal(a.panel.title, 'S&OP 매출 전망 발표');
    assert.equal(b.panel.title, '런처 탭 줄이기');

    // The third tab makes all three compact — it sits in another editor group,
    // and tabs are counted across groups.
    const c = mk('261116_세 번째 탭 이름', 2);
    state.panels.set(3, c);
    refreshPanelTitles(state.panels);
    assert.equal(openTabCount(), 3);
    assert.equal(a.panel.title, 'S&OP…');
    assert.equal(b.panel.title, '런처 탭…');
    assert.equal(c.panel.title, '세 번째…');
    assert.equal(a.title, '261116_S&OP 매출 전망 발표', 'the session keeps its full name');

    // The marks stay outside the compact limit, and a rename is cut right away.
    setPanelTitle(a, { suffix: ' (done)' });
    assert.equal(a.panel.title, 'S&OP… (done)');
    setPanelTitle(b, { prefix: '⚠ ' });
    assert.equal(b.panel.title, '⚠ 런처 탭…');
    c.title = '새로 바꾼 이름';
    setPanelTitle(c);
    assert.equal(c.panel.title, '새로 바…');

    // Moving a tab between editor groups changes nothing: the count is the window's.
    c.panel.viewColumn = 1;
    refreshPanelTitles(state.panels);
    assert.equal(a.panel.title, 'S&OP… (done)');
    assert.equal(c.panel.title, '새로 바…');

    // One closes: the two left show their full titles again, marks kept. A
    // closing tab is still in the map while it is being disposed, and is not
    // counted or rewritten.
    b._disposed = true;
    refreshPanelTitles(state.panels);
    assert.equal(openTabCount(), 2);
    assert.equal(a.panel.title, 'S&OP 매출 전망 발표 (done)');
    assert.equal(c.panel.title, '새로 바꾼 이름');
    assert.equal(b.panel.title, '⚠ 런처 탭…', 'a closed tab is not rewritten');

    // A refresh counts the tabs once and hands the count to each title; a
    // count passed in is used as it is.
    setPanelTitle(a, a._titleDecor, 3);
    assert.equal(a.panel.title, 'S&OP… (done)');
    setPanelTitle(a, a._titleDecor);
    assert.equal(a.panel.title, 'S&OP 매출 전망 발표 (done)');

    // Turning the setting off redraws the open tabs.
    state.panels.delete(2);
    state.panels.set(4, mk('261116_네 번째 탭 이름', 1));
    refreshPanelTitles(state.panels);
    assert.equal(a.panel.title, 'S&OP… (done)');
    settings['tabTitle.compactTabCount'] = 0;
    refreshPanelTitles(state.panels);
    assert.equal(a.panel.title, 'S&OP 매출 전망 발표 (done)');

    // The label of a tab being created is not counted (createPanel redraws it
    // once the tab is in state.panels).
    settings['tabTitle.compactTabCount'] = 1;
    assert.equal(tabLabel('261116_새로 만드는 탭'), '새로 만드는 탭');
    assert.equal(tabLabel('261116_새로 만드는 탭', 1), '새로 만…');
  } finally {
    state.panels.clear();
    for (const [k, v] of saved) state.panels.set(k, v);
  }
});

test('a tab opening or closing redraws every tab title', () => {
  const create = fs.readFileSync(path.join(ROOT, 'src/panel/createPanel.js'), 'utf8');
  assert.match(create, /state\.panels\.set\(tabId, entry\);[\s\S]{0,300}?refreshPanelTitles\(state\.panels\);/);
  assert.match(create, /state\.panels\.delete\(tabId\);[\s\S]{0,300}?if \(!state\.isDeactivating\) refreshPanelTitles\(state\.panels\);/);
  // Counted across editor groups, never by panel.viewColumn: the editor keeps
  // reporting the old column after a tab is moved to an earlier group.
  const panelTitle = fs.readFileSync(path.join(ROOT, 'src/panel/panelTitle.js'), 'utf8');
  assert.doesNotMatch(panelTitle.replace(/^\s*\/\/.*$/gm, ''), /viewColumn/);
});

function srcFiles(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = path.posix.join(dir, d.name);
    if (d.isDirectory()) return srcFiles(rel);
    return /\.(js|ts)$/.test(d.name) ? [rel] : [];
  });
}

test('every tab-title write goes through panelTitle', () => {
  // A direct `panel.title = …` would bypass the label rules and drop the
  // decoration a settings refresh relies on. panelTitle.js is the one writer;
  // the standalone reader tab (activePanel in readerView.js) is not a session tab.
  const offenders = srcFiles('src')
    .filter((rel) => rel !== 'src/panel/panelTitle.js')
    .filter((rel) => /\bpanel\.title\s*=[^=]/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')));
  assert.deepEqual(offenders, []);
  const create = fs.readFileSync(path.join(ROOT, 'src/panel/createPanel.js'), 'utf8');
  assert.match(create, /createWebviewPanel\(\s*'claudeCode',\s*tabLabel\(tabTitle\),/);
});

test('each tab state keeps its mark: stuck ⚠, done / exit suffix; a waiting tab keeps its title', () => {
  const create = fs.readFileSync(path.join(ROOT, 'src/panel/createPanel.js'), 'utf8');
  const restart = fs.readFileSync(path.join(ROOT, 'src/panel/restartPty.js'), 'utf8');
  assert.match(create, /entry\.state = 'stuck';\s*setPanelTitle\(entry, \{ prefix: '⚠ ' \}\);/);
  for (const src of [create, restart]) {
    assert.match(src, /setPanelTitle\(entry, \{ suffix: t\('suffixDone'\) \}\);/);
    assert.match(src, /setPanelTitle\(entry, \{ suffix: t\('suffixError'\)\.replace\('\{0\}', exitCode\) \}\);/);
  }
  // v3.31.2: a tab waiting for you no longer blinks a ⚠ in its title. Every tick
  // changed the tab's width, so the tabs after it moved under the pointer. Its
  // icon blinks instead (attentionBlink.test.ts), so the only prefix left is
  // the stuck tab's.
  for (const src of [create, restart]) {
    assert.doesNotMatch(src, /TitleBlink|blinkOn|blinkInterval|_stopBlink/);
  }
  const prefixWrites = (src: string) => (src.match(/setPanelTitle\(entry, \{ prefix:/g) || []).length;
  assert.equal(prefixWrites(create), 1, 'only the stuck tab prefixes its title');
  assert.equal(prefixWrites(restart), 0);
});

test('settings: declared, surfaced in the settings panel, allowlisted, and redraw on change', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const props = pkg.contributes.configuration.properties || {};
  assert.equal(props['claudeCodeLauncher.tabTitle.hideDatePrefix'].default, false);
  assert.equal(props['claudeCodeLauncher.tabTitle.maxLength'].default, 0);
  assert.equal(props['claudeCodeLauncher.tabTitle.compactTabCount'].default, 0, 'compact is off by default');
  assert.equal(props['claudeCodeLauncher.tabTitle.compactLength'].default, 5);
  assert.equal(props['claudeCodeLauncher.tabTitle.compactLength'].minimum, 4);

  const settingsPanel = fs.readFileSync(path.join(ROOT, 'src/panel/settingsPanel.js'), 'utf8');
  assert.match(settingsPanel, /wireToggle\('set-tab-title-hide-date', 'tabTitle\.hideDatePrefix'/);
  assert.match(settingsPanel, /wireNumber\('set-tab-title-max-length', 'tabTitle\.maxLength', GLOBALS\.tabTitleMaxLength, 0, 200, 0\)/);
  assert.match(settingsPanel, /wireNumber\('set-tab-title-compact-tab-count', 'tabTitle\.compactTabCount', GLOBALS\.tabTitleCompactTabCount, 0, 100, 0\)/);
  assert.match(settingsPanel, /wireNumber\('set-tab-title-compact-length', 'tabTitle\.compactLength', GLOBALS\.tabTitleCompactLength, 4, 200, 5\)/);
  for (const id of ['set-tab-title-max-length', 'set-tab-title-compact-tab-count', 'set-tab-title-compact-length']) {
    assert.ok(settingsPanel.includes(`id="${id}"`), `${id} is on the settings page`);
  }
  assert.match(settingsPanel, /cfg\.get\('tabTitle\.hideDatePrefix', false\)/);
  assert.match(settingsPanel, /cfg\.get\('tabTitle\.maxLength', 0\)/);
  assert.match(settingsPanel, /cfg\.get\('tabTitle\.compactTabCount', 0\)/);
  assert.match(settingsPanel, /cfg\.get\('tabTitle\.compactLength', 5\)/);
  for (const key of ['hideDatePrefix', 'maxLength', 'compactTabCount', 'compactLength']) {
    assert.ok(settingsPanel.includes(`    'tabTitle.${key}',`), `tabTitle.${key} may be written from the settings page`);
  }
  const panelTitle = fs.readFileSync(path.join(ROOT, 'src/panel/panelTitle.js'), 'utf8');
  assert.match(panelTitle, /cfg\.get\('tabTitle\.compactTabCount', 0\)/);
  assert.match(panelTitle, /cfg\.get\('tabTitle\.compactLength', 5\)/);

  const activation = fs.readFileSync(path.join(ROOT, 'src/activation.js'), 'utf8');
  assert.match(activation, /affectsConfiguration\('claudeCodeLauncher\.tabTitle'\)[\s\S]{0,200}refreshPanelTitles\(state\.panels\)/);
});

test('the settings page number boxes: blank is the default, out-of-range values are pulled in', () => {
  // wireNumber is cut out of the settings page script and run against a stub
  // input, with the 500 ms save timer fired by hand.
  const settingsPanel = fs.readFileSync(path.join(ROOT, 'src/panel/settingsPanel.js'), 'utf8');
  const m = /function wireNumber\(id, key, initial, min, max, blank\) \{[\s\S]*?\r?\n    \}\r?\n/.exec(settingsPanel);
  assert.ok(m, 'wireNumber is in the settings page script');
  const saved: Array<[string, number]> = [];
  let pending: (() => void) | null = null;
  const el: any = { value: '', addEventListener(_t: string, fn: () => void) { el.oninput = fn; } };
  const doc = { getElementById: (id: string) => (id === 'missing' ? null : el) };
  const wireNumber = new Function('document', 'setGlobal', 'setTimeout', 'clearTimeout', m![0] + '\nreturn wireNumber;')(
    doc,
    (key: string, value: number) => saved.push([key, value]),
    (fn: () => void) => { pending = fn; return 1; },
    () => { pending = null; },
  );
  const type = (text: string) => {
    el.value = text;
    el.oninput();
    assert.ok(pending, 'a save is scheduled');
    (pending as () => void)();
    return saved[saved.length - 1];
  };

  wireNumber('missing', 'x', 1, 0, 9, 0); // no such box: nothing happens
  wireNumber('set-tab-title-compact-length', 'tabTitle.compactLength', 5, 4, 200, 5);
  assert.equal(el.value, '5');
  assert.deepEqual(type('8'), ['tabTitle.compactLength', 8]);
  assert.deepEqual(type(''), ['tabTitle.compactLength', 5]);
  assert.deepEqual(type('abc'), ['tabTitle.compactLength', 5]);
  assert.deepEqual(type('2'), ['tabTitle.compactLength', 4]);
  assert.deepEqual(type('999'), ['tabTitle.compactLength', 200]);
  assert.deepEqual(type('6.6'), ['tabTitle.compactLength', 7]);

  wireNumber('set-tab-title-compact-tab-count', 'tabTitle.compactTabCount', undefined, 0, 100, 0);
  assert.equal(el.value, '0', 'an unset value shows the default');
  // A value from a hand-edited settings.json is shown as it is, not pulled in.
  wireNumber('set-tab-title-max-length', 'tabTitle.maxLength', 500, 0, 200, 0);
  assert.equal(el.value, '500');
  wireNumber('set-tab-title-compact-tab-count', 'tabTitle.compactTabCount', undefined, 0, 100, 0);
  assert.deepEqual(type('8'), ['tabTitle.compactTabCount', 8]);
  assert.deepEqual(type(''), ['tabTitle.compactTabCount', 0]);
  assert.deepEqual(type('-4'), ['tabTitle.compactTabCount', 0]);
  assert.deepEqual(type('500'), ['tabTitle.compactTabCount', 100]);
});
