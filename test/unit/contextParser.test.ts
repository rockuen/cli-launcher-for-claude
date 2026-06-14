// PTY context usage parser tests.
//
// Claude/Codex report context usage in the launcher, and Kiro exposes only a
// TUI status-line percentage (e.g. "Kiro auto 2%").

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createContextParser } = require(path.join(process.cwd(), 'src/pty/contextParser'));

test('Claude ctx percentage is rendered as context used', () => {
  const entry: any = { agent: 'claude' };
  const usage = createContextParser().feed('ctx:52%', entry);

  assert.deepEqual(usage, {
    used: '520k',
    total: '1000k',
    pct: 52,
    mode: 'used',
  });
  assert.equal(entry._ctxUsed, 520);
  assert.equal(entry._ctxTotal, 1000);
});

test('Codex ctx percentage is rendered as context used', () => {
  const entry: any = { agent: 'codex' };
  const usage = createContextParser().feed('ctx:52%', entry);

  assert.deepEqual(usage, {
    used: '520k',
    total: '1000k',
    pct: 52,
    mode: 'used',
  });
  assert.equal(entry._ctxUsed, 520);
  assert.equal(entry._ctxTotal, 1000);
});

test('Kiro TUI status percentage is parsed as context used', () => {
  const entry: any = { agent: 'kiro' };
  const usage = createContextParser().feed('Kiro  auto  2%', entry);

  assert.deepEqual(usage, {
    used: '20k',
    total: '1000k',
    pct: 2,
    mode: 'used',
  });
});

test('model context window text overrides the default total', () => {
  const entry: any = { agent: 'claude' };
  const usage = createContextParser().feed('200k context ctx:25%', entry);

  assert.deepEqual(usage, {
    used: '50k',
    total: '200k',
    pct: 25,
    mode: 'used',
  });
});
