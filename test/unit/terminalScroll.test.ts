// Terminal bottom-follow policy.
//
// Regression cover for v3.23.1: the panel hard-pinned every terminal to the
// bottom, so scrolling up in scrollback was undone by the very next PTY chunk
// (see src/lib/terminalScroll.js for the full story).
//
// The pin was also the only thing correcting a refit that reflowed the viewport
// off the bottom — v3.12.0's "stale upper rows" reports. Removing it means every
// refit path has to restore the bottom itself, which the fit-coverage test below
// enforces so a newly added fit cannot quietly reintroduce that bug.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { shouldFollowBottom, clientSource } = require(
  path.join(process.cwd(), 'src/lib/terminalScroll'),
);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getClientScript } = require(path.join(process.cwd(), 'src/panel/webviewClient'));

const CLIENT_PATH = path.join(process.cwd(), 'src/panel/webviewClient.js');

test('a user who scrolled up stays where they are when new output arrives', () => {
  assert.equal(shouldFollowBottom({ wasAtBottom: false }), false);
});

test('a viewport parked at the bottom keeps following output', () => {
  assert.equal(shouldFollowBottom({ wasAtBottom: true }), true);
});

test('scrolling back down to the bottom resumes the follow', () => {
  // The caller re-probes the viewport before every write, so the same input
  // flipping back to true is all "resume" takes.
  assert.equal(shouldFollowBottom({ wasAtBottom: false }), false);
  assert.equal(shouldFollowBottom({ wasAtBottom: true }), true);
});

test('an unknown viewport position falls back to following', () => {
  assert.equal(shouldFollowBottom({}), true);
  assert.equal(shouldFollowBottom(undefined), true);
  assert.equal(shouldFollowBottom(null), true);
});

test('clientSource is inline-safe for the webview template literal', () => {
  const src: string = clientSource();
  assert.ok(src.startsWith('function shouldFollowBottom'));
  assert.ok(!src.includes('`'), 'no backticks — it is embedded inside one');
  assert.ok(!src.includes('${'), 'no interpolation — it is embedded inside one');
  assert.ok(!src.includes('require('), 'must be self-contained in the browser');
});

function renderClientScript(agent: string): string {
  return getClientScript({
    T: {},
    settings: { fontFamily: 'monospace', defaultTheme: 'auto' },
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
    agent,
  });
}

test('the webview client no longer carries the unconditional bottom pin', () => {
  const script = renderClientScript('claude');
  assert.ok(
    !script.includes('const PIN_TERMINAL_TO_BOTTOM'),
    'the hard pin constant must be gone, not merely unused',
  );
  assert.ok(
    !/return\s+PIN_TERMINAL_TO_BOTTOM\s+\|\|/.test(script),
    'nothing may short-circuit past the probed viewport position',
  );
  assert.ok(script.includes('function shouldFollowBottom'), 'policy fn is inlined');
});

// Runs the panel's own shouldPinTerminal rather than matching strings, so a
// wiring mistake fails here instead of shipping.
function runShouldPinTerminal(agent: string, wasAtBottom: boolean): boolean {
  const script = renderClientScript(agent);
  const start = script.indexOf('function shouldFollowBottom');
  assert.notEqual(start, -1, 'policy fn must be inlined');
  const end = script.indexOf('function scrollTerminalToBottom()', start);
  assert.notEqual(end, -1);
  // Covers shouldFollowBottom + terminalWasAtBottom + shouldPinTerminal.
  // terminalWasAtBottom touches `term`, but nothing here calls it.
  const block = script.slice(start, end);
  const fn = new Function('wasAtBottom', `${block}\nreturn shouldPinTerminal(wasAtBottom);`);
  return fn(wasAtBottom);
}

test('wiring: the probed position actually reaches the policy', () => {
  for (const agent of ['claude', 'codex', 'kiro', 'gjc', 'grok']) {
    assert.equal(runShouldPinTerminal(agent, false), false, `${agent} scrolled up`);
    assert.equal(runShouldPinTerminal(agent, true), true, `${agent} at bottom`);
  }
});

// Why there is no alt-screen / scrollback-less carve-out to test: xterm sizes a
// buffer with no scrollback to exactly `rows`, so ybase never leaves 0 and the
// probe already reads "at the bottom" on every call. A branch for those cases
// would be unreachable in a real panel — see src/lib/terminalScroll.js.
test('the policy takes the viewport position as its only input', () => {
  assert.equal(shouldFollowBottom({ wasAtBottom: false, isAlternateScreen: true }), false);
  assert.equal(shouldFollowBottom({ wasAtBottom: false, hasScrollback: false }), false);
});

test('every fitAddon.fit() restores the bottom, except the documented initial fit', () => {
  const lines = fs.readFileSync(CLIENT_PATH, 'utf8').split('\n');
  const fitAt: number[] = [];
  lines.forEach((l, i) => {
    if (l.includes('fitAddon.fit()')) fitAt.push(i);
  });
  assert.ok(fitAt.length > 0, 'expected to find refit call sites');

  const guarded = (i: number): boolean => {
    const before = lines.slice(Math.max(0, i - 8), i).join('\n');
    const after = lines.slice(i, i + 5).join('\n');
    // The bottom has to be restored after the fit...
    if (!after.includes('shouldPinTerminal(')) return false;
    // ...from a position probed BEFORE it. Either probed right here, or taken
    // as a parameter because the caller probed outside a deferred frame
    // (refitTerminalAfterInputResize) — probing inside the rAF would read a
    // viewport the layout change has already moved.
    return before.includes('terminalWasAtBottom()') || /\(wasAtBottom\)/.test(before);
  };

  const unguarded = fitAt.filter((i) => !guarded(i));
  const shown = unguarded.map((i) => `${i + 1}: ${lines[i].trim()}`).join('\n');
  assert.equal(
    unguarded.length,
    1,
    `every refit must probe the viewport and restore the bottom; unguarded:\n${shown}`,
  );
  // The one exception: the very first fit, before any output exists to scroll.
  const ctx = lines.slice(Math.max(0, unguarded[0] - 6), unguarded[0]).join('\n');
  assert.ok(
    ctx.includes('normal fit is simpler'),
    `the only unguarded fit must be the initial one, found line ${unguarded[0] + 1}`,
  );
});

test('reader toggle refits through the shared guarded helper', () => {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8');
  const start = source.indexOf('function applySplitVisibility()');
  assert.notEqual(start, -1);
  const end = source.indexOf("document.getElementById('btn-toggle-split')", start);
  assert.notEqual(end, -1);
  const block = source.slice(start, end);
  assert.ok(block.includes('refitTerminal();'));
  assert.ok(!block.includes('fitAddon.fit()'), 'must not refit unguarded');
});

test('the scroll-to-bottom button uses the same probe as the follow policy', () => {
  // A pixel threshold can disagree with the policy by a row, hiding the only
  // affordance that resumes the follow while the follow is actually paused.
  const source = fs.readFileSync(CLIENT_PATH, 'utf8');
  const start = source.indexOf('const checkScroll = () => {');
  assert.notEqual(start, -1);
  const block = source.slice(start, source.indexOf('};', start));
  assert.ok(block.includes('terminalWasAtBottom()'));
  assert.ok(!block.includes('scrollHeight'), 'no px threshold — it drifts from the policy');
});

test('output re-evaluates the scroll affordance', () => {
  // Growing the buffer changes whether the follow is paused without necessarily
  // firing a DOM scroll event, so the write callback has to re-check.
  const source = fs.readFileSync(CLIENT_PATH, 'utf8');
  const start = source.indexOf('term.write(cleaned, () => {');
  assert.notEqual(start, -1);
  const block = source.slice(start, source.indexOf('});', start));
  assert.ok(block.includes('shouldPinTerminal(wasAtBottom)'));
  assert.ok(block.includes('checkScroll()'));
});

test('the rendered client script still parses (inlined policy fn included)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-launcher-scroll-'));
  try {
    for (const agent of ['claude', 'grok']) {
      const file = path.join(dir, `client-${agent}.js`);
      fs.writeFileSync(file, renderClientScript(agent), 'utf8');
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
