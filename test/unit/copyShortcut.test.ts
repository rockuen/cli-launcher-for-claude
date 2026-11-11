// v3.31.1 — Ctrl+C in the readers copies in any input mode.
//
// The panel matched Ctrl+C with e.key === 'c'. Korean input mode reports 'ㅊ'
// and Caps Lock 'C', so the launcher skipped the key; VS Code's webview host
// matches copy by keyCode 67, took it, and its copy first re-focuses the last
// focused element when the page body has focus (pre/index.html, execCommand)
// — the terminal or the message box — which drops the reader selection, so
// nothing was copied. The standalone reader tab had no Ctrl+C handler at all
// and failed the same way in every input mode.
//
// Here: lib/shortcutKey, the panel's Ctrl+C handler cut out of the generated
// client script and run against stubs, the reader tab's handler likewise,
// and the wiring of the other letter shortcuts. Also checked in headless
// Chrome with the real panel HTML and xterm inside a copy of VSCodium
// 1.143's webview host keydown/execCommand behaviour: before, 'C' and 'ㅊ'
// copied nothing (focus jumped back to the terminal / message box), and in
// the terminal 'ㅊ' with text selected sent ^C to Claude; after, all copy,
// and ^C still reaches Claude when nothing is selected.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = process.cwd();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { shortcutKeyIs, clientSource } = require(path.join(repoRoot, 'src/lib/shortcutKey'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveCopyText } = require(path.join(repoRoot, 'src/lib/copySelection'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getClientScript } = require(path.join(repoRoot, 'src/panel/webviewClient'));
const readerViewSrc = fs.readFileSync(path.join(repoRoot, 'src/panel/readerView.js'), 'utf8').replace(/\r\n/g, '\n');

const ctx = {
  T: { copied: 'Copied', readerCopyFailed: 'Copy failed' }, settings: { fontFamily: 'monospace', defaultTheme: 'auto', readerFontSize: 12 }, fontSize: 14,
  bg: '#000', fg: '#fff', cursor: '#fff', border: '#333', outerBg: '#000', statusGray: '#888', isDark: true,
  memo: '', customButtons: [], customSlashCommands: [], splitRatio: 0.85, splitLayoutOn: true, extraSlashes: [], agent: 'claude',
};
const script: string = getClientScript(ctx);

function slice(src: string, start: string, end: string, from = 0): string {
  const s = src.indexOf(start, from);
  assert.ok(s >= 0, 'missing: ' + start);
  const e = src.indexOf(end, s);
  assert.ok(e > s, 'missing end after: ' + start);
  return src.slice(s, e + end.length);
}

// ── lib/shortcutKey ───────────────────────────────────────────────────────

test('shortcutKeyIs: e.key in any case, the keyCode, or the physical key while an IME composes', () => {
  assert.equal(shortcutKeyIs({ key: 'c', keyCode: 67 }, 'c'), true);
  assert.equal(shortcutKeyIs({ key: 'C', keyCode: 67 }, 'c'), true, 'Caps Lock');
  assert.equal(shortcutKeyIs({ key: 'ㅊ', keyCode: 67, code: 'KeyC' }, 'c'), true, 'Korean input mode');
  assert.equal(shortcutKeyIs({ key: 'Process', keyCode: 229, code: 'KeyC' }, 'c'), true, 'IME composing');
  assert.equal(shortcutKeyIs({ key: 'j', keyCode: 67, code: 'KeyJ' }, 'c'), true, 'Dvorak: the layout key C');
  assert.equal(shortcutKeyIs({ key: 'v', keyCode: 86 }, 'c'), false);
  assert.equal(shortcutKeyIs({ key: 'Process', keyCode: 229, code: 'KeyV' }, 'c'), false);
  assert.equal(shortcutKeyIs({ key: 'ㅍ', keyCode: 86, code: 'KeyV' }, 'v'), true);
  assert.equal(shortcutKeyIs(null, 'c'), false);
  assert.equal(shortcutKeyIs({ key: 'c' }, ''), false);
});

test('shortcutKeyIs: with Alt (AltGr) held only the typed character counts', () => {
  // Czech / Hungarian: AltGr+F types "[", AltGr+V types "@".
  assert.equal(shortcutKeyIs({ key: '[', keyCode: 70, code: 'KeyF', ctrlKey: true, altKey: true }, 'f'), false);
  assert.equal(shortcutKeyIs({ key: '@', keyCode: 86, code: 'KeyV', ctrlKey: true, altKey: true }, 'v'), false);
  assert.equal(shortcutKeyIs({ key: 'Process', keyCode: 229, code: 'KeyC', altKey: true }, 'c'), false);
  assert.equal(shortcutKeyIs({ key: 'f', keyCode: 70, altKey: true }, 'f'), true);
});

test('the inlined source behaves the same', () => {
  const inlined = new Function(clientSource() + '\nreturn shortcutKeyIs;')();
  assert.equal(inlined({ key: 'ㅊ', keyCode: 67 }, 'c'), true);
  assert.equal(inlined({ key: 'x', keyCode: 88 }, 'c'), false);
});

// ── Panel: the document-level Ctrl+C handler ──────────────────────────────

// The terminal selection cache and the Ctrl+C handler, cut out of the
// generated client script and run against stubs. state.term is xterm's live
// selection; selectTerm() changes it and fires xterm's onSelectionChange.
function panelHarness(state: { term?: string; dom?: string; inTerm?: boolean; cells?: boolean }) {
  const cache = slice(script, "let lastSelectionCache = '';", '});');
  const code = slice(script, "document.addEventListener('keydown', (e) => {\n      // v3.31.1: by keyCode", '}, true);');
  const listeners: any[] = [];
  const doc = { addEventListener: (_t: string, fn: any) => listeners.push(fn) };
  const writes: string[] = [];
  const toasts: string[] = [];
  const termEl = { contains: (n: any) => n === 'xterm-textarea' };
  const table = state.cells ? { hasSelection: () => true, getText: () => 'a\tb' } : null;
  let tableCopies = 0;
  let onSel: () => void = () => {};
  const term = { onSelectionChange: (fn: () => void) => { onSel = fn; } };
  const run = new Function(
    'document', 'window', 'term', 'termContainer', 'readerTableSelect', 'copyReaderTable', 'resolveCopyText', 'getCleanSelection',
    'copyTextToClipboard', 'showToast', 'T', 'shortcutKeyIs',
    cache + '\n' + code,
  );
  run(doc, { getSelection: () => ({ toString: () => state.dom || '' }) }, term, termEl, table, () => { tableCopies++; },
    resolveCopyText, () => state.term || '', (t: string) => { writes.push(t); return Promise.resolve(true); },
    (m: string) => toasts.push(m), ctx.T, shortcutKeyIs);
  const press = (key: string, keyCode = 67, extra: any = {}) => {
    const e: any = Object.assign({ key, keyCode, code: 'KeyC', ctrlKey: true, metaKey: false, altKey: false, target: state.inTerm ? 'xterm-textarea' : { tagName: 'BODY' } }, extra);
    e.preventDefault = () => { e.prevented = true; };
    e.stopPropagation = () => { e.stopped = true; };
    e.stopImmediatePropagation = () => { e.stoppedImmediate = true; };
    listeners.forEach((fn) => fn(e));
    return { e, writes, toasts, tableCopies: () => tableCopies };
  };
  const selectTerm = (text: string) => { state.term = text; onSel(); };
  return { press, selectTerm };
}
const panelCtrlC = (state: any) => panelHarness(state).press;

test('panel: Ctrl+C after a reader drag copies the reader text in Korean mode and with Caps Lock', () => {
  for (const key of ['c', 'C', 'ㅊ']) {
    const r = panelCtrlC({ dom: '배송지 엑셀까지' })(key);
    assert.deepEqual(r.writes, ['배송지 엑셀까지'], key);
    assert.equal(r.e.prevented, true, key);
    assert.equal(r.e.stoppedImmediate, true, `${key}: VS Code's own copy must not run (it re-focuses the message box first)`);
  }
});

test('panel: terminal selection in Korean mode is copied, not sent as ^C; no selection lets ^C through', () => {
  const withSel = panelCtrlC({ term: 'hello terminal', inTerm: true })('ㅊ');
  assert.deepEqual(withSel.writes, ['hello terminal']);
  assert.equal(withSel.e.stoppedImmediate, true);
  const none = panelCtrlC({ inTerm: true })('ㅊ');
  assert.deepEqual(none.writes, []);
  assert.equal(none.e.prevented, undefined, 'xterm gets the key and sends ^C');
});

test('panel: a terminal selection that has disappeared is not copied — ^C stops Claude', () => {
  const h = panelHarness({ inTerm: true });
  h.selectTerm('old output');
  h.selectTerm(''); // a click in the terminal / new output cleared it
  for (const key of ['c', 'ㅊ']) {
    const r = h.press(key);
    assert.deepEqual(r.writes, [], key);
    assert.equal(r.e.prevented, undefined, `${key}: the key reaches xterm, which sends ^C`);
  }
});

test('panel: selected table cells copy in Korean mode too; AltGr+C, Ctrl+Shift+C and other letters are left alone', () => {
  const cells = panelCtrlC({ cells: true })('ㅊ');
  assert.equal(cells.tableCopies(), 1);
  assert.equal(cells.e.stoppedImmediate, true);
  // AltGr (Ctrl+Alt) + C types a letter on some layouts ('ć'): not a copy.
  const alt = panelCtrlC({ dom: 'x' })('ć', 67, { altKey: true });
  assert.deepEqual(alt.writes, []);
  assert.equal(alt.e.prevented, undefined);
  // Ctrl+Shift+C stays VS Code's (it was never the launcher's copy).
  const shift = panelCtrlC({ dom: 'x' })('C', 67, { shiftKey: true });
  assert.deepEqual(shift.writes, []);
  assert.equal(shift.e.prevented, undefined);
  const v = panelCtrlC({ dom: 'x' })('v', 86);
  assert.deepEqual(v.writes, []);
  assert.equal(v.e.prevented, undefined);
});

test('panel: every letter shortcut matches by keyCode, none by a bare e.key; Shift combinations stay out', () => {
  assert.ok(script.includes('function shortcutKeyIs(e, letter)'));
  assert.ok(!/e\.key !== 'c'|event\.key === '[cfv]'|e\.key !== 'R'/.test(script), 'no e.key-only letter checks left');
  assert.match(script, /if \(!\(e\.ctrlKey \|\| e\.metaKey\) \|\| e\.altKey \|\| e\.shiftKey \|\| !shortcutKeyIs\(e, 'c'\)\) return;/);
  assert.match(script, /if \(mod && !event\.shiftKey && shortcutKeyIs\(event, 'c'\)\) \{/);
  assert.match(script, /if \(mod && !event\.shiftKey && shortcutKeyIs\(event, 'f'\)\) \{/);
  assert.match(script, /if \(mod && !event\.shiftKey && shortcutKeyIs\(event, 'v'\)\) \{/);
  assert.match(script, /if \(!shortcutKeyIs\(e, 'r'\)\) return;/);
  assert.match(script, /term\.onSelectionChange\(\(\) => \{\s*lastSelectionCache = getCleanSelection\(\)\.trim\(\);\s*\}\);/);
});

// ── Reader tab ────────────────────────────────────────────────────────────

const READER_HANDLER = "document.addEventListener('keydown', function(e) {\n        if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || !shortcutKeyIs(e, 'c')) return;";

function readerTabCtrlC(dom: string, opts: { exec?: boolean | 'throw'; reject?: boolean } = {}) {
  const start = readerViewSrc.indexOf(READER_HANDLER);
  assert.ok(start > 0, 'the reader tab has its own Ctrl+C handler');
  const code = slice(readerViewSrc, "document.addEventListener('keydown', function(e) {", '}, true);', start);
  const listeners: any[] = [];
  const writes: string[] = [];
  const posted: any[] = [];
  const execs: string[] = [];
  new Function('document', 'window', 'navigator', 'vscode', 'shortcutKeyIs', code)(
    {
      addEventListener: (_t: string, fn: any) => listeners.push(fn),
      execCommand: (c: string) => {
        execs.push(c);
        if (opts.exec === 'throw') throw new Error('nope');
        return opts.exec !== false;
      },
    },
    { getSelection: () => ({ toString: () => dom }) },
    { clipboard: { writeText: (t: string) => { writes.push(t); return opts.reject ? Promise.reject(new Error('denied')) : Promise.resolve(); } } },
    { postMessage: (m: any) => posted.push(m) },
    shortcutKeyIs,
  );
  return {
    press(key: string, extra: any = {}) {
      const e: any = Object.assign({ key, keyCode: 67, ctrlKey: true, altKey: false, shiftKey: false, target: { tagName: 'BODY' } }, extra);
      e.preventDefault = () => { e.prevented = true; };
      e.stopPropagation = () => {};
      e.stopImmediatePropagation = () => { e.stoppedImmediate = true; };
      listeners.forEach((fn) => fn(e));
      return e;
    },
    writes, posted, execs,
  };
}

test('reader tab: Ctrl+C copies the selection with the browser copy (HTML too) in every input mode, ahead of VS Code', () => {
  for (const key of ['c', 'C', 'ㅊ']) {
    const r = readerTabCtrlC('배송지 엑셀까지');
    const e = r.press(key);
    assert.deepEqual(r.execs, ['copy'], key);
    assert.deepEqual(r.writes, [], `${key}: no plain-text write when the browser copy ran`);
    assert.equal(e.stoppedImmediate, true, key);
  }
});

test('reader tab: a refused browser copy falls back to plain text, then to the extension', async () => {
  for (const exec of [false, 'throw'] as const) {
    const r = readerTabCtrlC('text', { exec });
    r.press('ㅊ');
    assert.deepEqual(r.writes, ['text'], String(exec));
  }
  const refused = readerTabCtrlC('text', { exec: false, reject: true });
  refused.press('c');
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(refused.posted, [{ type: 'copy-text', text: 'text' }]);
});

test('reader tab: the message box copies itself; no selection, Shift and AltGr leave the key alone', () => {
  const box = readerTabCtrlC('typed');
  assert.equal(box.press('c', { target: { tagName: 'TEXTAREA' } }).prevented, undefined);
  assert.deepEqual(box.execs, []);
  assert.equal(readerTabCtrlC('   ').press('c').prevented, undefined);
  assert.equal(readerTabCtrlC('x').press('C', { shiftKey: true }).prevented, undefined);
  assert.equal(readerTabCtrlC('x').press('ć', { altKey: true }).prevented, undefined);
});

test('reader tab: table cells are handled first (their Ctrl+C keeps this one out)', () => {
  const cells = readerViewSrc.indexOf('installTableSelect(blocksEl, {');
  const handler = readerViewSrc.indexOf(READER_HANDLER);
  assert.ok(cells > 0 && handler > cells);
});

