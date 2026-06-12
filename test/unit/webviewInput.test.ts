// Webview input-panel transport tests.
//
// The bottom textarea must send the prompt and submit key in one message. Codex
// accepts text injected by the launcher, but can ignore an Enter delivered as a
// separate webview→extension message immediately after the text.

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

test('editor textarea submits text and Enter as one PTY input payload', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/panel/webviewClient.js'),
    'utf8',
  );
  const start = source.indexOf('function sendEditorContent()');
  assert.notEqual(start, -1);

  const end = source.indexOf("document.getElementById('editor-send')", start);
  assert.notEqual(end, -1);

  const block = source.slice(start, end);

  assert.ok(
    block.includes("vscode.postMessage({ type: 'input', data: text + '\\\\r' });"),
  );
  assert.ok(!block.includes("const lines = text.split('\\\\n');"));
  assert.ok(!block.includes("vscode.postMessage({ type: 'input', data: '\\\\r' });"));

  const script = renderClientScript();
  assert.ok(script.includes("vscode.postMessage({ type: 'input', data: text + '\\r' });"));
});

test('context indicator supports remaining-mode payloads', () => {
  const script = renderClientScript();

  assert.ok(script.includes("const isRemaining = mode === 'remaining';"));
  assert.ok(script.includes("updateContextIndicator(msg);"));
  assert.ok(script.includes('isRemaining ? p <= 20 : p >= 80'));
  assert.ok(script.includes('isRemaining ? p <= 50 : p >= 50'));
});
