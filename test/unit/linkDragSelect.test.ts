// v3.30.2 — selecting text by dragging from a reader link, and which
// selection the panel's context-menu actions (Open File / Open Folder / Open
// Link / Copy) act on.
//
// installLinkDragSelect runs here against stub DOM objects; the same function
// was checked in Chrome with raw CDP mouse input (press on a link + move →
// the link text is selected, a click or a 3px wobble still opens it, a drag
// from plain text across the link is Chrome's own). The context-menu snapshot
// is cut out of the generated client script and run for real.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = process.cwd();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { clientSource } = require(path.join(repoRoot, 'src/lib/linkDragSelect'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveCopyText } = require(path.join(repoRoot, 'src/lib/copySelection'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getClientScript } = require(path.join(repoRoot, 'src/panel/webviewClient'));
const readerViewSrc = fs.readFileSync(path.join(repoRoot, 'src/panel/readerView.js'), 'utf8');

type Listener = (e: any) => void;
function target() {
  const listeners: Record<string, Listener[]> = {};
  return {
    listeners,
    addEventListener(type: string, fn: Listener) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type: string, e: any) { (listeners[type] || []).forEach((fn) => fn(e)); },
  };
}

function setup() {
  const link = { closest: (s: string) => (s === 'a' ? link : null), id: 'link' };
  const text = { closest: () => null, id: 'text' };
  const outside = { id: 'outside' };
  const root: any = Object.assign(target(), { contains: (n: any) => n === link || n === text || (n && n.inRoot) });
  const doc: any = Object.assign(target(), {
    // caret = a text node in the root at offset = x / 10
    caretPositionFromPoint: (x: number) => ({ offsetNode: x >= 1000 ? outside : { inRoot: true, x }, offset: Math.floor(x / 10) }),
  });
  const ops: any[] = [];
  const win = {
    getSelection: () => ({
      removeAllRanges: () => ops.push(['clear']),
      setBaseAndExtent: (a: any, ao: number, b: any, bo: number) => ops.push(['select', ao, bo]),
    }),
  };
  const install = new Function('document', 'window', clientSource() + '\nreturn installLinkDragSelect;')(doc, win);
  install(root);
  const ev = (o: any) => {
    const e = Object.assign({ button: 0, buttons: 1, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, defaultPrevented: false, stopped: false }, o);
    e.preventDefault = () => { e.defaultPrevented = true; };
    e.stopPropagation = () => { e.stopped = true; };
    e.stopImmediatePropagation = () => { e.stopped = true; };
    return e;
  };
  return { root, doc, ops, ev, link, text };
}

test('a press on a link that moves 4px+ selects from the press point to the pointer', () => {
  const { root, doc, ops, ev, link } = setup();
  const down = ev({ target: link, clientX: 100, clientY: 10 });
  root.fire('mousedown', down);
  assert.equal(down.defaultPrevented, true, 'Chrome must not start its own link/selection drag');
  doc.fire('mousemove', ev({ clientX: 102, clientY: 11 })); // under threshold
  assert.deepEqual(ops, [['clear']]);
  const move = ev({ clientX: 160, clientY: 10 });
  doc.fire('mousemove', move);
  assert.deepEqual(ops, [['clear'], ['select', 10, 16]]);
  assert.equal(move.defaultPrevented, true);
  doc.fire('mousemove', ev({ clientX: 40, clientY: 10 })); // backwards
  assert.deepEqual(ops[2], ['select', 10, 4]);
  doc.fire('mouseup', ev({}));
  doc.fire('mousemove', ev({ clientX: 300, clientY: 10 }));
  assert.equal(ops.length, 3, 'the gesture ends on mouseup');
});

test('a native drag cannot start while the gesture is active', () => {
  const { root, doc, ev, link } = setup();
  root.fire('mousedown', ev({ target: link, clientX: 100, clientY: 10 }));
  const drag = ev({});
  doc.fire('dragstart', drag);
  assert.equal(drag.defaultPrevented, true);
  doc.fire('mouseup', ev({}));
  const later = ev({});
  doc.fire('dragstart', later);
  assert.equal(later.defaultPrevented, false);
});

test('plain text, other buttons and modifier clicks are left to the browser', () => {
  for (const o of [
    { targetKey: 'text' },
    { button: 2 },
    { altKey: true },
    { shiftKey: true },
    { ctrlKey: true },
    { metaKey: true },
  ]) {
    const { root, doc, ops, ev, link, text } = setup();
    const down = ev(Object.assign({ target: (o as any).targetKey === 'text' ? text : link, clientX: 100, clientY: 10 }, o));
    root.fire('mousedown', down);
    assert.equal(down.defaultPrevented, false, JSON.stringify(o));
    doc.fire('mousemove', ev({ clientX: 200, clientY: 10 }));
    assert.deepEqual(ops, [], JSON.stringify(o));
  }
});

test('the gesture stops when the button is released elsewhere, and never selects outside the reader', () => {
  const { root, doc, ops, ev, link } = setup();
  root.fire('mousedown', ev({ target: link, clientX: 100, clientY: 10 }));
  doc.fire('mousemove', ev({ clientX: 1200, clientY: 10 })); // caret outside root
  assert.deepEqual(ops, [['clear']]);
  doc.fire('mousemove', ev({ clientX: 200, clientY: 10, buttons: 0 })); // released outside the webview
  doc.fire('mousemove', ev({ clientX: 220, clientY: 10 }));
  assert.deepEqual(ops, [['clear']]);
});

test('a drag that comes back over the press point is still a drag: its click opens nothing', async () => {
  const { root, doc, ops, ev, link } = setup();
  root.fire('mousedown', ev({ target: link, clientX: 100, clientY: 10 }));
  doc.fire('mousemove', ev({ clientX: 110, clientY: 10 }));
  doc.fire('mousemove', ev({ clientX: 101, clientY: 10 })); // back within 3px
  assert.deepEqual(ops[ops.length - 1], ['select', 10, 10], 'still selecting after coming back');
  doc.fire('mouseup', ev({ clientX: 101, clientY: 10 }));
  const click = ev({ target: link, clientX: 101, clientY: 10, detail: 1 });
  doc.fire('click', click);
  assert.equal(click.defaultPrevented, true);
  assert.equal(click.stopped, true);
  // Only that one click: the next plain click opens.
  const next = ev({ target: link, clientX: 101, clientY: 10, detail: 1 });
  doc.fire('click', next);
  assert.equal(next.defaultPrevented, false);
  // A drag whose click never comes does not eat a later (keyboard) click.
  root.fire('mousedown', ev({ target: link, clientX: 100, clientY: 10 }));
  doc.fire('mousemove', ev({ clientX: 150, clientY: 10 }));
  doc.fire('mouseup', ev({}));
  await new Promise((r) => setTimeout(r, 5));
  const keyboard = ev({ target: link, detail: 0 });
  doc.fire('click', keyboard);
  assert.equal(keyboard.defaultPrevented, false);
});

test('a plain click on a link is not swallowed', () => {
  const { root, doc, ev, link } = setup();
  root.fire('mousedown', ev({ target: link, clientX: 100, clientY: 10 }));
  doc.fire('mousemove', ev({ clientX: 102, clientY: 10 }));
  doc.fire('mouseup', ev({}));
  const click = ev({ target: link, detail: 1 });
  doc.fire('click', click);
  assert.equal(click.defaultPrevented, false);
  assert.equal(click.stopped, false);
});

test('a press on a link releases focus held outside the reader (Ctrl+C then copies the reader text)', () => {
  const { root, doc, ev, link } = setup();
  let blurred = 0;
  const xtermTextarea = { blur: () => { blurred++; } };
  doc.activeElement = xtermTextarea;
  root.fire('mousedown', ev({ target: link, clientX: 100, clientY: 10 }));
  assert.equal(blurred, 1);
  // Focus inside the reader (or on body) is left alone.
  doc.activeElement = { inRoot: true, blur: () => { blurred++; } };
  root.fire('mousedown', ev({ target: link, clientX: 100, clientY: 10 }));
  assert.equal(blurred, 1);
});

test('both readers install it', () => {
  const ctx = {
    T: {}, settings: { fontFamily: 'monospace', defaultTheme: 'auto', readerFontSize: 12 }, fontSize: 14,
    bg: '#000', fg: '#fff', cursor: '#fff', border: '#333', outerBg: '#000', statusGray: '#888', isDark: true,
    memo: '', customButtons: [], customSlashCommands: [], splitRatio: 0.85, splitLayoutOn: true, extraSlashes: [], agent: 'claude',
  };
  const script = getClientScript(ctx);
  assert.ok(script.includes('function installLinkDragSelect(root)'));
  assert.match(script, /getElementById\('reader-area'\);\s*if \(!reader\) return;\s*\/\/[^\n]*\n\s*readerTableSelect = installTableSelect\(reader, \{[^\n]*\}\);\s*installLinkDragSelect\(reader\);/);
  assert.ok(readerViewSrc.includes('${linkDragSelectClientSource()}'));
  assert.ok(readerViewSrc.includes('installLinkDragSelect(blocksEl);'));
});

// ── Context-menu selection snapshot (panel) ───────────────────────────────

function panelScript() {
  return getClientScript({
    T: {}, settings: { fontFamily: 'monospace', defaultTheme: 'auto', readerFontSize: 12 }, fontSize: 14,
    bg: '#000', fg: '#fff', cursor: '#fff', border: '#333', outerBg: '#000', statusGray: '#888', isDark: true,
    memo: '', customButtons: [], customSlashCommands: [], splitRatio: 0.85, splitLayoutOn: true, extraSlashes: [], agent: 'claude',
  });
}

function slice(src: string, start: string, end: string): string {
  const s = src.indexOf(start);
  assert.ok(s >= 0, 'missing: ' + start);
  const e = src.indexOf(end, s);
  assert.ok(e > s, 'missing end after: ' + start);
  return src.slice(s, e + end.length);
}

// Runs the generated contextmenu listener + readSelection against stubs.
// `term.sel` is xterm's live selection; it can change after the menu opens
// (macOS rightClickSelectsWord selects the word under the pointer in xterm's
// own, later, contextmenu handler).
function contextMenu(termSel: string, domSel: string) {
  const script = panelScript();
  const code = slice(script, "let ctxOrigin = 'other';", "let ctxTermSelection = '';")
    + '\n' + slice(script, 'function readSelection() {', '\n    }')
    + '\n' + slice(script, "document.addEventListener('contextmenu'", '}, true);');
  const doc: any = Object.assign(target(), {
    getElementById: (id: string) => (id === 'reader-area' ? { contains: (n: any) => n === 'in-reader' } : null),
  });
  const termContainer = { contains: (n: any) => n === 'in-terminal' };
  const term = { sel: termSel };
  const dom = { sel: domSel };
  const run = new Function(
    'document', 'window', 'getCleanSelection', 'resolveCopyText', 'termContainer', 'showContextMenu', 'readerTableSelect',
    code + '\nreturn readSelection;',
  );
  const readSelection = run(doc, { getSelection: () => ({ toString: () => dom.sel }) }, () => term.sel, resolveCopyText, termContainer, () => {}, null);
  return {
    term,
    dom,
    rightClick(where: string) { doc.fire('contextmenu', { target: where, preventDefault() {}, clientX: 0, clientY: 0 }); },
    read: () => readSelection(),
  };
}

test('right-click in the reader takes the reader selection over a lingering terminal one', () => {
  const m = contextMenu('C:/old/terminal/path', 'C:/reader/path');
  m.rightClick('in-reader');
  m.dom.sel = ''; // the menu click collapses the DOM selection
  assert.equal(m.read(), 'C:/reader/path');
});

test('right-click in the reader with nothing selected there does not take the terminal selection', () => {
  const m = contextMenu('C:/old/terminal/path', '');
  m.rightClick('in-reader');
  assert.equal(m.read(), '');
});

test('right-click in the terminal takes the terminal selection, not a lingering reader one', () => {
  const m = contextMenu('C:/term/path', 'reader text');
  m.rightClick('in-terminal');
  assert.equal(m.read(), 'C:/term/path');
  const empty = contextMenu('', 'reader text');
  empty.rightClick('in-terminal');
  assert.equal(empty.read(), '');
});

test('macOS: the word xterm selects on right-click is what the menu acts on', () => {
  const m = contextMenu('C:/path/A', '');
  m.rightClick('in-terminal');
  m.term.sel = 'C:/path/B'; // xterm's rightClickSelectsWord, after our capture listener
  assert.equal(m.read(), 'C:/path/B');
});

test('output that clears the terminal selection after the right-click: that right-click\'s snapshot', () => {
  const m = contextMenu('C:/term/path', '');
  m.rightClick('in-terminal');
  m.term.sel = '';
  assert.equal(m.read(), 'C:/term/path');
  // …but never a selection older than the right-click.
  const n = contextMenu('', '');
  n.rightClick('in-terminal');
  n.term.sel = '';
  assert.equal(n.read(), '');
});

test('right-click elsewhere: the DOM selection, else the terminal one', () => {
  const m = contextMenu('C:/term/path', 'C:/dom/path');
  m.rightClick('toolbar');
  assert.equal(m.read(), 'C:/dom/path');
  const t2 = contextMenu('C:/term/path', '');
  t2.rightClick('toolbar');
  assert.equal(t2.read(), 'C:/term/path');
});

test('nothing selected → nothing (no older selection comes back)', () => {
  const m = contextMenu('', '');
  m.rightClick('in-terminal');
  assert.equal(m.read(), '');
  const blank = contextMenu('  \n ', '');
  blank.rightClick('in-terminal');
  assert.equal(blank.read(), '');
});

test('menu actions never read the old terminal cache', () => {
  const script = panelScript();
  const fn = slice(script, 'function readSelection() {', '\n    }');
  assert.ok(!fn.includes('lastSelectionCache'));
  const copy = slice(script, "case 'copy': {", "case 'open-file':");
  assert.ok(copy.includes('readSelection()'));
  assert.ok(!copy.includes('lastSelectionCache ||'));
  // A press outside the menu closes it (a link drag swallows the click that would).
  assert.match(script, /addEventListener\('mousedown', \(e\) => \{\s*if \(ctxMenu\.style\.display === 'block' && !ctxMenu\.contains\(e\.target\)\) hideContextMenu\(\);\s*\}, true\);/);
  // Open File / Folder hand the raw selection to the extension (lib/pathSelection reads it).
  assert.ok(script.includes("vscode.postMessage({ type: 'open-file', filePath: sel, line: 0 });"));
  assert.ok(script.includes("vscode.postMessage({ type: 'open-folder', filePath: sel });"));
});

test('the generated standalone reader script parses with the link drag inlined', () => {
  const start = readerViewSrc.indexOf('<script nonce="${nonce}">');
  const end = readerViewSrc.indexOf('</script>', start);
  assert.ok(start > 0 && end > start);
  const templateBody = readerViewSrc.slice(start + '<script nonce="${nonce}">'.length, end);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const tableSelect = require(path.join(repoRoot, 'src/lib/tableSelect'));
  const rendered: string = new Function('nonce', 't', 'linkDragSelectClientSource', 'tableSelectClientSource', 'return `' + templateBody + '`;')(
    'n', (k: string) => k, clientSource, tableSelect.clientSource,
  );
  assert.ok(rendered.includes('function installLinkDragSelect(root)'));
  assert.ok(rendered.includes('function installTableSelect(root, opts)'));
  assert.doesNotThrow(() => new Function(rendered));
});
