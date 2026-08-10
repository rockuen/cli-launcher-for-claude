// Panel Ctrl+C copy-selection resolution + clipboard fallback wiring.
//
// Regression cover for v3.20.8: Reader copies handed the clipboard blank or
// stale terminal text (see src/lib/copySelection.js for the full story).

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveCopyText, clientSource } = require(path.join(process.cwd(), 'src/lib/copySelection'));

test('a whitespace-only terminal selection never wins over Reader text', () => {
  assert.equal(
    resolveCopyText({
      termSelection: '\n\n\n',
      cachedTermSelection: '',
      domSelection: 'reader paragraph',
      fromTerminal: false,
    }),
    'reader paragraph',
  );
});

test('a blank terminal selection alone resolves to no selection (^C falls through to the PTY)', () => {
  assert.equal(
    resolveCopyText({ termSelection: '   \n  ', cachedTermSelection: '', domSelection: '' }),
    '',
  );
  assert.equal(resolveCopyText({}), '');
  assert.equal(resolveCopyText(undefined), '');
});

test('a stale terminal selection loses to the live Reader selection', () => {
  assert.equal(
    resolveCopyText({
      termSelection: 'old terminal output',
      cachedTermSelection: 'older terminal output',
      domSelection: 'freshly highlighted reader text',
      fromTerminal: false,
    }),
    'freshly highlighted reader text',
  );
});

test('^C inside the terminal still prefers the terminal selection', () => {
  assert.equal(
    resolveCopyText({
      termSelection: 'terminal output',
      cachedTermSelection: '',
      domSelection: 'reader text',
      fromTerminal: true,
    }),
    'terminal output',
  );
  // xterm clears its selection on mousedown in mouse-reporting mode → cache.
  assert.equal(
    resolveCopyText({
      termSelection: '',
      cachedTermSelection: 'cached terminal output',
      domSelection: '',
      fromTerminal: true,
    }),
    'cached terminal output',
  );
});

test('outside the terminal a terminal selection is still used when nothing is selected in the DOM', () => {
  assert.equal(
    resolveCopyText({
      termSelection: 'terminal output',
      cachedTermSelection: '',
      domSelection: '   ',
      fromTerminal: false,
    }),
    'terminal output',
  );
});

test('leading indentation is preserved (only emptiness is judged on the trimmed form)', () => {
  const code = '    indented line\n    second';
  assert.equal(resolveCopyText({ domSelection: code, fromTerminal: false }), code);
});

test('the webview client inlines the shared resolver and the host clipboard fallback', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getClientScript } = require(path.join(process.cwd(), 'src/panel/webviewClient'));
  const script = getClientScript({
    T: {},
    settings: { fontFamily: 'monospace', defaultTheme: 'auto', pasteToFileThreshold: 2000 },
    fontSize: 14,
    bg: '#000000',
    fg: '#ffffff',
    cursor: '#ffffff',
    border: '#333333',
    outerBg: '#000000',
    statusGray: '#888888',
    isDark: true,
    memo: '',
    customButtons: [],
    customSlashCommands: [],
    splitRatio: 0.85,
    splitLayoutOn: true,
    extraSlashes: [],
    agent: 'chief',
  });

  assert.ok(script.includes('function resolveCopyText(input)'));
  assert.ok(script.includes(clientSource()));
  assert.ok(script.includes('async function copyTextToClipboard(text)'));
  assert.ok(script.includes("vscode.postMessage({ type: 'copy-text', text: text })"));
  // The old truthiness chain must be gone — it is the bug.
  assert.ok(!script.includes('getCleanSelection() || lastSelectionCache'));
  assert.ok(!script.includes('navigator.clipboard.writeText(sel).catch(() => {})'));
  assert.doesNotThrow(() => new Function(script));
});

test('both readers route a rejected clipboard write to the extension host', () => {
  const router = fs.readFileSync(path.join(process.cwd(), 'src/panel/messageRouter.js'), 'utf8');
  assert.ok(router.includes("case 'copy-text':"));
  assert.ok(router.includes('vscode.env.clipboard.writeText(msg.text)'));

  const reader = fs.readFileSync(path.join(process.cwd(), 'src/panel/readerView.js'), 'utf8');
  assert.ok(reader.includes("msg.type === 'copy-text'"));
  assert.ok(reader.includes("vscode.postMessage({ type: 'copy-text', text: text })"));
});
