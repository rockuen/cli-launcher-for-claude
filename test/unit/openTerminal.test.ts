// Phase 8 — pickBackend pure-function tests.
//
// The wrapper itself is a thin vscode.commands.executeCommand bridge,
// so the only logic worth testing in isolation is the backend choice.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { pickBackend } from '../../src/orchestration/core/openTerminalCommand';

test('pickBackend: webview preference always returns webview', () => {
  assert.equal(
    pickBackend({ preference: 'webview', multiplexerAvailable: true }),
    'webview',
  );
  assert.equal(
    pickBackend({ preference: 'webview', multiplexerAvailable: false }),
    'webview',
  );
});

test('pickBackend: multiplexer preference + available → multiplexer', () => {
  assert.equal(
    pickBackend({ preference: 'multiplexer', multiplexerAvailable: true }),
    'multiplexer',
  );
});

test('pickBackend: multiplexer preference but unavailable → silent webview fallback', () => {
  assert.equal(
    pickBackend({ preference: 'multiplexer', multiplexerAvailable: false }),
    'webview',
  );
});
