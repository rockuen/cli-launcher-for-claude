// Tab labels — claudeCodeLauncher.tabTitle.*: hide the leading date the rename
// prefix adds, and cut long titles with '…', so many open tabs stay readable.
// Pins the date matcher (configured format first, then a bare date), the
// code-point truncation, and the panel glue: every tab-title write goes through
// panel/panelTitle, which keeps the ⚠ / done decoration outside the limit and
// redraws open tabs when the settings change.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { stripDatePrefix } = require('../../src/lib/renamePrefix');
const { MIN_LENGTH, truncateLabel, formatTabLabel } = require('../../src/lib/tabLabel');

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

test('each tab state keeps its mark: stuck ⚠, done / exit suffix, blink undoes only its own ⚠', () => {
  const create = fs.readFileSync(path.join(ROOT, 'src/panel/createPanel.js'), 'utf8');
  const restart = fs.readFileSync(path.join(ROOT, 'src/panel/restartPty.js'), 'utf8');
  assert.match(create, /entry\.state = 'stuck';\s*setPanelTitle\(entry, \{ prefix: '⚠ ' \}\);/);
  for (const src of [create, restart]) {
    assert.match(src, /setPanelTitle\(entry, \{ suffix: t\('suffixDone'\) \}\);/);
    assert.match(src, /setPanelTitle\(entry, \{ suffix: t\('suffixError'\)\.replace\('\{0\}', exitCode\) \}\);/);
  }
  assert.match(create, /setPanelTitle\(entry, \{ prefix: blinkOn \? '\\u26A0 ' : '' \}\);/);
  // A tab that exits or goes stuck mid-blink must not lose that mark on the next tick.
  assert.match(
    create,
    /if \(wasBlinking && entry\.state !== 'done' && entry\.state !== 'error' && entry\.state !== 'stuck'\) \{\s*setPanelTitle\(entry\);/,
  );
});

test('settings: declared, surfaced in the settings panel, allowlisted, and redraw on change', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const props = pkg.contributes.configuration.properties || {};
  assert.equal(props['claudeCodeLauncher.tabTitle.hideDatePrefix'].default, false);
  assert.equal(props['claudeCodeLauncher.tabTitle.maxLength'].default, 0);

  const settingsPanel = fs.readFileSync(path.join(ROOT, 'src/panel/settingsPanel.js'), 'utf8');
  assert.match(settingsPanel, /wireToggle\('set-tab-title-hide-date', 'tabTitle\.hideDatePrefix'/);
  assert.match(settingsPanel, /setGlobal\('tabTitle\.maxLength'/);
  assert.match(settingsPanel, /cfg\.get\('tabTitle\.hideDatePrefix', false\)/);
  assert.match(settingsPanel, /cfg\.get\('tabTitle\.maxLength', 0\)/);
  assert.match(settingsPanel, /'tabTitle\.hideDatePrefix',/);
  assert.match(settingsPanel, /'tabTitle\.maxLength',/);

  const activation = fs.readFileSync(path.join(ROOT, 'src/activation.js'), 'utf8');
  assert.match(activation, /affectsConfiguration\('claudeCodeLauncher\.tabTitle'\)[\s\S]{0,200}refreshPanelTitles\(state\.panels\)/);
});
