import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

function readCreatePanel(): string {
  return fs.readFileSync(path.join(process.cwd(), 'src', 'panel', 'createPanel.js'), 'utf8');
}

function readRestartPty(): string {
  return fs.readFileSync(path.join(process.cwd(), 'src', 'panel', 'restartPty.js'), 'utf8');
}

test('gjc prompt poll is guarded so non-gjc panels never arm the 1s timer', () => {
  const source = readCreatePanel();

  assert.match(source, /const GJC_PROMPT_POLL_MS = 1000;/);
  assert.match(source, /function isGjcPanel\(\) \{\s*return \(entry\.agent \|\| panel\._agent\) === 'gjc';\s*\}/s);
  assert.match(
    source,
    /function scheduleGjcPromptCheck\(ptyToken\) \{\s*if \(!isGjcPanel\(\) \|\| entry\._gjcPromptTimer \|\| entry\._disposed \|\| !entry\.pty\) return;/s,
  );
  assert.match(source, /entry\._gjcPromptTimer = setTimeout\(\(\) => \{\s*entry\._gjcPromptTimer = null;\s*handlePromptAffordanceCheck\(ptyToken\);\s*\}, GJC_PROMPT_POLL_MS\);/s);
  assert.match(source, /scheduleGjcPromptCheck\(initialPty\);/);
});

test('prompt fast path uses gjc detector mode, waiting icon, race guard, and timer cleanup', () => {
  const source = readCreatePanel();

  assert.match(source, /isGjcPanel\(\) \? \{ agent: 'gjc' \} : undefined/s);
  assert.match(source, /if \(runningDelayTimer\) \{ clearTimeout\(runningDelayTimer\); runningDelayTimer = null; \}/);
  assert.match(source, /entry\.state !== 'needs-attention'/);
  assert.match(source, /setTabIcon\(panel, 'waiting', extensionPath\);/);

  const cleanupCalls = source.match(/clearGjcPromptTimer\(\);/g) || [];
  assert.ok(cleanupCalls.length >= 2, 'expected gjc prompt timer cleanup on exit and dispose');
});

test('prompt terminal restore uses a flag separate from the dedupe signature', () => {
  const source = readCreatePanel();

  assert.match(source, /entry\._promptTerminalExpanded/);
  assert.match(source, /const hadPrompt = !!entry\._promptSig \|\| !!entry\._promptTerminalExpanded;/);
  assert.match(source, /entry\._promptTerminalExpanded = true;/);
  assert.match(source, /entry\._promptTerminalExpanded = false;/);
});

test('restartPty also wires gjc prompt polling and clears stale timers', () => {
  const source = readRestartPty();

  assert.match(source, /const GJC_PROMPT_POLL_MS = 1000;/);
  assert.match(source, /detectPromptAffordance/);
  assert.match(source, /showDesktopNotification/);
  assert.match(source, /function isGjcPanel\(\) \{\s*return agent === 'gjc';\s*\}/s);
  assert.match(source, /entry\._recentTail = \(\(entry\._recentTail \|\| ''\) \+ data\)\.slice\(-6000\);/);
  assert.match(source, /scheduleGjcPromptCheck\(thisPty\);/);
  assert.match(source, /if \(handlePromptAffordanceCheck\(thisPty\)\) return;/);
  assert.match(source, /setTabIcon\(panel, 'waiting', extensionPath\);/);
  assert.match(source, /if \(entry\._bgShellsTimer\) \{ clearTimeout\(entry\._bgShellsTimer\); entry\._bgShellsTimer = null; \}/);
  assert.match(source, /ptyProcess\.onExit\(\(\{ exitCode \}\) => \{[\s\S]*clearGjcPromptTimer\(\);[\s\S]*entry\._bgShells = 0;[\s\S]*entry\._bgShellsAt = null;/);
  assert.match(source, /clearGjcPromptTimer\(\);/);
});
