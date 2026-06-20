// Webview input-panel transport tests.
//
// The bottom textarea should route submits through the extension-side submit
// helper. Claude/Codex are more reliable when the extension sends bracketed
// paste + Enter instead of raw text + CR from the webview.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

// webviewClient is CommonJS because the extension loads panel modules directly.
// It is intentionally not emitted into .test-out by tsconfig.test.json, so load
// it from the repo root rather than from the compiled test file's directory.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getClientScript } = require(path.join(process.cwd(), 'src/panel/webviewClient'));

function renderClientScript(): string {
  return getClientScript({
    T: {},
    settings: {
      fontFamily: 'monospace',
      defaultTheme: 'auto',
      pasteToFileThreshold: 2000,
      pasteTableAsMarkdown: true,
    },
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
    splitLayoutOn: false,
    extraSlashes: [],
    agent: 'codex',
  });
}

test('editor textarea submits through the submit-input route', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/panel/webviewClient.js'),
    'utf8',
  );
  const start = source.indexOf('function sendEditorContent()');
  assert.notEqual(start, -1);

  const end = source.indexOf("document.getElementById('editor-send')", start);
  assert.notEqual(end, -1);

  const block = source.slice(start, end);

  assert.ok(block.includes("vscode.postMessage({ type: 'submit-input', text });"));
  assert.ok(block.includes('term.focus();'));
  assert.ok(!block.includes("const lines = text.split('\\\\n');"));
  assert.ok(!block.includes("vscode.postMessage({ type: 'input', data: '\\\\r' });"));

  const script = renderClientScript();
  assert.ok(script.includes("vscode.postMessage({ type: 'submit-input', text });"));
});

test('gjc panels use the Gajae red/yellow input theme', () => {
  const script = getClientScript({
    T: {},
    settings: {
      fontFamily: 'monospace',
      defaultTheme: 'auto',
      pasteToFileThreshold: 2000,
      pasteTableAsMarkdown: true,
    },
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
    splitLayoutOn: false,
    extraSlashes: [],
    agent: 'gjc',
  });

  assert.ok(script.includes('const IS_GJC = true'));
  assert.ok(script.includes("IS_GJC ? 'gjc'"));
  assert.ok(script.includes("accent: '#ff261f'"));
  assert.ok(script.includes("accentStrong: '#ffd22e'"));
});

test('terminal output is bottom-pinned after writes and resizes', () => {
  const script = renderClientScript();

  assert.ok(script.includes('const PIN_TERMINAL_TO_BOTTOM = true'));
  assert.ok(script.includes('function scrollTerminalToBottom()'));
  assert.ok(script.includes('if (shouldPinTerminal(wasAtBottom)) scrollTerminalToBottom();'));
});

test('context indicator keeps standard usage-mode color thresholds', () => {
  const script = renderClientScript();

  assert.ok(script.includes("updateContextIndicator(msg);"));
  assert.ok(script.includes('if (p >= 80)'));
  assert.ok(script.includes('} else if (p >= 50)'));
  assert.ok(!script.includes("mode === 'remaining'"));
  assert.ok(!script.includes('Context remaining'));
});

test('toolbar exposes an in-panel handoff button', () => {
  const script = renderClientScript();

  assert.ok(script.includes("document.getElementById('btn-handoff')"));
  assert.ok(script.includes("command: 'claudeCodeLauncher.handoffToOther'"));
});
