// v3.28.0 — notifications the agent sends itself.
//
// The launcher guessed turn ends from quiet output (3 s quiet after 7 s
// running → needs attention + toast), which misfires on every long tool call.
// `cli-launcher notify` lets an agent say it; Claude Code tabs get Stop /
// Notification hooks wired to it, and a tab that has heard from its hooks stops
// guessing.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/* eslint-disable @typescript-eslint/no-var-requires */
const ROOT = process.cwd();
const notify = require(path.join(ROOT, 'src/lib/agentNotify'));
const lib = require(path.join(ROOT, 'src/lib/agentCli'));
const cli = require(path.join(ROOT, 'bin/cli-launcher.js'));
const {
  notifyFromHookInput, planAgentNotify, notifyMessage, claudeHookSettings, HOOK_COMMAND,
  pendingAfterOutput, isDuplicate, PENDING_SUSTAIN_MS, DEDUP_MS, OUTPUT_LIVE_GAP_MS,
  endsTurn, isStaleBusy,
} = notify;

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');
}

// ---- pure decisions ----

test('hook input → event: Stop is done, Notification is attention, the rest is ignored', () => {
  assert.deepEqual(notifyFromHookInput({ hook_event_name: 'Stop', stop_hook_active: false }), { event: 'done' });
  assert.deepEqual(
    notifyFromHookInput({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' }),
    { event: 'attention', message: 'Claude needs your permission to use Bash', kind: 'permission_prompt' },
  );
  assert.equal(notifyFromHookInput({ hook_event_name: 'Notification', notification_type: 'auth_success', message: 'ok' }), null);
  // Only the types that need the user (Claude Code docs list 13 types)
  for (const kind of ['permission_prompt', 'idle_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']) {
    assert.equal(notifyFromHookInput({ hook_event_name: 'Notification', notification_type: kind, message: 'm' }).event, 'attention', kind);
  }
  for (const kind of ['elicitation_complete', 'elicitation_response', 'agent_completed', 'quota_auto_resume_fired', 'quota_auto_resume_stale', 'quota_auto_resume_disabled', 'plugin_notification', 'some_future_type']) {
    assert.equal(notifyFromHookInput({ hook_event_name: 'Notification', notification_type: kind, message: 'm' }), null, kind);
  }
  assert.equal(notifyFromHookInput({ hook_event_name: 'SubagentStop' }), null);
  assert.equal(notifyFromHookInput({ hook_event_name: 'PreToolUse' }), null);
  // A new turn, and a turn that ended on an API error (no Stop for those)
  assert.deepEqual(notifyFromHookInput({ hook_event_name: 'UserPromptSubmit', prompt: 'x' }), { event: 'busy' });
  assert.deepEqual(notifyFromHookInput({ hook_event_name: 'StopFailure', error: 'rate_limit' }), { event: 'attention', message: 'Stopped: rate_limit', kind: 'stop_failure' });
  assert.deepEqual(notifyFromHookInput({ hook_event_name: 'StopFailure', error: { message: 'Overloaded' } }).message, 'Stopped: Overloaded');
  assert.deepEqual(notifyFromHookInput({ hook_event_name: 'StopFailure' }).message, 'Stopped with an error');
  // Claude's own wording wins when it is there
  assert.equal(notifyFromHookInput({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: 'API Error: Rate limit reached' }).message, 'API Error: Rate limit reached');
  assert.equal(notifyFromHookInput(null), null);
  assert.equal(notifyFromHookInput('Stop'), null);
  // An older Claude Code without notification_type still notifies
  assert.deepEqual(notifyFromHookInput({ hook_event_name: 'Notification', message: 'x' }), { event: 'attention', message: 'x', kind: null });
});

const LIVE = { state: 'running', alive: true, announced: false, viewing: false };

test('plan: done/attention flag the tab and toast; info only toasts; busy does neither', () => {
  assert.deepEqual(planAgentNotify({ event: 'done' }, LIVE), { attention: true, toast: true });
  assert.deepEqual(planAgentNotify({ event: 'attention', kind: 'permission_prompt' }, LIVE), { attention: true, toast: true });
  assert.deepEqual(planAgentNotify({ event: 'info', message: 'x' }, LIVE), { attention: false, toast: true });
  assert.deepEqual(planAgentNotify({ event: 'busy' }, LIVE), { attention: false, toast: false });
  assert.deepEqual(planAgentNotify({ event: 'bogus' }, LIVE), { attention: false, toast: false });
});

test("plan: Claude's 60-second idle reminder only speaks when the turn end was not announced", () => {
  assert.deepEqual(planAgentNotify({ event: 'attention', kind: 'idle_prompt' }, { ...LIVE, announced: true }), { attention: false, toast: false });
  // A silent settle ('waiting') is not an announcement — e.g. a turn that ended
  // on an error nobody reported
  assert.deepEqual(planAgentNotify({ event: 'attention', kind: 'idle_prompt' }, { ...LIVE, state: 'waiting' }), { attention: true, toast: true });
  // A permission prompt notifies even after an announced turn
  assert.deepEqual(planAgentNotify({ event: 'attention', kind: 'permission_prompt' }, { ...LIVE, announced: true }), { attention: true, toast: true });
});

test('plan: a dead tab only toasts; a tab the user is looking at gets neither', () => {
  assert.deepEqual(planAgentNotify({ event: 'done' }, { ...LIVE, alive: false, state: 'done' }), { attention: false, toast: true });
  assert.deepEqual(planAgentNotify({ event: 'attention' }, { ...LIVE, alive: false }), { attention: false, toast: true });
  assert.deepEqual(planAgentNotify({ event: 'done' }, { ...LIVE, viewing: true }), { attention: false, toast: false });
});

test('a pending Stop survives a redraw burst and is cancelled by output that keeps flowing', () => {
  const t0 = 1_000_000;
  let p = { ev: { event: 'done' }, at: t0 };
  // Claude's end-of-turn redraw: a few chunks within a second
  for (const dt of [50, 120, 400, 900]) p = pendingAfterOutput(p, t0 + dt);
  assert.ok(p, 'a short burst keeps the Stop pending');
  // A blocked stop (OMC ralph, /goal): Claude keeps streaming
  let q: any = { ev: { event: 'done' }, at: t0 };
  for (let dt = 100; dt <= PENDING_SUSTAIN_MS + 200 && q; dt += 100) q = pendingAfterOutput(q, t0 + dt);
  assert.equal(q, null, 'sustained output cancels it');
  assert.equal(pendingAfterOutput(null, t0), null);
});

test('separate redraw bursts never add up to "still working" (a statusline refresh, then the title escape)', () => {
  const t0 = 1_000_000;
  let p: any = { ev: { event: 'done' }, at: t0 };
  p = pendingAfterOutput(p, t0 + 200);
  p = pendingAfterOutput(p, t0 + 2300); // 2.1 s later, after a quiet gap
  assert.ok(p, 'spaced chunks keep the Stop pending');
  p = pendingAfterOutput(p, t0 + 4600);
  assert.ok(p);
  // A gap just over the live window also breaks the run
  let r: any = { ev: { event: 'done' }, at: t0 };
  for (let dt = 0; dt <= 1500; dt += 100) r = pendingAfterOutput(r, t0 + dt);
  r = pendingAfterOutput(r, t0 + 1500 + OUTPUT_LIVE_GAP_MS + 1);
  for (let dt = 100; dt <= 1500; dt += 100) r = pendingAfterOutput(r, t0 + 1500 + OUTPUT_LIVE_GAP_MS + 1 + dt);
  assert.ok(r, 'two 1.5 s runs with a gap are not one 3 s run');
});

test('output runs: separate bursts restart the run; 2 s unbroken is real work', () => {
  const { outputRunStart, isSustainedRun } = notify;
  const t0 = 1_000_000;
  let start: any = null;
  let last: any = null;
  for (let dt = 0; dt <= 2000; dt += 100) { start = outputRunStart(start, last, t0 + dt); last = t0 + dt; }
  assert.equal(start, t0);
  assert.equal(isSustainedRun(start, t0 + 2000), true);
  // A gap restarts it
  const after = outputRunStart(start, last, last + OUTPUT_LIVE_GAP_MS + 1);
  assert.equal(after, last + OUTPUT_LIVE_GAP_MS + 1);
  assert.equal(isSustainedRun(after, after + 100), false);
  assert.equal(isSustainedRun(null, t0), false);
  // The tab uses it to let real work outrank the agent's flag and reopen the turn
  const createPanel = read('src/panel/createPanel.js');
  assert.match(createPanel, /if \(entry\._hookSignals && isSustainedRun\(entry\._outputRunStart, outAt\)\) \{\s*entry\._agentFlagged = false;\s*entry\._turnAnnounced = false;/);
  assert.match(read('src/panel/restartPty.js'), /if \(entry\._hookSignals && isSustainedRun\(entry\._outputRunStart, outAt\)\) \{/);
});

test('turn ends and stale busy', () => {
  assert.equal(endsTurn({ event: 'done' }), true);
  assert.equal(endsTurn({ event: 'attention', kind: 'stop_failure' }), true);
  assert.equal(endsTurn({ event: 'attention', kind: 'permission_prompt' }), false, 'a prompt inside a turn does not end it');
  assert.equal(endsTurn({ event: 'info' }), false);
  // UserPromptSubmit's hook started before the Stop's but arrived after it
  assert.equal(isStaleBusy(1000, 1500), true);
  assert.equal(isStaleBusy(2000, 1500), false);
  assert.equal(isStaleBusy(undefined, 1500), false, 'an old CLI without t is not dropped');
  assert.equal(isStaleBusy(1000, null), false);
});

test('dedup window', () => {
  assert.equal(isDuplicate(1000, 1000 + DEDUP_MS - 1), true);
  assert.equal(isDuplicate(1000, 1000 + DEDUP_MS), false);
  assert.equal(isDuplicate(0, 5), false);
  assert.equal(isDuplicate(undefined, 5), false);
});

test('toast text: the agent message, else a short default', () => {
  assert.equal(notifyMessage({ event: 'done' }), 'Finished');
  assert.equal(notifyMessage({ event: 'attention' }), 'Needs your input');
  assert.equal(notifyMessage({ event: 'attention', message: '  권한 필요  ' }), '권한 필요');
});

test('Claude hook settings: Stop, StopFailure, Notification, UserPromptSubmit — async, so Claude never waits', () => {
  const s = claudeHookSettings(HOOK_COMMAND);
  assert.deepEqual(Object.keys(s.hooks).sort(), ['Notification', 'Stop', 'StopFailure', 'UserPromptSubmit']);
  for (const ev of Object.keys(s.hooks)) {
    assert.deepEqual(s.hooks[ev], [{ hooks: [{ type: 'command', command: 'cli-launcher notify --from-hook', timeout: 10, async: true }] }]);
  }
});

// ---- the CLI against a real pipe server ----

async function withServer(fn: (env: Record<string, string>, calls: any[]) => Promise<void>) {
  const calls: any[] = [];
  const panels = new Map<any, any>([[1, { agent: 'claude', sessionId: 'abc', cwd: os.tmpdir(), title: 'T', state: 'running' }]]);
  const ops = lib.createSessionOps({
    getPanels: () => panels.entries(),
    scheme: 'vscodium',
    extensionId: 'rockuen.cli-launcher-for-claude',
    notify: (entry: any, ev: any) => { calls.push(ev); return planAgentNotify(ev, { state: entry.state, alive: true }); },
  });
  const ipcPath = lib.makeIpcPath();
  const nonce = lib.newNonce();
  const server = lib.createAgentCliServer({ ipcPath, nonce, handlers: ops });
  await server.listen();
  try {
    await fn(lib.buildAgentCliEnv({ ipcPath, nonce, tabId: 1, agent: 'claude', cwd: os.tmpdir(), scheme: 'vscodium' }, {}), calls);
  } finally {
    server.close();
  }
}

async function run(argv: string[], env: Record<string, string | undefined>, stdin?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await cli.main(argv, env, {
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    readStdin: async () => stdin || '',
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('cli-launcher notify: event, message, --message-env, validation', async () => {
  await withServer(async (env, calls) => {
    const r = await run(['notify', '--event', 'done', '빌드', '끝'], env);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(calls[0], { event: 'done', message: '빌드 끝', kind: null, source: 'cli', t: null });
    await run(['notify', 'need', 'you'], env);
    assert.equal(calls[1].event, 'attention', 'attention is the default');
    await run(['notify', '--message-env'], { ...env, CLI_LAUNCHER_MESSAGE: 'R&D 100% 완료' });
    assert.equal(calls[2].message, 'R&D 100% 완료');
    assert.equal((await run(['notify', '--event', 'loud'], env)).code, 2);
    assert.equal((await run(['notify', '--event', 'busy'], env)).code, 2, 'busy comes from hooks only');
    // --help prints usage and notifies no one (agents try it first)
    for (const h of ['--help', '-h']) {
      const help = await run(['notify', h], env);
      assert.equal(help.code, 0);
      assert.match(help.out, /notify --from-hook/);
    }
    assert.equal(calls.length, 3);
  });
});

test('cli-launcher notify --from-hook: maps the hook JSON, prints nothing, exits 0', async () => {
  await withServer(async (env, calls) => {
    const stop = await run(['notify', '--from-hook'], env, JSON.stringify({ hook_event_name: 'Stop', session_id: 's' }));
    assert.deepEqual([stop.code, stop.out, stop.err], [0, '', '']);
    // t = when the hook process started (orders hooks that arrive out of order)
    assert.ok(Number.isFinite(calls[0].t) && Math.abs(calls[0].t - Date.now()) < 10 * 60 * 1000);
    assert.deepEqual({ ...calls[0], t: 0 }, { event: 'done', message: '', kind: null, source: 'hook', t: 0 });
    await run(['notify', '--from-hook'], env, JSON.stringify({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' }));
    assert.deepEqual({ ...calls[1], t: 0 }, { event: 'attention', message: 'Claude needs your permission to use Bash', kind: 'permission_prompt', source: 'hook', t: 0 });
    // Ignored and malformed input: nothing sent, still silent and 0
    for (const stdin of [JSON.stringify({ hook_event_name: 'PreToolUse' }), 'not json', '']) {
      const r = await run(['notify', '--from-hook'], env, stdin);
      assert.deepEqual([r.code, r.out, r.err], [0, '', ''], stdin);
    }
    assert.equal(calls.length, 2);
  });
  // Outside a launcher tab, or with the launcher gone: still silent and 0
  const outside = await run(['notify', '--from-hook'], {}, JSON.stringify({ hook_event_name: 'Stop' }));
  assert.deepEqual([outside.code, outside.out, outside.err], [0, '', '']);
});

test('the real hook path: the sh shim reads stdin the way Claude Code pipes it', { skip: require('node:child_process').spawnSync('sh', ['-c', 'exit 0']).status !== 0 && 'no sh' }, async () => {
  await withServer(async (env, calls) => {
    const { spawn } = require('node:child_process');
    const binDir = path.join(ROOT, 'bin', 'path');
    const code: number = await new Promise((resolve) => {
      const child = spawn('sh', ['-c', HOOK_COMMAND], {
        env: { ...process.env, ...env, ...lib.prependPath(process.env as any, binDir), [lib.ENV.NODE]: process.execPath },
      });
      child.stdin.end(JSON.stringify({ hook_event_name: 'Stop', session_id: 's' }));
      child.on('close', resolve);
    });
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual({ ...calls[0], t: 0 }, { event: 'done', message: '', kind: null, source: 'hook', t: 0 });
  });
});

// ---- desktop toast text ----

test('desktop toast: a tab title keeps its old character set, an agent message keeps punctuation', () => {
  const { _test } = require(path.join(ROOT, 'src/handlers/desktopNotification'));
  assert.equal(_test.cleanTitle("tab 'x' (1)"), 'tab x 1');
  assert.equal(_test.cleanBody("Claude needs your permission: 'Bash'\nnow"), "Claude needs your permission: 'Bash' now");
  assert.equal(_test.cleanBody('x'.repeat(500)).length, 200);
});

test('desktop toast: agent text never lands inside the PowerShell / AppleScript source', { skip: !['win32', 'darwin'].includes(process.platform) && 'toasts are Windows/macOS only' }, () => {
  const cp = require('node:child_process');
  const orig = cp.execFile;
  const calls: any[] = [];
  cp.execFile = (file: string, args: string[], opts: any) => { calls.push({ file, args, opts }); return { on() {} }; };
  try {
    const modPath = path.join(ROOT, 'src/handlers/desktopNotification.js');
    delete require.cache[require.resolve(modPath)];
    const { showDesktopNotification } = require(modPath);
    // PowerShell ends a single-quoted string at ’ too; $() and backticks are its expansions
    const evil = "x’; New-Item pwned; ’ $(whoami) `n 'q'";
    showDesktopNotification('tab', evil);
    assert.equal(calls.length, 1);
    const { args, opts } = calls[0];
    const source = args.join(' ');
    if (process.platform === 'win32') {
      assert.ok(!source.includes('pwned') && !source.includes('whoami'), 'body is not in the script');
      assert.match(source, /\$env:CLI_LAUNCHER_TOAST_BODY/);
      assert.equal(opts.env.CLI_LAUNCHER_TOAST_BODY, evil.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim());
      assert.equal(opts.env.CLI_LAUNCHER_TOAST_TITLE, 'tab');
    } else {
      // osascript: script lines first, then the text as argv
      const scriptLines = args.filter((_: string, i: number) => args[i - 1] === '-e');
      assert.ok(scriptLines.every((l: string) => !l.includes('pwned')));
      assert.deepEqual(args.slice(-2), ['tab', evil.trim()]);
    }
  } finally {
    cp.execFile = orig;
  }
});

// ---- wiring guards ----

test('Claude tabs get the hook settings; tmux tabs and the setting can turn them off', () => {
  const createPanel = read('src/panel/createPanel.js');
  assert.match(createPanel, /\.\.\.claudeHookArgs\(\{ enabled: backend !== 'multiplexer' \}\)\]/);
  assert.match(read('src/panel/restartPty.js'), /\.\.\.claudeHookArgs\(\)\]/);
  const pkg = JSON.parse(read('package.json'));
  const conf = pkg.contributes.configuration;
  const props = Array.isArray(conf) ? Object.assign({}, ...conf.map((b: any) => b.properties || {})) : conf.properties;
  assert.equal(props['claudeCodeLauncher.agentCli.claudeHooks'].default, true);
});

test('a tab that heard from its hooks stops guessing the turn end (quiet only turns the icon idle)', () => {
  const createPanel = read('src/panel/createPanel.js');
  // Before the guess announces a finished turn, a hook tab settles silently:
  // 'waiting' (Esc interrupts fire no Stop), no needs-attention, no toast
  const start = createPanel.indexOf('if (entry._hookSignals) {');
  const end = createPanel.indexOf('const runningDuration = Date.now() - entry.runningStartedAt;');
  assert.ok(start > 0 && start < end);
  const block = createPanel.slice(start, createPanel.indexOf('return;', start));
  assert.match(block, /entry\.state = 'waiting';/);
  assert.doesNotMatch(block, /needs-attention|showDesktopNotification/);
  // Only a hook signal switches the guess off (a manual notify does not)
  assert.match(createPanel, /if \(ev\.source === 'hook'\) entry\._hookSignals = true;/);
  // Restarted tabs: same rule
  assert.match(read('src/panel/restartPty.js'), /if \(panel\.active \|\| entry\._hookSignals\) \{/);
});

test('a Stop is pending until the next quiet moment; output that keeps flowing cancels it', () => {
  const createPanel = read('src/panel/createPanel.js');
  // Stop → pending + a settle timer in case no output follows
  assert.match(createPanel, /entry\._pendingDone = \{ ev, at: Date\.now\(\) \};\s*if \(entry\.idleTimer\) clearTimeout\(entry\.idleTimer\);\s*entry\.idleTimer = setTimeout\(settleHookTab, IDLE_DELAY_MS\);/);
  // Every output chunk runs the pending check
  assert.match(createPanel, /if \(entry\._pendingDone\) entry\._pendingDone = pendingAfterOutput\(entry\._pendingDone, outAt\);/);
  // The quiet confirms it, before anything else in onOutputSettled
  const settled = createPanel.indexOf('function onOutputSettled()');
  const confirm = createPanel.indexOf('if (entry._pendingDone) { settleHookTab(); return; }', settled);
  assert.ok(confirm > settled && confirm < createPanel.indexOf('detectPromptAffordance', settled));
  // Restarted tabs confirm through the same function
  assert.match(read('src/panel/restartPty.js'), /if \(entry\._pendingDone && entry\._settleHookTab\) \{ entry\._settleHookTab\(\); return; \}/);
});

test("an agent-set flag survives Claude's redraws; focus or a new turn clears it — a detector flag does not stick", () => {
  const createPanel = read('src/panel/createPanel.js');
  // Only the agent's own flag holds the tab (the detector's flag must let
  // Claude's work after the answer move the tab back to running)
  assert.match(createPanel, /const hookFlagged = entry\._hookSignals && entry\._agentFlagged && entry\.state === 'needs-attention';/);
  assert.match(createPanel, /if \(!grokTurnComplete && !hookFlagged && entry\.state !== 'running'/);
  assert.match(createPanel, /Date\.now\(\) - \(entry\._lastOutputAt \|\| 0\) > HOOK_OUTPUT_LIVE_MS/);
  const detector = createPanel.indexOf("const sig = affordance.kind + '|' + affordance.marker;");
  assert.ok(createPanel.indexOf('entry._agentFlagged = false;', detector) < createPanel.indexOf('if (isNewPrompt) {', detector));
  // Focus clears it
  assert.match(createPanel, /if \(e\.webviewPanel\.active && entry\.state === 'needs-attention'\) \{\s*entry\._agentFlagged = false;/);
  // UserPromptSubmit (busy) starts a new turn: forgets announcement, flag, dedup; a stale busy is dropped
  assert.match(createPanel, /if \(isStaleBusy\(ev\.t, entry\._lastTurnEndT\) \|\| isStaleBusy\(ev\.t, pendingT\)\)/);
  assert.match(createPanel, /entry\._turnAnnounced = false;\s*entry\._agentFlagged = false;\s*entry\._lastPromptToastAt = 0;\s*entry\._lastHookPromptAt = 0;/);
  // …and a busy that no output follows (Esc right away) settles instead of sticking in running
  assert.match(createPanel, /entry\.idleTimer = setTimeout\(settleIfQuiet, IDLE_DELAY_MS\);/);
  // Only turn ends announce the turn
  assert.match(createPanel, /if \(endsTurn\(ev\)\) \{\s*entry\._turnAnnounced = true;/);
  const restart = read('src/panel/restartPty.js');
  assert.match(restart, /if \(!grokTurnComplete && !hookFlagged && entry\.state !== 'running'/);
  assert.match(restart, /if \(entry\._hookSignals && entry\._agentFlagged && entry\.state === 'needs-attention'\) return;/);
});

test('toasts are deduped both ways and a restart forgets the hooks', () => {
  const createPanel = read('src/panel/createPanel.js');
  // Detector toasted this prompt → the hook's permission Notification stays quiet
  assert.match(createPanel, /if \(toast && PROMPT_KINDS\.has\(ev\.kind\) && isDuplicate\(entry\._lastPromptToastAt, now\)\) toast = false;/);
  // Hook spoke first → the detector stays quiet
  assert.match(createPanel, /const agentJustSaid = isDuplicate\(entry\._lastHookPromptAt, Date\.now\(\)\);/);
  assert.match(createPanel, /entry\._lastPromptToastAt = Date\.now\(\);/);
  // The guess toasted this turn end (a tab's first) → the Stop stays quiet
  assert.match(createPanel, /if \(toast && ev\.event === 'done' && isDuplicate\(entry\._lastGuessToastAt, now\)\) toast = false;/);
  assert.match(createPanel, /entry\._lastGuessToastAt = Date\.now\(\);/);
  // Restart: the new process proves its hooks afresh
  assert.match(read('src/panel/restartPty.js'), /entry\._hookSignals = false;\s*entry\._pendingDone = null;\s*entry\._turnAnnounced = false;/);
});

test('glue: notify reaches the tab, and the hook settings file is kept current', () => {
  const Module = require('node:module');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agentnotify-'));
  const config: Record<string, any> = {};
  const stub = {
    workspace: { getConfiguration: () => ({ get: (k: string, d: unknown) => (k in config ? config[k] : d) }), workspaceFolders: [{ uri: { fsPath: ws } }] },
    env: { uriScheme: 'vscodium', language: 'en' },
    window: { showWarningMessage: () => undefined, showInformationMessage: () => Promise.resolve(undefined), registerUriHandler: () => ({ dispose() {} }) },
    commands: { executeCommand: () => Promise.resolve() },
  };
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (this: unknown, req: string, ...rest: unknown[]) {
    return req === 'vscode' ? 'vscode' : origResolve.call(this, req, ...rest);
  };
  require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: stub } as any;
  const modPath = path.join(ROOT, 'src/handlers/agentCli.js');
  delete require.cache[require.resolve(modPath)];
  const glue = require(modPath);
  const subs: any[] = [];
  try {
    // Not started → no hook args
    assert.deepEqual(glue.claudeHookArgs(), []);
    glue.startAgentCli({ extensionPath: ROOT, subscriptions: subs, globalStorageUri: { fsPath: path.join(ws, 'storage') } });
    const args = glue.claudeHookArgs();
    assert.equal(args[0], '--settings');
    assert.deepEqual(JSON.parse(fs.readFileSync(args[1], 'utf8')), claudeHookSettings(HOOK_COMMAND));
    // Unchanged content is not rewritten (other windows' Claude may be reading it)
    const before = fs.statSync(args[1]).mtimeMs;
    fs.utimesSync(args[1], new Date(before - 60000), new Date(before - 60000));
    const stamped = fs.statSync(args[1]).mtimeMs;
    glue.claudeHookArgs();
    assert.equal(fs.statSync(args[1]).mtimeMs, stamped);
    // A deleted or altered file is put back
    fs.rmSync(args[1]);
    assert.deepEqual(glue.claudeHookArgs(), args);
    assert.ok(fs.existsSync(args[1]));
    fs.writeFileSync(args[1], '{}');
    glue.claudeHookArgs();
    assert.deepEqual(JSON.parse(fs.readFileSync(args[1], 'utf8')), claudeHookSettings(HOOK_COMMAND));
    assert.deepEqual(glue.claudeHookArgs({ enabled: false }), [], 'tmux tabs');
    config['agentCli.claudeHooks'] = false;
    assert.deepEqual(glue.claudeHookArgs(), [], 'setting off');
    // notify → the tab's own handler
    const seen: any[] = [];
    const plan = glue._test.notifyEntry({ _agentNotify: (ev: any) => { seen.push(ev); return { attention: true, toast: true }; } }, { event: 'done' });
    assert.deepEqual(plan, { attention: true, toast: true });
    assert.deepEqual(seen, [{ event: 'done' }]);
  } finally {
    for (const s of subs) s.dispose();
    Module._resolveFilename = origResolve;
    delete require.cache['vscode'];
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
