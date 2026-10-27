// v3.28.2 — reader links don't drag, and a press that moves is not a click.
//
// A link in the reader used to start a native drag after a few pixels of
// movement (the drag image showed the vscode-webview:// URL). The links now
// carry -webkit-user-drag: none. Chrome still won't start a text selection
// from a link, so without the drag a press that moves and is released on the
// same link fires click; both readers drop such a click once the press moved
// 4px (Chrome's link drag threshold on Windows, measured) so it opens
// nothing, as the drag did. Keyboard / assistive clicks (detail 0) are never
// dropped: their clientX/Y are 0 and the last mousedown is stale. Checked in
// Chrome with raw CDP mouse input against the generated code.
//
// Both guards run here for real against stub elements: the panel's
// setupReaderLinks IIFE is cut out of the generated client script, the
// standalone reader's guard out of readerView.js (renderHtml needs `vscode`).

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = process.cwd();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getClientScript } = require(path.join(repoRoot, 'src/panel/webviewClient'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getStyles } = require(path.join(repoRoot, 'src/panel/webviewStyles'));
const readerViewSrc = fs.readFileSync(path.join(repoRoot, 'src/panel/readerView.js'), 'utf8');

const ctx = {
  T: {},
  settings: { fontFamily: 'monospace', defaultTheme: 'auto', readerFontSize: 12 },
  fontSize: 14,
  bg: '#000', fg: '#fff', cursor: '#fff', border: '#333', outerBg: '#000',
  statusGray: '#888', isDark: true, memo: '', customButtons: [],
  customSlashCommands: [], splitRatio: 0.85, splitLayoutOn: true,
  extraSlashes: [], agent: 'claude',
};

type Listener = (e: any) => void;

function slice(src: string, startMarker: string, endMarker: string, from = 0): string {
  const start = src.indexOf(startMarker, from);
  assert.ok(start >= 0, `marker not found: ${startMarker}`);
  const endAt = src.indexOf(endMarker, start);
  assert.ok(endAt > start, `end marker not found after: ${startMarker}`);
  return src.slice(start, endAt + endMarker.length);
}

function stubElement() {
  const listeners: Record<string, Listener[]> = {};
  return {
    listeners,
    addEventListener(type: string, fn: Listener) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type: string, e: any) { (listeners[type] || []).forEach((fn) => fn(e)); },
  };
}

// The panel: setupReaderLinks posts open-path / open-link to the extension.
function panelReader() {
  const code = slice(getClientScript(ctx), '(function setupReaderLinks()', '})();');
  const reader = stubElement();
  const posted: any[] = [];
  const document = { getElementById: (id: string) => (id === 'reader-area' ? reader : null) };
  const vscode = { postMessage: (m: any) => posted.push(m) };
  new Function('document', 'vscode', code)(document, vscode);
  return { el: reader, opened: () => posted.map((m) => m.type) };
}

// The standalone reader: the guard stops the click so the webview host's
// window-level click handler never opens the link.
function standaloneReader() {
  const start = readerViewSrc.indexOf('let downX = 0, downY = 0;', readerViewSrc.indexOf('if (blocksEl) {'));
  assert.ok(start >= 0, 'guard state must be declared in the blocks section');
  const guardAt = readerViewSrc.indexOf("blocksEl.addEventListener('click', function(e) {", start);
  const end = readerViewSrc.indexOf('}, true);', guardAt);
  assert.ok(guardAt > start && end > guardAt, 'capture-phase click guard must follow the mousedown listener');
  const code = readerViewSrc.slice(start, end + '}, true);'.length);
  assert.ok(code.includes("addEventListener('mousedown'"), 'guard slice must include the mousedown listener');
  const blocksEl = stubElement();
  new Function('blocksEl', code)(blocksEl);
  let hostOpened = 0;
  return { el: blocksEl, onUnstopped: () => { hostOpened++; }, opened: () => hostOpened };
}

function linkClick(el: ReturnType<typeof stubElement>, href: string, at: [number, number], detail: number) {
  const a = { getAttribute: (n: string) => (n === 'href' ? href : null), classList: { contains: (c: string) => c === 'auto-link' } };
  const e = {
    target: { closest: (sel: string) => (sel === 'a' ? a : null) },
    clientX: at[0], clientY: at[1], detail,
    prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  };
  el.fire('click', e);
  return e;
}

function press(env: any, href: string, from: [number, number], to: [number, number]) {
  env.el.fire('mousedown', { clientX: from[0], clientY: from[1] });
  const e = linkClick(env.el, href, to, 1);
  if (env.onUnstopped && !e.stopped) env.onUnstopped();
  return e;
}

function keyboard(env: any, href: string) {
  const e = linkClick(env.el, href, [0, 0], 0);
  if (env.onUnstopped && !e.stopped) env.onUnstopped();
  return e;
}

test('v3.28.2: reader links carry -webkit-user-drag: none in both readers', () => {
  const rule = String(getStyles(ctx)).split(/\r?\n/).find((l) => l.includes('#reader-area .msg-body a {'));
  assert.ok(rule, 'panel reader link rule must exist');
  assert.match(rule!, /-webkit-user-drag:\s*none/);
  assert.match(readerViewSrc, /\.msg-body a \{[^}]*-webkit-user-drag:\s*none/);
});

test('v3.28.2: panel — a click (incl. a 3px wobble) opens; a 4px move opens nothing and still blocks navigation', () => {
  const env = panelReader();
  press(env, 'src/foo.ts:12', [100, 50], [100, 50]);
  press(env, 'https://example.com/x', [100, 50], [103, 47]);
  assert.deepEqual(env.opened(), ['open-path', 'open-link']);
  const moved = press(env, 'src/foo.ts:12', [100, 50], [104, 50]);
  const movedY = press(env, 'https://example.com/x', [100, 50], [100, 70]);
  assert.deepEqual(env.opened(), ['open-path', 'open-link'], 'moved presses must not open');
  assert.equal(moved.prevented && movedY.prevented, true, 'default must stay prevented');
});

test('v3.28.2: panel — a keyboard click opens even after a mouse press elsewhere', () => {
  const env = panelReader();
  env.el.fire('mousedown', { clientX: 300, clientY: 200 });
  keyboard(env, 'src/foo.ts:12');
  keyboard(env, 'https://example.com/x');
  assert.deepEqual(env.opened(), ['open-path', 'open-link']);
});

test('v3.28.2: standalone — a moved press is stopped before the host; clicks and keyboard clicks pass', () => {
  const env = standaloneReader();
  const click = press(env, 'src/foo.ts:12', [100, 50], [103, 50]);
  assert.equal(click.stopped || click.prevented, false, 'a click must reach the host untouched');
  const moved = press(env, 'src/foo.ts:12', [100, 50], [100, 54]);
  assert.equal(moved.stopped && moved.prevented, true);
  env.el.fire('mousedown', { clientX: 300, clientY: 200 });
  keyboard(env, 'https://example.com/x');
  assert.equal(env.opened(), 2, 'the click and the keyboard click reach the host');
});
