// v3.5.2 — detectShellRunning regex extraction tests.
// detectShellRunning lives in src/lib/shellRunningDetect.js as a plain JS
// helper so the panel can call it from any PTY data hook without dragging
// a vscode dep into the test runtime.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

const { detectShellRunning } = require('../../src/lib/shellRunningDetect');

test('matches the canonical Claude Code completion line', () => {
  const sample = '* Baked for 6m 49s · 1 shell still running';
  assert.equal(detectShellRunning(sample), 1);
});

test('plural shells are supported', () => {
  assert.equal(detectShellRunning('* Baked for 12s · 3 shells still running'), 3);
});

test('ANSI color codes are stripped before matching', () => {
  const sample = '\x1b[2m* Baked for 1s · \x1b[33m2 shells still running\x1b[0m';
  assert.equal(detectShellRunning(sample), 2);
});

test('returns null when no count is present', () => {
  assert.equal(detectShellRunning('shell still running'), null);
});

test('returns null on the empty / non-string input', () => {
  assert.equal(detectShellRunning(''), null);
  assert.equal(detectShellRunning(null as any), null);
  assert.equal(detectShellRunning(undefined as any), null);
});

test('match is taken from the chunk tail (handles long preambles)', () => {
  const filler = 'x'.repeat(20000);
  const sample = filler + '\n* Baked for 8s · 1 shell still running\n';
  assert.equal(detectShellRunning(sample), 1);
});

test('returns null when the count is zero', () => {
  // Claude Code never actually emits "0 shells", but we guard anyway so a
  // future change does not turn the dot blue when nothing is running.
  assert.equal(detectShellRunning('* Baked for 1s · 0 shells still running'), null);
});

test('ignores unrelated mentions of "shell"', () => {
  assert.equal(detectShellRunning('Bash shell exited cleanly.'), null);
  assert.equal(detectShellRunning('bypass permissions on · 1 shell'), null);
});
