// v3.21.4 — two reader defects that only bit non-Claude agents.
//
// Both live in files that cannot be imported under node:test (createPanel.js
// needs `vscode`; the client script is a template string evaluated inside the
// webview), so they are pinned at the source / generated-script level — the
// same convention as sessionTreeDataProvider.test.ts and webviewInput.test.ts.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = process.cwd();
const panelSrc = fs.readFileSync(path.join(repoRoot, 'src/panel/createPanel.js'), 'utf8');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getClientScript } = require(path.join(repoRoot, 'src/panel/webviewClient'));

function clientScript(): string {
  return getClientScript({
    T: {},
    settings: { fontFamily: 'monospace', defaultTheme: 'auto', readerFontSize: 12 },
    fontSize: 14,
    bg: '#000', fg: '#fff', cursor: '#fff', border: '#333', outerBg: '#000',
    statusGray: '#888', isDark: true, memo: '', customButtons: [],
    customSlashCommands: [], splitRatio: 0.85, splitLayoutOn: true,
    extraSlashes: [], agent: 'codex',
  });
}

// ─── Reader catch-up on refocus ────────────────────────────────────────────
// A reader render that lands while the panel is hidden only sets pendingRender;
// the flush happens when the panel comes back. That flush used to sit inside
// the `outputBuffer.length > 0` branch, so it ran only when the panel also had
// PTY bytes waiting. Codex writes its rollout just twice per turn, so losing
// focus during a reply meant the one event carrying it was dropped and nothing
// ever fired again — the answer never appeared under the prompt.

test('v3.21.4: reader catch-up runs on refocus independently of buffered PTY output', () => {
  const catchUpIdx = panelSrc.indexOf('entry._readerCatchUp();');
  assert.ok(catchUpIdx > 0, '_readerCatchUp must still be invoked on view-state change');

  // The nearest enclosing `if` above the call must gate on active-only, not on
  // the buffered-output condition.
  const guardIdx = panelSrc.lastIndexOf('if (', catchUpIdx);
  const guard = panelSrc.slice(guardIdx, catchUpIdx);
  assert.match(guard, /e\.webviewPanel\.active/);
  assert.ok(
    !/outputBuffer\.length/.test(guard),
    'catch-up must not be gated on outputBuffer.length — that is the v3.21.4 bug',
  );

  // And the drain branch must still exist, separately.
  assert.match(panelSrc, /if \(e\.webviewPanel\.active && webviewReady && outputBuffer\.length > 0\) \{/);
});

test('v3.21.4: the drain branch no longer contains the catch-up call', () => {
  const drainIdx = panelSrc.indexOf('if (e.webviewPanel.active && webviewReady && outputBuffer.length > 0) {');
  assert.ok(drainIdx > 0);
  const catchUpIdx = panelSrc.indexOf('entry._readerCatchUp();', drainIdx);
  const drainBody = panelSrc.slice(drainIdx, catchUpIdx);
  // Everything between the drain branch and the catch-up call must include the
  // branch's own closing brace, i.e. the call sits outside it.
  assert.match(drainBody, /sendPtyChunkPaced\(panel, chunk, entry\);[\s\S]*?\}[\s\S]*?\}/);
});

// ─── Ctrl+Wheel zoom targeting ─────────────────────────────────────────────
// #reader-area is a DESCENDANT of #terminal-wrapper, and both wheel listeners
// are registered with capture:true. Capture runs ancestor→descendant, so the
// wrapper handled every Ctrl+Wheel first and stopPropagation'd it: zooming over
// the reader resized the terminal font and the reader's own handler never ran.

test('v3.21.4: reader-area is nested inside terminal-wrapper (the premise)', () => {
  const contentSrc = fs.readFileSync(path.join(repoRoot, 'src/panel/webviewContent.js'), 'utf8');
  const wrapIdx = contentSrc.indexOf('<div id="terminal-wrapper">');
  const readerIdx = contentSrc.indexOf('<div id="reader-area"');
  assert.ok(wrapIdx > 0 && readerIdx > wrapIdx, 'reader-area must render inside terminal-wrapper');
});

test('v3.21.4: terminal Ctrl+Wheel zoom defers to the reader when the cursor is over it', () => {
  const script = clientScript();
  const wrapIdx = script.indexOf("termWrapEl.addEventListener('wheel'");
  assert.ok(wrapIdx > 0);
  const handler = script.slice(wrapIdx, script.indexOf('{ passive: false, capture: true }', wrapIdx));

  assert.ok(handler.includes('readerAreaEl.contains(e.target)'), 'must test the reader subtree');
  const bailIdx = handler.indexOf('if (overReader) return;');
  const preventIdx = handler.indexOf('e.preventDefault();');
  assert.ok(bailIdx > 0 && preventIdx > 0);
  assert.ok(bailIdx < preventIdx, 'the bail-out must precede preventDefault/stopPropagation');
});

test('v3.21.4: readerAreaEl is resolved before the terminal wheel handler is bound', () => {
  const script = clientScript();
  const declIdx = script.indexOf("const readerAreaEl = document.getElementById('reader-area');");
  const wrapDeclIdx = script.indexOf("const termWrapEl = document.getElementById('terminal-wrapper');");
  assert.ok(declIdx > 0 && wrapDeclIdx > declIdx);
});

test('v3.21.4: the reader keeps its own Ctrl+Wheel zoom', () => {
  const script = clientScript();
  assert.match(script, /readerEl\.addEventListener\('wheel'[\s\S]*?--reader-font-size/);
  assert.match(script, /key: 'readerFontSize'/);
});

test('v3.21.4: plain (no-Ctrl) wheel is still left alone in both panes', () => {
  const script = clientScript();
  const wheelHandlers = script.split("addEventListener('wheel'").slice(1);
  const zoomHandlers = wheelHandlers.filter((h) => h.includes('!e.ctrlKey) return;'));
  assert.equal(zoomHandlers.length, 2, 'terminal + reader zoom handlers');
  for (const h of zoomHandlers) {
    const ctrlIdx = h.indexOf('if (!e.ctrlKey) return;');
    const preventIdx = h.indexOf('e.preventDefault();');
    assert.ok(ctrlIdx >= 0 && ctrlIdx < preventIdx, 'Ctrl check must come first');
  }
});
