// v3.31.0 — selecting reader table cells by dragging, like a spreadsheet,
// and copying them so Excel pastes cell by cell (src/lib/tableSelect.js).
//
// installTableSelect runs here against a small stub DOM (tables, rows, cells,
// elementFromPoint, a MutationObserver we fire by hand). The same function
// was checked in headless Chrome with raw CDP mouse input together with
// lib/linkDragSelect and the readers' click guard: a drag inside one cell
// selects its text, a drag across cells selects the block (also when it
// starts on a link, and clamped when the pointer leaves the table),
// Shift+click extends, a click clears, a link still opens on a click,
// execCommand('copy') carries the cells, and the selection survives the
// reader replacing its HTML.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = process.cwd();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { clientSource } = require(path.join(repoRoot, 'src/lib/tableSelect'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getClientScript } = require(path.join(repoRoot, 'src/panel/webviewClient'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getStyles } = require(path.join(repoRoot, 'src/panel/webviewStyles'));
const readerViewSrc = fs.readFileSync(path.join(repoRoot, 'src/panel/readerView.js'), 'utf8');

type Listener = (e: any) => void;
function target() {
  const listeners: Record<string, Listener[]> = {};
  return {
    listeners,
    addEventListener(type: string, fn: Listener) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type: string, e: any) { for (const fn of listeners[type] || []) { fn(e); if (e.__stopImmediate) break; } },
  };
}
function classList(counter: { adds: number }) {
  const set = new Set<string>();
  return { add: (c: string) => { counter.adds++; set.add(c); }, remove: (c: string) => set.delete(c), contains: (c: string) => set.has(c) };
}

const DATA = [['항목', '값', '비고'], ['퍼시스', '1,200,000원', '밴쿠버 4인'], ['report.xlsx', '11930', '구리시'], ['이현성', '0', '지움']];

// A table built from rows of strings; the first row is <th>.
function makeTable(data: string[][], world: any) {
  const table: any = { tagName: 'TABLE', nodeType: 1, classList: classList(world.counter), isConnected: true, rows: [] as any[] };
  data.forEach((rowData, r) => {
    const tr: any = { rowIndex: r, cells: [] as any[] };
    rowData.forEach((text, c) => {
      const cell: any = {
        nodeType: 1, tagName: r === 0 ? 'TH' : 'TD', cellIndex: c, parentElement: tr, innerText: text,
        classList: classList(world.counter), id: `${r},${c}`,
        closest: (s: string) => (s === 'table' ? table : /td|th/.test(s) ? cell : s === 'a' ? null : null),
        get textContent() { return this.innerText; },
      };
      tr.cells.push(cell);
    });
    table.rows.push(tr);
  });
  Object.defineProperty(table, 'textContent', { get: () => table.rows.map((tr: any) => tr.cells.map((c: any) => c.innerText).join('')).join('') });
  table.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100 * data[0].length, bottom: 20 * data.length });
  world.tables.push(table);
  return table;
}

function setup(opts: any = {}) {
  const world: any = { tables: [] as any[], counter: { adds: 0 }, domSel: false };
  const root: any = Object.assign(target(), {
    contains: (n: any) => !!n && (n.inRoot || world.tables.some((t: any) => t === n || t.rows.some((tr: any) => tr.cells.includes(n)))),
    querySelectorAll: () => world.tables.filter((t: any) => t.isConnected),
  });
  const ops: string[] = [];
  const body = { tagName: 'BODY' };
  const doc: any = Object.assign(target(), {
    body,
    documentElement: { tagName: 'HTML' },
    activeElement: body,
    // cell (r, c) of the first connected table occupies x ∈ [100c, 100c+100), y ∈ [20r, 20r+20)
    elementFromPoint: (x: number, y: number) => {
      const t = world.tables.find((tt: any) => tt.isConnected);
      const tr = t && t.rows[Math.floor(y / 20)];
      return (tr && tr.cells[Math.floor(x / 100)]) || { nodeType: 1, closest: () => null, inRoot: true };
    },
    execCommand: (cmd: string) => {
      ops.push('exec:' + cmd);
      if (cmd !== 'copy') return false;
      world.lastCopy = fireCopy(body);
      return true;
    },
  });
  function fireCopy(tgt: any) {
    const data: Record<string, string> = {};
    const e: any = { target: tgt, clipboardData: { setData: (k: string, v: string) => { data[k] = v; } }, preventDefault() { e.prevented = true; } };
    doc.fire('copy', e);
    return e.prevented ? data : null;
  }
  const win = { getSelection: () => ({ isCollapsed: !world.domSel, removeAllRanges: () => { ops.push('clear-dom'); world.domSel = false; } }) };
  const timers: Array<() => void> = [];
  class FakeObserver { constructor(cb: () => void) { world.observe = cb; } observe() { /* root */ } }
  const install = new Function('document', 'window', 'setTimeout', 'MutationObserver', clientSource() + '\nreturn installTableSelect;')(
    doc, win, (fn: () => void) => timers.push(fn), FakeObserver,
  );
  const table = makeTable(DATA, world);
  const api = install(root, opts);
  const ev = (o: any) => {
    const e: any = Object.assign({ button: 0, buttons: 1, detail: 1, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }, o);
    e.preventDefault = () => { e.prevented = true; };
    e.stopPropagation = () => { e.stopped = true; };
    e.stopImmediatePropagation = () => { e.stopped = true; e.__stopImmediate = true; };
    return e;
  };
  const at = (r: number, c: number) => ({ clientX: 100 * c + 50, clientY: 20 * r + 10 });
  const cell = (r: number, c: number) => world.tables.filter((t: any) => t.isConnected)[0].rows[r].cells[c];
  const press = (r: number, c: number, o: any = {}) => root.fire('mousedown', ev(Object.assign({ target: cell(r, c) }, at(r, c), o)));
  const drag = (from: [number, number], to: [number, number], o: any = {}) => {
    press(from[0], from[1], o);
    const mid = ev(at(to[0], to[1]));
    doc.fire('mousemove', mid);
    doc.fire('mouseup', ev({}));
    return mid;
  };
  const rerender = (data: string[][] = DATA) => {
    world.tables.filter((t: any) => t.isConnected).forEach((t: any) => { t.isConnected = false; });
    const t = makeTable(data, world);
    if (world.observe) world.observe();
    return t;
  };
  const highlighted = () => world.tables.filter((t: any) => t.isConnected).flatMap((t: any) =>
    t.rows.flatMap((tr: any) => tr.cells.filter((c: any) => c.classList.contains('rv-cell-sel')).map((c: any) => c.id)));
  return { api, root, doc, world, ops, ev, at, cell, press, drag, rerender, table, highlighted, fireCopy, timers };
}

test('a drag inside one cell stays a text selection', () => {
  const s = setup();
  s.press(1, 0);
  const move = s.ev({ clientX: 80, clientY: 30 }); // still cell (1,0)
  s.doc.fire('mousemove', move);
  assert.equal(move.prevented, undefined);
  assert.equal(s.api.hasSelection(), false);
  assert.deepEqual(s.highlighted(), []);
});

test('a drag into another cell selects the rectangle and drops the text selection', () => {
  const s = setup();
  const move = s.drag([1, 0], [3, 2]);
  assert.equal(move.prevented, true);
  assert.equal(move.__stopImmediate, true, 'the link drag must not keep selecting text');
  assert.ok(s.ops.includes('clear-dom'));
  assert.deepEqual(s.highlighted(), ['1,0', '1,1', '1,2', '2,0', '2,1', '2,2', '3,0', '3,1', '3,2']);
  assert.equal(s.api.getText(), '퍼시스\t1,200,000원\t밴쿠버 4인\nreport.xlsx\t11930\t구리시\n이현성\t0\t지움');
});

test('backwards drags and header cells', () => {
  const s = setup();
  s.drag([2, 1], [0, 0]);
  assert.equal(s.api.getText(), '항목\t값\n퍼시스\t1,200,000원\nreport.xlsx\t11930');
  assert.equal(s.api.getHtml(), '<table><tr><th>항목</th><th>값</th></tr><tr><td>퍼시스</td><td>1,200,000원</td></tr><tr><td>report.xlsx</td><td>11930</td></tr></table>');
});

test('cell text: line breaks and tabs become spaces, HTML is escaped', () => {
  const s = setup();
  s.cell(1, 0).innerText = 'a\n  b\tc';
  s.cell(1, 1).innerText = '<x> & y';
  s.drag([1, 0], [1, 1]);
  assert.equal(s.api.getText(), 'a b c\t<x> & y');
  assert.match(s.api.getHtml(), /<td>a b c<\/td><td>&lt;x&gt; &amp; y<\/td>/);
});

test('the pointer leaving the table clamps to its edge', () => {
  const s = setup();
  s.press(1, 0);
  s.doc.fire('mousemove', s.ev({ clientX: 150, clientY: 500 }));
  assert.equal(s.api.getText(), '퍼시스\t1,200,000원\nreport.xlsx\t11930\n이현성\t0');
});

test('moves inside the same cell do not repaint (large tables)', () => {
  const s = setup();
  s.press(1, 0);
  s.doc.fire('mousemove', s.ev(s.at(3, 2)));
  const adds = s.world.counter.adds;
  s.doc.fire('mousemove', s.ev({ clientX: 260, clientY: 75 })); // still (3,2)
  s.doc.fire('mousemove', s.ev({ clientX: 240, clientY: 65 }));
  assert.equal(s.world.counter.adds, adds);
});

test('a lost mouseup (button released outside) ends the drag and unlocks the table', () => {
  const s = setup();
  s.press(1, 0);
  s.doc.fire('mousemove', s.ev(s.at(2, 1)));
  assert.equal(s.table.classList.contains('rv-cell-selecting'), true);
  s.doc.fire('mousemove', s.ev(Object.assign({ buttons: 0 }, s.at(3, 2))));
  assert.equal(s.table.classList.contains('rv-cell-selecting'), false);
  assert.equal(s.api.getText(), '퍼시스\t1,200,000원\nreport.xlsx\t11930', 'the block made so far stays');
});

test('Shift+click extends; a left press clears; a right press keeps it; Esc clears', () => {
  const s = setup();
  s.drag([1, 0], [1, 1]);
  const shift = s.ev(Object.assign({ target: s.cell(3, 2), shiftKey: true }, s.at(3, 2)));
  s.root.fire('mousedown', shift);
  assert.equal(shift.prevented, true);
  assert.equal(s.api.getText(), '퍼시스\t1,200,000원\t밴쿠버 4인\nreport.xlsx\t11930\t구리시\n이현성\t0\t지움');
  s.root.fire('mousedown', s.ev({ target: s.cell(1, 0), button: 2 }));
  assert.equal(s.api.hasSelection(), true, 'right-click (context menu) keeps the cells');
  s.root.fire('mousedown', s.ev({ target: { nodeType: 1, closest: () => null, inRoot: true } }));
  assert.equal(s.api.hasSelection(), false);
  assert.deepEqual(s.highlighted(), []);
  s.drag([1, 0], [2, 0]);
  s.doc.fire('keydown', s.ev({ key: 'Escape' }));
  assert.equal(s.api.hasSelection(), false);
});

test('Shift+click on a link cell: its click is swallowed and focus leaves the terminal', () => {
  const s = setup();
  s.drag([1, 0], [1, 1]);
  s.doc.fire('click', s.ev({})); // the drag's own click
  let blurred = 0;
  s.doc.activeElement = { tagName: 'TEXTAREA', blur: () => { blurred++; } }; // xterm's helper textarea
  s.press(2, 0, { shiftKey: true });
  s.doc.fire('mouseup', s.ev({}));
  const click = s.ev({ target: s.cell(2, 0) });
  s.doc.fire('click', click);
  assert.equal(click.prevented, true);
  assert.equal(blurred, 1);
});

test('Shift+click without a cell selection is a normal text extension', () => {
  const s = setup();
  s.world.domSel = true;
  const e = s.ev(Object.assign({ target: s.cell(2, 1), shiftKey: true }, s.at(2, 1)));
  s.root.fire('mousedown', e);
  assert.equal(e.prevented, undefined);
  assert.ok(!s.ops.includes('clear-dom'));
  s.doc.fire('mousemove', s.ev(s.at(3, 2)));
  assert.equal(s.api.hasSelection(), false, 'a Shift press does not start a cell drag');
});

test('a single press on a cell clears selected text first (Chrome would drag it instead)', () => {
  const s = setup();
  s.world.domSel = true;
  s.press(1, 0);
  assert.ok(s.ops.includes('clear-dom'));
  const t = setup();
  t.world.domSel = true;
  t.press(1, 0, { detail: 2 });
  assert.ok(!t.ops.includes('clear-dom'), 'a double click keeps its word selection');
});

test('the click that ends a cell drag is swallowed (no link opens), a plain click is not', () => {
  const s = setup();
  s.drag([1, 0], [2, 1]);
  const click = s.ev({});
  s.doc.fire('click', click);
  assert.equal(click.prevented, true);
  assert.equal(click.__stopImmediate, true);
  const next = s.ev({});
  s.doc.fire('click', next);
  assert.equal(next.prevented, undefined);
  s.press(1, 0);
  s.doc.fire('mouseup', s.ev({}));
  const plain = s.ev({});
  s.doc.fire('click', plain);
  assert.equal(plain.prevented, undefined);
});

test('a press outside the reader clears the cells, except where keep() says', () => {
  const menu = { tagName: 'DIV', id: 'menu' };
  const s = setup({ keep: (t: any) => t === menu });
  s.drag([1, 0], [1, 1]);
  s.doc.fire('mousedown', s.ev({ target: menu }));
  assert.equal(s.api.hasSelection(), true);
  s.doc.fire('mousedown', s.ev({ target: { tagName: 'TEXTAREA' }, button: 2 }));
  assert.equal(s.api.hasSelection(), true, 'right-click elsewhere keeps them');
  s.doc.fire('mousedown', s.ev({ target: { tagName: 'TEXTAREA' } }));
  assert.equal(s.api.hasSelection(), false);
});

test('a text selection made any other way (Ctrl+A) replaces the cells', () => {
  const s = setup();
  s.drag([1, 0], [1, 1]);
  s.doc.fire('selectionchange', {});
  assert.equal(s.api.hasSelection(), true, 'collapsed selection: cells stay');
  s.doc.fire('keydown', s.ev({ key: 'a', ctrlKey: true }));
  s.world.domSel = true;
  s.doc.fire('selectionchange', {});
  assert.equal(s.api.hasSelection(), false);
});

test('macOS: the word a right-click selects does not replace the cells', () => {
  const s = setup();
  s.drag([1, 0], [1, 1]);
  s.doc.fire('mousedown', s.ev({ target: s.cell(1, 0), button: 2 }));
  s.root.fire('mousedown', s.ev({ target: s.cell(1, 0), button: 2 }));
  s.world.domSel = true; // Chrome on macOS selected the word under the pointer
  s.doc.fire('selectionchange', {});
  assert.equal(s.api.getText(), '퍼시스\t1,200,000원');
  // The next left press is a normal press again.
  s.world.domSel = false;
  s.doc.fire('mousedown', s.ev({ target: s.cell(1, 0) }));
  s.press(1, 0);
  assert.equal(s.api.hasSelection(), false);
});

test('a press on a scrollbar keeps the cells', () => {
  const s = setup();
  s.drag([1, 0], [1, 1]);
  // The reader tab scrolls the page: the press lands on <html>.
  s.doc.fire('mousedown', s.ev({ target: s.doc.documentElement }));
  assert.equal(s.api.hasSelection(), true);
  // The panel's #reader-area scrolls itself: a press past its client width.
  const area = { tagName: 'DIV', inRoot: true, clientWidth: 600, clientHeight: 300, closest: () => null, nodeType: 1 };
  s.root.fire('mousedown', s.ev({ target: area, offsetX: 605, offsetY: 40 }));
  assert.equal(s.api.hasSelection(), true);
  s.root.fire('mousedown', s.ev({ target: area, offsetX: 300, offsetY: 40 }));
  assert.equal(s.api.hasSelection(), false, 'a press in the content still clears');
});

test('copy event carries tab-separated text and an HTML table; copy() reports it', () => {
  const s = setup();
  assert.equal(s.api.copy(), false, 'nothing selected');
  s.drag([1, 0], [2, 1]);
  assert.equal(s.api.copy(), true);
  assert.deepEqual(s.world.lastCopy, {
    'text/plain': '퍼시스\t1,200,000원\nreport.xlsx\t11930',
    'text/html': '<table><tr><td>퍼시스</td><td>1,200,000원</td></tr><tr><td>report.xlsx</td><td>11930</td></tr></table>',
  });
  s.doc.execCommand = () => false;
  assert.equal(s.api.copy(), false);
});

test('a copy from a text field or of a text selection is left alone', () => {
  const s = setup();
  s.drag([1, 0], [2, 1]);
  assert.equal(s.fireCopy({ tagName: 'TEXTAREA' }), null, 'the input bar / reader input / xterm helper');
  assert.equal(s.fireCopy({ tagName: 'DIV', isContentEditable: true }), null);
  s.world.domSel = true;
  assert.equal(s.fireCopy(s.doc.body), null);
  s.world.domSel = false;
  assert.ok(s.fireCopy(s.doc.body), 'a plain copy (Edit > Copy) carries the cells');
});

test('copyKey: Ctrl+C copies the cells, falls back when execCommand fails, leaves inputs alone', () => {
  const fallback: string[] = [];
  const s = setup({ copyKey: true, fallbackCopy: (t: string) => fallback.push(t) });
  s.drag([1, 0], [1, 1]);
  const key = s.ev({ key: 'c', ctrlKey: true, target: { tagName: 'DIV' } });
  s.doc.fire('keydown', key);
  assert.equal(key.prevented, true);
  assert.ok(s.ops.includes('exec:copy'));
  assert.deepEqual(fallback, []);
  s.doc.execCommand = () => false;
  s.doc.fire('keydown', s.ev({ key: 'c', ctrlKey: true, target: { tagName: 'DIV' } }));
  assert.deepEqual(fallback, ['퍼시스\t1,200,000원']);
  const typing = s.ev({ key: 'c', ctrlKey: true, target: { tagName: 'TEXTAREA' } });
  s.doc.fire('keydown', typing);
  assert.equal(typing.prevented, undefined);
  const p = setup(); // the panel: Ctrl+C is the panel's own handler's job
  p.drag([1, 0], [1, 1]);
  const pk = p.ev({ key: 'c', ctrlKey: true, target: { tagName: 'DIV' } });
  p.doc.fire('keydown', pk);
  assert.equal(pk.prevented, undefined);
});

test('the highlight comes back as soon as the reader swaps its HTML', () => {
  const s = setup();
  s.drag([1, 0], [2, 1]);
  const again = s.rerender();
  // No hasSelection()/getText() call first: the observer alone re-paints.
  assert.deepEqual(s.highlighted(), ['1,0', '1,1', '2,0', '2,1']);
  assert.ok(again.rows[1].cells[0].classList.contains('rv-cell-sel'));
  // A table that grew a row while streaming is the same table.
  const grown = s.rerender(DATA.concat([['새 행', '1', '2']]));
  assert.ok(grown.rows[2].cells[1].classList.contains('rv-cell-sel'));
  assert.equal(s.api.getText(), '퍼시스\t1,200,000원\nreport.xlsx\t11930');
  // Shift+click still extends after a re-render.
  s.press(3, 2, { shiftKey: true });
  assert.equal(s.api.getText(), '퍼시스\t1,200,000원\t밴쿠버 4인\nreport.xlsx\t11930\t구리시\n이현성\t0\t지움');
});

test('a re-render during a drag, released without moving again, keeps the highlight', () => {
  const s = setup();
  s.press(1, 0);
  s.doc.fire('mousemove', s.ev(s.at(2, 1)));
  const fresh = s.rerender(); // the observer skips while the button is down
  s.doc.fire('mouseup', s.ev({}));
  assert.ok(fresh.rows[2].cells[1].classList.contains('rv-cell-sel'));
  assert.deepEqual(s.highlighted(), ['1,0', '1,1', '2,0', '2,1']);
});

test('a different table with the same header is never picked; identical tables keep their position', () => {
  const s = setup();
  s.drag([1, 0], [1, 1]);
  s.rerender([DATA[0], ['다른', '표', '내용']]);
  assert.equal(s.api.hasSelection(), false);
  // Same letters, different cells: not the same table.
  const c = setup();
  c.drag([1, 0], [1, 1]);
  c.rerender([['항목', '값', '비고'], ['퍼', '시스1,200,000원', '밴쿠버 4인'], DATA[2], DATA[3]]);
  assert.equal(c.api.hasSelection(), false);
  // Two identical tables: the selection stays on the second one.
  const t = setup();
  makeTable(DATA, t.world); // a second, identical table
  const second = t.world.tables[1];
  t.root.fire('mousedown', t.ev(Object.assign({ target: second.rows[1].cells[0] }, t.at(1, 0))));
  // elementFromPoint maps to the first table, so drive the move by hand.
  t.world.tables[0].isConnected = false;
  t.doc.fire('mousemove', t.ev(t.at(2, 1)));
  t.world.tables[0].isConnected = true;
  t.doc.fire('mouseup', t.ev({}));
  t.world.tables.forEach((x: any) => { x.isConnected = false; });
  const a = makeTable(DATA, t.world);
  const b = makeTable(DATA, t.world);
  t.world.observe();
  assert.ok(!a.rows[1].cells[0].classList.contains('rv-cell-sel'));
  assert.ok(b.rows[1].cells[0].classList.contains('rv-cell-sel'));
});

// ── Wiring ────────────────────────────────────────────────────────────────

const ctx = {
  T: {}, settings: { fontFamily: 'monospace', defaultTheme: 'auto', readerFontSize: 12 }, fontSize: 14,
  bg: '#000', fg: '#fff', cursor: '#fff', border: '#333', outerBg: '#000', statusGray: '#888', isDark: true,
  memo: '', customButtons: [], customSlashCommands: [], splitRatio: 0.85, splitLayoutOn: true, extraSlashes: [], agent: 'claude',
};

test('panel: installed before the link drag; Ctrl+C, menu Copy and menu actions use the cells', () => {
  const script = getClientScript(ctx);
  assert.ok(script.includes('function installTableSelect(root, opts)'));
  const t = script.indexOf('readerTableSelect = installTableSelect(reader, { keep: (t) => !!(ctxMenu && ctxMenu.contains(t)) });');
  const l = script.indexOf('installLinkDragSelect(reader);');
  assert.ok(t > 0 && l > t, 'table select must be installed first, keeping the cells for menu clicks');
  assert.match(script, /if \(!inTerm && readerTableSelect && readerTableSelect\.hasSelection\(\)\) \{[\s\S]{0,200}copyReaderTable\(\);/);
  assert.match(script, /case 'copy': \{\s*\/\/[^\n]*\n\s*if \(ctxOrigin === 'reader' && readerTableSelect && readerTableSelect\.hasSelection\(\)\) \{\s*copyReaderTable\(\);/);
  assert.match(script, /function readSelection\(\) \{[\s\S]{0,200}if \(ctxOrigin === 'reader' && readerTableSelect && readerTableSelect\.hasSelection\(\)\) \{\s*return readerTableSelect\.getText\(\);/);
  const css = getStyles(ctx);
  assert.match(css, /td\.rv-cell-sel \{ background:/);
  assert.match(css, /\.rv-cell-selecting \* \{ user-select: none;/);
});

test('reader tab: installed before the link drag, with its own Ctrl+C', () => {
  const t = readerViewSrc.indexOf('installTableSelect(blocksEl, {');
  const l = readerViewSrc.indexOf('installLinkDragSelect(blocksEl);');
  assert.ok(t > 0 && l > t);
  assert.match(readerViewSrc.slice(t, l), /copyKey: true,[\s\S]*fallbackCopy:[\s\S]*copy-text/);
  assert.match(readerViewSrc, /td\.rv-cell-sel \{ background:/);
});
