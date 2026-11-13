// Attention blink — a tab that needs you while you are on another tab blinks
// its icon green ↔ gray (panel/statusIndicator). Until v3.31.1 a ⚠ blinked in
// the tab title instead; each tick changed the tab's width, so with many tabs
// open the ones after it kept moving under the pointer. Pins: only the icon
// changes (never the title), the blink stops by itself on focus / a new state /
// close without painting over the icon that state set, and both PTY paths
// (createPanel, restartPty) start it where they flag the tab.

import { test, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = process.cwd();

function loadStatusIndicator() {
  const Module = require('node:module');
  const vscodeStub = {
    Uri: { file: (p: string) => ({ fsPath: p }) },
    ThemeColor: class { constructor(public id: string) {} },
    env: { language: 'en' },
  };
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (this: unknown, req: string, ...rest: unknown[]) {
    return req === 'vscode' ? 'vscode' : origResolve.call(this, req, ...rest);
  };
  require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeStub } as any;
  const file = path.join(ROOT, 'src/panel/statusIndicator.js');
  delete require.cache[require.resolve(file)];
  try {
    return require(file);
  } finally {
    Module._resolveFilename = origResolve;
  }
}

const {
  startAttentionBlink, stopAttentionBlink, ATTENTION_BLINK_MS,
  setTabIcon, setIdleIcon, BG_SHELL_TTL_MS,
} = loadStatusIndicator();

// A webview panel as the blink sees it: every icon write is recorded by file
// name, every title write is counted, and `active` can be made to throw the way
// a disposed panel's getter does.
function makePanel(agent = 'claude') {
  const icons: string[] = [];
  const s = { titleWrites: 0, active: false, disposed: false };
  const panel: any = {
    _agent: agent,
    get active() {
      if (s.disposed) throw new Error('Webview is disposed');
      return s.active;
    },
    set iconPath(v: any) {
      if (s.disposed) throw new Error('Webview is disposed');
      icons.push(path.basename(v.dark.fsPath));
    },
    get title() { return 'tab'; },
    set title(_v: string) { s.titleWrites++; },
  };
  return { panel, icons, s };
}

function withTimers(fn: () => void) {
  mock.timers.enable({ apis: ['setInterval'] });
  try { fn(); } finally { mock.timers.reset(); }
}
const tick = (n = 1) => { for (let i = 0; i < n; i++) mock.timers.tick(ATTENTION_BLINK_MS); };

test('a flagged background tab blinks its icon green ↔ gray and never writes its title', () => {
  withTimers(() => {
    const { panel, icons, s } = makePanel();
    const entry: any = { state: 'needs-attention' };
    startAttentionBlink(panel, entry, ROOT);
    assert.deepEqual(icons, [], 'the caller painted green; the first change comes one tick later');

    tick();
    assert.deepEqual(icons, ['claude-idle.svg']);
    tick();
    assert.deepEqual(icons, ['claude-idle.svg', 'claude-done.svg']);
    tick(2);
    assert.deepEqual(icons.slice(2), ['claude-idle.svg', 'claude-done.svg']);
    assert.equal(s.titleWrites, 0, 'the tab keeps its width');

    // Flagged again while already blinking (a second prompt): still one timer.
    startAttentionBlink(panel, entry, ROOT);
    tick();
    assert.equal(icons.length, 5);
    stopAttentionBlink(panel, entry, ROOT);
  });
});

test('each agent blinks its own icon set', () => {
  withTimers(() => {
    for (const agent of ['codex', 'gjc', 'kiro', 'grok', 'chief', 'antigravity']) {
      const { panel, icons } = makePanel(agent);
      const entry: any = { state: 'needs-attention' };
      startAttentionBlink(panel, entry, ROOT);
      tick(2);
      assert.deepEqual(icons, [`${agent}-idle.svg`, `${agent}-done.svg`]);
      stopAttentionBlink(panel, entry, ROOT);
    }
  });
});

test('focusing the tab stops the blink; the icon the focus handler set is left alone', () => {
  withTimers(() => {
    const { panel, icons, s } = makePanel();
    const entry: any = { state: 'needs-attention' };
    startAttentionBlink(panel, entry, ROOT);
    tick(); // gray half
    // createPanel's onDidChangeViewState: needs-attention → waiting + idle icon.
    s.active = true;
    entry.state = 'waiting';
    const before = icons.length;
    tick(3);
    assert.equal(icons.length, before, 'no write after the tab moved on');
    assert.equal(entry._attentionBlink, null);
  });
});

test('a new state stops the blink without repainting over that state\'s icon', () => {
  withTimers(() => {
    for (const next of ['running', 'waiting', 'done', 'error', 'stuck']) {
      const { panel, icons } = makePanel();
      const entry: any = { state: 'needs-attention' };
      startAttentionBlink(panel, entry, ROOT);
      tick(); // gray half: the worst moment to stop
      entry.state = next;
      const before = icons.length;
      tick(3);
      assert.equal(icons.length, before, next);
      assert.equal(entry._attentionBlink, null, next);
    }
  });
});

test('a tab still flagged when the blink stops goes back to green, not gray', () => {
  withTimers(() => {
    // Focused while the editor window is not: the flag stays up (nobody saw it).
    const a = makePanel();
    const entryA: any = { state: 'needs-attention' };
    startAttentionBlink(a.panel, entryA, ROOT);
    tick(); // gray
    a.s.active = true;
    tick();
    assert.deepEqual(a.icons, ['claude-idle.svg', 'claude-done.svg']);
    assert.equal(entryA._attentionBlink, null);
    tick(3);
    assert.equal(a.icons.length, 2);

    // Stopped on the green half: nothing to repaint.
    const b = makePanel();
    const entryB: any = { state: 'needs-attention' };
    startAttentionBlink(b.panel, entryB, ROOT);
    tick(2); // gray, green
    b.s.active = true;
    tick();
    assert.deepEqual(b.icons, ['claude-idle.svg', 'claude-done.svg']);

    // A new flag after a stop blinks again.
    b.s.active = false;
    startAttentionBlink(b.panel, entryB, ROOT);
    tick();
    assert.deepEqual(b.icons.slice(2), ['claude-idle.svg']);
    stopAttentionBlink(b.panel, entryB, ROOT);
    assert.deepEqual(b.icons.slice(3), ['claude-done.svg']);
  });
});

test('closing the tab stops the blink and never touches the disposed panel', () => {
  withTimers(() => {
    // onDidDispose: entry._disposed, then stopAttentionBlink.
    const a = makePanel();
    const entryA: any = { state: 'needs-attention' };
    startAttentionBlink(a.panel, entryA, ROOT);
    tick(); // gray
    entryA._disposed = true;
    a.s.disposed = true;
    assert.doesNotThrow(() => stopAttentionBlink(a.panel, entryA, ROOT));
    assert.equal(entryA._attentionBlink, null);
    tick(3);
    assert.deepEqual(a.icons, ['claude-idle.svg']);

    // A tick that lands on a panel whose getters already throw stops quietly.
    const b = makePanel();
    const entryB: any = { state: 'needs-attention' };
    startAttentionBlink(b.panel, entryB, ROOT);
    b.s.disposed = true;
    assert.doesNotThrow(() => tick(2));
    assert.equal(entryB._attentionBlink, null);
    assert.deepEqual(b.icons, []);

    // Nothing to stop, or nothing to start on: no-ops.
    assert.doesNotThrow(() => stopAttentionBlink(b.panel, entryB, ROOT));
    assert.doesNotThrow(() => stopAttentionBlink(null, null, ROOT));
    assert.doesNotThrow(() => startAttentionBlink(null, entryB, ROOT));
    assert.equal(entryB._attentionBlink, null);
  });
});

test('the background-shell fade leaves the icon alone once the tab has moved on', () => {
  // An idle tab with a background shell is blue, and a timer fades it to gray
  // 30 s after the last "shells still running" line. That timer used to paint
  // whatever the tab had become in the meantime — over the blink, too.
  const run = (fn: () => void) => {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_700_000_000_000 });
    try { fn(); } finally { mock.timers.reset(); }
  };
  const blueTab = () => {
    const p = makePanel();
    const entry: any = { state: 'waiting', _bgShells: 1, _bgShellsAt: Date.now() };
    setIdleIcon(p.panel, entry, ROOT);
    assert.deepEqual(p.icons, ['claude-shell.svg']);
    return { ...p, entry };
  };

  run(() => {
    // Still idle when the timer fires: fades to gray, as before.
    const { icons } = blueTab();
    mock.timers.tick(BG_SHELL_TTL_MS + 200);
    assert.deepEqual(icons, ['claude-shell.svg', 'claude-idle.svg']);
  });

  run(() => {
    // Flagged and blinking when it fires: the blink keeps its green / gray turn.
    const { panel, icons, entry } = blueTab();
    entry.state = 'needs-attention';
    setTabIcon(panel, 'done', ROOT);
    startAttentionBlink(panel, entry, ROOT);
    mock.timers.tick(BG_SHELL_TTL_MS + 5 * ATTENTION_BLINK_MS);
    const blink = icons.slice(2);
    assert.ok(blink.length >= 40);
    blink.forEach((icon, i) => assert.equal(icon, i % 2 === 0 ? 'claude-idle.svg' : 'claude-done.svg', `paint ${i}`));
    stopAttentionBlink(panel, entry, ROOT);
  });

  run(() => {
    // Flagged without a blink (the tab was the active one in an unfocused
    // window), running, or exited: the icon that state set stays.
    for (const [next, icon] of [['needs-attention', 'done'], ['running', 'running'], ['done', 'done'], ['error', 'error']]) {
      const { panel, icons, entry } = blueTab();
      entry.state = next;
      setTabIcon(panel, icon, ROOT);
      mock.timers.tick(BG_SHELL_TTL_MS + 200);
      assert.deepEqual(icons, ['claude-shell.svg', `claude-${icon}.svg`], next);
    }
  });
});

test('both PTY paths flag a background tab the same way: green icon, state, blink — never the title', () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  const create = read('src/panel/createPanel.js');
  const restart = read('src/panel/restartPty.js');

  // Cut each needs-attention transition out and check what it touches, up to
  // the end of the branch that set the state (the next state change or return).
  const transitions = (src: string) => src.split("entry.state = 'needs-attention';").slice(1)
    .map((part) => part.split(/entry\.state = '|\n\s*return[ ;]|\n\s*\}, (?:0|IDLE_DELAY_MS)\);/)[0]);
  const inCreate = transitions(create);
  const inRestart = transitions(restart);
  assert.equal(inCreate.length, 3, 'prompt detector, quiet-output guess, agent notify');
  assert.equal(inRestart.length, 2, 'grok turn end, quiet-output guess');
  for (const body of [...inCreate, ...inRestart]) {
    assert.match(body, /setTabIcon\(panel, 'done', extensionPath\);/);
    assert.match(body, /postMessage\(\{ type: 'state', state: 'needs-attention' \}\)/);
    assert.match(body, /postMessage\(\{ type: 'notify' \}\); \} catch \(_\) \{\}\n\s*startAttentionBlink\(panel, entry, extensionPath\);/);
    assert.doesNotMatch(body, /setPanelTitle\(/);
  }
  // createPanel only blinks a tab you are not on.
  assert.equal((create.match(/if \(!panel\.active\) \{\n\s*try \{ panel\.webview\.postMessage\(\{ type: 'notify' \}\); \} catch \(_\) \{\}\n\s*startAttentionBlink\(/g) || []).length, 3);
  // Closing the tab clears the timer.
  assert.match(create, /panel\.onDidDispose\(\(\) => \{\n\s*entry\._disposed = true;[\s\S]*?stopAttentionBlink\(panel, entry, extensionPath\);\n\s*killPtyProcess\(entry\.pty\);/);
});
