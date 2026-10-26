// v3.26.0 — `cli-launcher`: the command agents run inside a launcher tab.
//
// Covers the protocol (env, endpoint, auth, dispatch), the session operations
// against fake panels, the real CLI against a real IPC server (in process and
// through the sh / cmd shims), the vscode glue with a stub `vscode`, and the
// wiring guards that keep every PTY spawn handing the command its environment.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

/* eslint-disable @typescript-eslint/no-var-requires */
const ROOT = process.cwd();
const lib = require(path.join(ROOT, 'src/lib/agentCli'));
const cli = require(path.join(ROOT, 'bin/cli-launcher.js'));
const { parseSessionLink } = require(path.join(ROOT, 'src/lib/sessionLink'));

const {
  ENV, PROTOCOL_VERSION, AgentCliError, makeIpcPath, prependPath, buildAgentCliEnv, stripAgentCliEnv,
  dispatch, createAgentCliServer, createSessionOps, isPinned, cleanTitle, markdownLink, newNonce,
} = lib;
const { buildSessionLink, isSafeLinkCwd } = require(path.join(ROOT, 'src/lib/sessionLink'));

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');
}

const WIN = process.platform === 'win32';
const CLAUDE_ID = '11111111-2222-3333-4444-555555555555';
// Absolute on the platform running the tests (open refuses anything else).
const VAULT = WIN ? "C:\\obsidian\\Won's 2nd Brain" : "/obsidian/Won's 2nd Brain";
const DEV_X = WIN ? 'C:\\dev\\x' : '/dev/x';
const DEV_Y = WIN ? 'C:\\dev\\y' : '/dev/y';

function fakePanels() {
  return new Map<any, any>([
    [1, { agent: 'claude', sessionId: CLAUDE_ID, cwd: VAULT, title: 'Claude Code', state: 'running', panel: { active: true } }],
    [2, { agent: 'codex', sessionId: 'placeholder-uuid', cwd: DEV_X, title: 'Codex', state: 'running', panel: { active: false } }],
    [3, { agent: 'kiro', sessionId: 'kiro-real-id', cwd: DEV_Y, title: 'Kiro', _kiroPinned: true, panel: { active: false } }],
  ]);
}

function makeOps(panels: Map<any, any>, extra: Record<string, any> = {}) {
  const calls: any[] = [];
  const ops = createSessionOps({
    getPanels: () => panels.entries(),
    scheme: 'vscodium',
    extensionId: 'rockuen.cli-launcher-for-claude',
    version: '9.9.9',
    titleFor: (e: any) => (e.title && !/^(Claude Code|Codex|Kiro)$/.test(e.title) ? e.title : null),
    rename: (e: any, t: string, also: any) => { calls.push(['rename', t, also && also.sessionId]); e.title = t; },
    openLink: (l: any, caller: any) => { calls.push(['open', l, caller && caller.agent]); return 'confirm'; },
    ...extra,
  });
  return { ops, calls };
}

// ---- environment + endpoint ----

test('prependPath puts the bin dir first on every PATH spelling (Windows is case-insensitive)', () => {
  const out = prependPath({ Path: 'C:\\a;C:\\b', HOME: 'x' }, 'C:\\ext\\bin\\path', 'win32');
  assert.deepEqual(out, { Path: 'C:\\ext\\bin\\path;C:\\a;C:\\b' });
  // Both spellings present (spread copies can carry two) — both updated
  const both = prependPath({ Path: 'C:\\a', PATH: 'C:\\b' }, 'C:\\d', 'win32');
  assert.deepEqual(both, { Path: 'C:\\d;C:\\a', PATH: 'C:\\d;C:\\b' });
  // Already present (any case) — unchanged
  assert.deepEqual(prependPath({ Path: 'C:\\A;C:\\d' }, 'c:\\d', 'win32'), { Path: 'C:\\A;C:\\d' });
  // POSIX: exact key, ':' delimiter, missing PATH created
  assert.deepEqual(prependPath({ PATH: '/usr/bin' }, '/ext/bin/path', 'darwin'), { PATH: '/ext/bin/path:/usr/bin' });
  assert.deepEqual(prependPath({}, '/ext', 'linux'), { PATH: '/ext' });
});

test('buildAgentCliEnv hands the tab its endpoint, nonce, id, agent, cwd, scheme and runtime', () => {
  const env = buildAgentCliEnv({
    ipcPath: '\\\\.\\pipe\\cli-launcher-1-ab', nonce: 'n0', tabId: 7, agent: 'codex', cwd: VAULT,
    scheme: 'vscodium', nodeRuntime: 'C:\\VSCodium\\VSCodium.exe', binDir: 'C:\\ext\\bin\\path', platform: 'win32',
  }, { Path: 'C:\\Windows' });
  assert.equal(env[ENV.IPC], '\\\\.\\pipe\\cli-launcher-1-ab');
  assert.equal(env[ENV.NONCE], 'n0');
  assert.equal(env[ENV.TAB], '7');
  assert.equal(env[ENV.AGENT], 'codex');
  assert.equal(env[ENV.CWD], VAULT);
  assert.equal(env[ENV.SCHEME], 'vscodium');
  assert.equal(env[ENV.NODE], 'C:\\VSCodium\\VSCodium.exe');
  assert.equal(env.Path, 'C:\\ext\\bin\\path;C:\\Windows');
});

test('env names avoid the words Codex strips from shell tool environments', () => {
  for (const name of Object.values(ENV) as string[]) {
    assert.doesNotMatch(name, /KEY|SECRET|TOKEN/i, name);
  }
  // A short nonce: the transcript secret scanners flag long hex runs
  const n = newNonce();
  assert.match(n, /^[0-9a-f]{24}$/);
});

test('makeIpcPath: a named pipe on Windows, a per-user socket elsewhere', () => {
  assert.equal(makeIpcPath({ platform: 'win32', pid: 12, rand: 'ab' }), '\\\\.\\pipe\\cli-launcher-12-ab');
  const sock = makeIpcPath({ platform: 'linux', pid: 12, rand: 'ab', tmpdir: '/tmp' });
  assert.match(sock.replace(/\\/g, '/'), /^\/tmp\/cli-launcher-[^/]+\/12-ab\.sock$/);
  // macOS caps unix socket paths at 104 bytes
  assert.ok(makeIpcPath({ platform: 'darwin', tmpdir: '/var/folders/ab/cdefghijklmnopqrstuvwxyz012345/T' }).length < 104);
});

// ---- dispatch ----

test('dispatch authenticates, checks the protocol and routes', async () => {
  const handlers = {
    ok: () => 42,
    typed: () => { throw new AgentCliError('no-tab', 'gone'); },
    boom: () => { throw new Error('kaput'); },
  };
  assert.deepEqual(await dispatch({ v: PROTOCOL_VERSION, nonce: 'n', op: 'ok' }, 'n', handlers), { ok: true, result: 42 });
  assert.equal((await dispatch({ v: PROTOCOL_VERSION, nonce: 'x', op: 'ok' }, 'n', handlers)).code, 'unauthorized');
  assert.equal((await dispatch({ v: PROTOCOL_VERSION, op: 'ok' }, 'n', handlers)).code, 'unauthorized');
  assert.equal((await dispatch({ v: 999, nonce: 'n', op: 'ok' }, 'n', handlers)).code, 'version');
  assert.equal((await dispatch({ v: PROTOCOL_VERSION, nonce: 'n', op: 'nope' }, 'n', handlers)).code, 'unknown-op');
  // Prototype keys are not ops
  assert.equal((await dispatch({ v: PROTOCOL_VERSION, nonce: 'n', op: 'constructor' }, 'n', handlers)).code, 'unknown-op');
  assert.deepEqual(await dispatch({ v: PROTOCOL_VERSION, nonce: 'n', op: 'typed' }, 'n', handlers), { ok: false, code: 'no-tab', error: 'gone' });
  assert.equal((await dispatch({ v: PROTOCOL_VERSION, nonce: 'n', op: 'boom' }, 'n', handlers)).code, 'internal');
  assert.equal((await dispatch(null, 'n', handlers)).code, 'bad-request');
});

// ---- session operations ----

test('session: Claude tab → resume link for its own session, with cwd and title', () => {
  const panels = fakePanels();
  panels.get(1).title = '버스트 링크 작업';
  const { ops } = makeOps(panels);
  const info = ops.session({ tab: '1', hints: {} });
  assert.equal(info.agent, 'claude');
  assert.equal(info.sessionId, CLAUDE_ID);
  assert.equal(info.source, 'launcher');
  assert.equal(info.title, '버스트 링크 작업');
  assert.deepEqual(parseSessionLink(info.link), { sessionId: CLAUDE_ID, agent: 'claude', cwd: VAULT, title: '버스트 링크 작업' });
  assert.ok(info.link.startsWith('vscodium://rockuen.cli-launcher-for-claude/resume?'));
  assert.equal(info.markdown, `[버스트 링크 작업](${info.link})`);
});

test('session: a --title override wins and is cleaned', () => {
  const { ops } = makeOps(fakePanels());
  const info = ops.session({ tab: 1, args: { title: '  line1\nline2\t ' } });
  assert.equal(info.title, 'line1 line2');
  assert.equal(parseSessionLink(info.link).title, 'line1 line2');
});

test("session: Claude Code's own session id (follows /clear) beats the launcher's copy — Claude tabs only", () => {
  const { ops } = makeOps(fakePanels());
  const hinted = ops.session({ tab: 1, hints: { claudeSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } });
  assert.equal(hinted.sessionId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(hinted.source, 'agent');
  // An invalid hint is ignored
  assert.equal(ops.session({ tab: 1, hints: { claudeSessionId: '../etc' } }).sessionId, CLAUDE_ID);
  // A Kiro tab ignores a Claude hint (Claude run nested in another agent's tab)
  assert.equal(ops.session({ tab: 3, hints: { claudeSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } }).sessionId, 'kiro-real-id');
});

test('session: an agent that has not written its transcript yet is pending, not a broken link', () => {
  const { ops } = makeOps(fakePanels());
  assert.throws(() => ops.session({ tab: 2 }), (e: any) => e.code === 'session-pending' && /codex/.test(e.message));
});

test('session: discovery runs on demand, so a just-written session links right away', () => {
  const panels = fakePanels();
  const codex = panels.get(2);
  let ran = 0;
  codex._resolveSessionPath = () => {
    ran++;
    codex.sessionId = '019a0000-1111-7222-8333-444444444444';
    codex._codexPinned = true;
  };
  const { ops } = makeOps(panels);
  const info = ops.session({ tab: 2 });
  assert.equal(ran, 1);
  assert.equal(info.sessionId, '019a0000-1111-7222-8333-444444444444');
  assert.equal(parseSessionLink(info.link).agent, 'codex');
  // Pinned now — discovery is not re-run
  ops.session({ tab: 2 });
  assert.equal(ran, 1);
});

test('isPinned per agent', () => {
  assert.equal(isPinned({ agent: 'claude' }), true);
  assert.equal(isPinned({ agent: 'chief' }), true);
  assert.equal(isPinned({}), true);
  assert.equal(isPinned({ agent: 'codex' }), false);
  assert.equal(isPinned({ agent: 'codex', isCodexResume: true }), true);
  assert.equal(isPinned({ agent: 'kiro', _kiroPinned: true }), true);
  assert.equal(isPinned({ agent: 'grok', _grokPinned: true }), true);
  assert.equal(isPinned({ agent: 'gjc' }), false);
  assert.equal(isPinned({ agent: 'antigravity' }), false);
  assert.equal(isPinned({ agent: 'antigravity', isAntigravityResume: true }), true);
});

test('session: a closed tab is an error', () => {
  const { ops } = makeOps(fakePanels());
  assert.throws(() => ops.session({ tab: 99 }), (e: any) => e.code === 'no-tab');
});

test('rename: renames the tab and returns a link carrying the new title', () => {
  const panels = fakePanels();
  const { ops, calls } = makeOps(panels);
  const info = ops.rename({ tab: 1, args: { title: ' 새 이름\n ' } });
  assert.deepEqual(calls, [['rename', '새 이름', null]]);
  assert.equal(panels.get(1).title, '새 이름');
  assert.equal(parseSessionLink(info.link).title, '새 이름');
  assert.throws(() => ops.rename({ tab: 1, args: { title: ' \n ' } }), (e: any) => e.code === 'bad-args');
  // Pending tabs can still be renamed (no link yet)
  const pending = ops.rename({ tab: 2, args: { title: 'codex 작업' } });
  assert.equal(pending.pending, true);
  assert.equal(pending.link, null);
});

test("rename after /clear hands the glue Claude's live session id too (Claude tabs only)", () => {
  const { ops, calls } = makeOps(fakePanels());
  const live = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const info = ops.rename({ tab: 1, args: { title: 'x' }, hints: { claudeSessionId: live } });
  assert.deepEqual(calls[0], ['rename', 'x', live]);
  assert.equal(info.sessionId, live);
  ops.rename({ tab: 3, args: { title: 'y' }, hints: { claudeSessionId: live } });
  assert.deepEqual(calls[1], ['rename', 'y', null]);
});

test('tabs: every open tab, marking the caller and the pending ones', () => {
  const { ops } = makeOps(fakePanels());
  const rows = ops.tabs({ tab: '3', hints: {} });
  assert.deepEqual(rows.map((r: any) => [r.tab, r.agent, r.self, !!r.link, !!r.pending, r.active]), [
    ['1', 'claude', false, true, false, true],
    ['2', 'codex', false, false, true, false],
    ['3', 'kiro', true, true, false, false],
  ]);
});

test("tabs runs discovery for the caller's tab only (it scans on the terminal thread)", () => {
  const panels = fakePanels();
  let scans = 0;
  panels.get(2)._resolveSessionPath = () => { scans++; };
  const { ops } = makeOps(panels);
  ops.tabs({ tab: '1' });
  assert.equal(scans, 0);
  ops.tabs({ tab: '2' });
  assert.equal(scans, 1);
});

test('open: a session link, or a bare id that borrows the caller tab agent and cwd', async () => {
  const { ops, calls } = makeOps(fakePanels());
  const link = buildSessionLink({ scheme: 'vscodium', sessionId: 'abc-1', agent: 'codex', cwd: DEV_X });
  assert.deepEqual(await ops.open({ tab: 1, args: { link } }), { status: 'confirm', agent: 'codex', sessionId: 'abc-1', cwd: DEV_X });
  assert.equal(calls[0][2], 'claude', 'the caller tab is passed along for the confirmation prompt');
  await ops.open({ tab: 3, args: { session: 'other-id' } });
  assert.deepEqual(calls[1][1], { sessionId: 'other-id', agent: 'kiro', cwd: DEV_Y, title: null });
  await ops.open({ tab: 3, args: { session: 'x-2', agent: 'gjc', cwd: DEV_X } });
  assert.deepEqual(calls[2][1], { sessionId: 'x-2', agent: 'gjc', cwd: DEV_X, title: null });
  await assert.rejects(ops.open({ tab: 1, args: { link: 'https://example.com/x' } }), (e: any) => e.code === 'bad-args');
  await assert.rejects(ops.open({ tab: 1, args: { session: '../../etc/passwd' } }), (e: any) => e.code === 'bad-args');
  // An unknown agent is an error, not a silent fallback to the caller's
  await assert.rejects(ops.open({ tab: 1, args: { session: 'x', agent: 'emacs' } }), (e: any) => e.code === 'bad-args');
  assert.equal(calls.length, 3);
});

test('open refuses a folder that is not a local absolute path (UNC would leak NTLM credentials)', async () => {
  const { ops, calls } = makeOps(fakePanels());
  for (const cwd of ['\\\\attacker\\share', '//attacker/share', '.', 'relative\\dir', 'C:\\a\u0000b']) {
    await assert.rejects(ops.open({ tab: 1, args: { session: 'abc', cwd } }), (e: any) => e.code === 'bad-args', cwd);
    const link = buildSessionLink({ scheme: 'vscode', sessionId: 'abc', cwd });
    await assert.rejects(ops.open({ tab: 1, args: { link } }), (e: any) => e.code === 'bad-args', `link ${cwd}`);
  }
  assert.equal(calls.length, 0);
});

test('isSafeLinkCwd: local absolute paths only', () => {
  assert.equal(isSafeLinkCwd(null, 'win32'), true);
  assert.equal(isSafeLinkCwd('', 'linux'), true);
  assert.equal(isSafeLinkCwd('C:\\dev\\x', 'win32'), true);
  assert.equal(isSafeLinkCwd('c:/dev/x', 'win32'), true);
  assert.equal(isSafeLinkCwd('\\\\host\\share', 'win32'), false);
  assert.equal(isSafeLinkCwd('\\\\?\\C:\\x', 'win32'), false);
  assert.equal(isSafeLinkCwd('//host/share', 'win32'), false);
  assert.equal(isSafeLinkCwd('/dev/x', 'win32'), false);
  assert.equal(isSafeLinkCwd('dev\\x', 'win32'), false);
  assert.equal(isSafeLinkCwd('/Users/me/dev', 'darwin'), true);
  assert.equal(isSafeLinkCwd('//host/share', 'darwin'), false);
  assert.equal(isSafeLinkCwd('C:\\dev', 'darwin'), false);
  assert.equal(isSafeLinkCwd('/a\nb', 'linux'), false);
});

test('session links encode ( ) and quotes, so a title cannot end a Markdown link early', () => {
  const link = buildSessionLink({ scheme: 'vscodium', sessionId: 'abc', cwd: VAULT, title: "1) 정리 (초안) it's" });
  assert.doesNotMatch(link, /[()'!*]/);
  assert.deepEqual(parseSessionLink(link), { sessionId: 'abc', agent: 'claude', cwd: VAULT, title: "1) 정리 (초안) it's" });
  const md = markdownLink('1) 정리', link);
  const target = md.slice(md.indexOf('](') + 2);
  assert.equal(target.indexOf(')'), target.length - 1, 'the only ) in the target closes the Markdown link');
});

test('cleanTitle / markdownLink', () => {
  assert.equal(cleanTitle('a\u0000b\u001bc'), 'a b c');
  assert.equal(cleanTitle('x'.repeat(500)).length, 200);
  assert.equal(cleanTitle(42 as any), '');
  assert.equal(markdownLink('a [b] \\c', 'L'), '[a \\[b\\] \\\\c](L)');
  assert.equal(markdownLink(null, 'L'), '[session](L)');
});

test('stripAgentCliEnv drops inherited CLI_LAUNCHER_* (any case) and nothing else', () => {
  const env = { CLI_LAUNCHER_IPC: 'x', cli_launcher_tab: '1', CLI_LAUNCHERX: 'keep', PATH: '/bin' };
  assert.deepEqual(stripAgentCliEnv(env), { CLI_LAUNCHERX: 'keep', PATH: '/bin' });
});

test('the server answers a request once even when more data follows it', async () => {
  let calls = 0;
  const handlers = {
    slow: async () => { calls++; await new Promise((r) => setTimeout(r, 50)); return 'done'; },
  };
  const ipcPath = makeIpcPath();
  const server = createAgentCliServer({ ipcPath, nonce: 'n', handlers });
  await server.listen();
  try {
    const net = require('node:net');
    const reply: string = await new Promise((resolve, reject) => {
      const sock = net.connect(ipcPath);
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('connect', () => {
        sock.write(JSON.stringify({ v: PROTOCOL_VERSION, nonce: 'n', op: 'slow' }) + '\n');
        setTimeout(() => sock.write('more bytes after the newline'), 10);
      });
      sock.on('data', (d: string) => { buf += d; });
      sock.on('end', () => resolve(buf));
      sock.on('error', reject);
    });
    assert.deepEqual(JSON.parse(reply), { ok: true, result: 'done' });
    assert.equal(calls, 1);
  } finally {
    server.close();
  }
});

test('a socket directory that is a symlink is refused, not followed', { skip: WIN && 'unix sockets only' }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-sock-'));
  const target = path.join(base, 'target');
  fs.mkdirSync(target);
  const planted = path.join(base, 'planted');
  fs.symlinkSync(target, planted);
  try {
    const server = createAgentCliServer({ ipcPath: path.join(planted, 'x.sock'), nonce: 'n', handlers: {} });
    await assert.rejects(server.listen(), /not a plain directory/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('open --cwd: relative and Git Bash paths become absolute Windows paths', () => {
  assert.equal(cli.resolveCwd('/c/dev/x', 'win32'), path.resolve('C:\\dev\\x'));
  assert.equal(cli.resolveCwd('/d', 'win32'), path.resolve('D:\\'));
  assert.equal(cli.resolveCwd('.', process.platform), process.cwd());
});

// ---- the real CLI against a real server ----

async function withServer(fn: (env: Record<string, string>, panels: Map<any, any>, calls: any[]) => Promise<void>) {
  const panels = fakePanels();
  panels.get(1).title = '링크 작업';
  const { ops, calls } = makeOps(panels);
  const ipcPath = makeIpcPath();
  const nonce = newNonce();
  const server = createAgentCliServer({ ipcPath, nonce, handlers: ops });
  await server.listen();
  try {
    const env = buildAgentCliEnv({ ipcPath, nonce, tabId: 1, agent: 'claude', cwd: VAULT, scheme: 'vscodium' }, {});
    await fn(env, panels, calls);
  } finally {
    server.close();
  }
}

async function runCli(argv: string[], env: Record<string, string | undefined>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await cli.main(argv, env, { out: (s: string) => out.push(s), err: (s: string) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('CLI over IPC: link, markdown, info, rename, tabs, open', async () => {
  await withServer(async (env, panels, calls) => {
    const link = await runCli(['link'], env);
    assert.equal(link.code, 0, link.err);
    assert.deepEqual(parseSessionLink(link.out), { sessionId: CLAUDE_ID, agent: 'claude', cwd: VAULT, title: '링크 작업' });

    const md = await runCli(['link', '--markdown', '--title', '버스트 v0.74'], env);
    assert.ok(md.out.startsWith('[버스트 v0.74]('), md.out);
    assert.equal(parseSessionLink(md.out.slice(md.out.indexOf('](') + 2, -1)).title, '버스트 v0.74');

    const info = await runCli(['info'], env);
    assert.match(info.out, /^[\x00-\x7f]*$/, 'JSON output is ASCII-only (code-page safe)');
    const parsed = JSON.parse(info.out);
    assert.equal(parsed.title, '링크 작업');
    assert.equal(parsed.tab, '1');

    const renamed = await runCli(['rename', '새', '이름'], env);
    assert.equal(renamed.code, 0, renamed.err);
    assert.equal(panels.get(1).title, '새 이름');

    const tabs = await runCli(['tabs'], env);
    assert.match(tabs.out, /^\* 1\tclaude\t새 이름\tvscodium:\/\//m);
    assert.match(tabs.out, /^ {2}2\tcodex\tCodex\t\(no session id yet\)$/m);

    const opened = await runCli(['open', link.out], env);
    assert.equal(opened.code, 0, opened.err);
    assert.equal(calls[calls.length - 1][0], 'open');

    const claudeHint = await runCli(['link'], { ...env, CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    assert.equal(parseSessionLink(claudeHint.out).sessionId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });
});

test('CLI exit codes: usage 2, refused 1, outside a launcher tab 3', async () => {
  await withServer(async (env) => {
    assert.equal((await runCli([], env)).code, 2);
    assert.equal((await runCli(['bogus'], env)).code, 2);
    assert.equal((await runCli(['rename'], env)).code, 2);
    assert.equal((await runCli(['link', '--title'], env)).code, 2);
    const wrongNonce = await runCli(['link'], { ...env, [ENV.NONCE]: 'deadbeef' });
    assert.equal(wrongNonce.code, 1);
    assert.match(wrongNonce.err, /different launcher session/);
    const pending = await runCli(['link'], { ...env, [ENV.TAB]: '2' });
    assert.equal(pending.code, 1);
    assert.match(pending.err, /no session id yet/);
  });
  const outside = await runCli(['link'], {});
  assert.equal(outside.code, 3);
  assert.match(outside.err, /not running inside a CLI Launcher tab/);
  assert.equal((await runCli(['--help'], {})).code, 0);
});

test('CLI falls back to Claude Code’s own session id when the launcher is unreachable', async () => {
  const env = {
    [ENV.IPC]: process.platform === 'win32' ? '\\\\.\\pipe\\cli-launcher-test-nobody' : path.join(os.tmpdir(), 'cli-launcher-test-nobody.sock'),
    [ENV.NONCE]: 'n', [ENV.TAB]: '1', [ENV.AGENT]: 'claude', [ENV.CWD]: VAULT, [ENV.SCHEME]: 'vscodium',
    CLAUDE_CODE_SESSION_ID: CLAUDE_ID,
  };
  const r = await runCli(['link', '--title', '오프라인'], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /built the link from this shell's environment/);
  assert.deepEqual(parseSessionLink(r.out), { sessionId: CLAUDE_ID, agent: 'claude', cwd: VAULT, title: '오프라인' });
  // No fallback for other agents, or without Claude's id
  assert.equal((await runCli(['link'], { ...env, [ENV.AGENT]: 'codex' })).code, 3);
  assert.equal((await runCli(['link'], { ...env, CLAUDE_CODE_SESSION_ID: '' })).code, 3);
  // rename has no offline mode
  assert.equal((await runCli(['rename', 'x'], env)).code, 3);
});

test('--title-env reads the title from CLI_LAUNCHER_TITLE (Windows: keeps & | % off the cmd line)', async () => {
  await withServer(async (env, panels) => {
    const r = await runCli(['rename', '--title-env'], { ...env, CLI_LAUNCHER_TITLE: 'R&D | 100% 정리' });
    assert.equal(r.code, 0, r.err);
    assert.equal(panels.get(1).title, 'R&D | 100% 정리');
    const l = await runCli(['link', '--title-env'], { ...env, CLI_LAUNCHER_TITLE: 'a&b' });
    assert.equal(parseSessionLink(l.out).title, 'a&b');
    assert.equal((await runCli(['link', '--title-env'], env)).code, 2, 'empty variable is a usage error');
  });
});

test('open --link-env takes the link from CLI_LAUNCHER_LINK (every link has & for cmd to split on)', async () => {
  await withServer(async (env, _panels, calls) => {
    const link = buildSessionLink({ scheme: 'vscodium', sessionId: 'from-env', agent: 'codex', cwd: DEV_X, title: 'a&b' });
    const r = await runCli(['open', '--link-env'], { ...env, CLI_LAUNCHER_LINK: link });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(calls[calls.length - 1][1], { sessionId: 'from-env', agent: 'codex', cwd: DEV_X, title: 'a&b' });
    assert.equal((await runCli(['open', '--link-env'], env)).code, 2, 'empty variable');
    assert.equal((await runCli(['open', 'x', '--link-env'], { ...env, CLI_LAUNCHER_LINK: link })).code, 2, 'both');
  });
});

test('notificationText keeps link-supplied text from forming links or hiding a path', () => {
  const { notificationText } = require(path.join(ROOT, 'src/lib/sessionLink'));
  assert.equal(notificationText('C:\\x [Open](command:workbench.action.terminal.new)'), 'C:\\x Opencommand:workbench.action.terminal.new');
  assert.equal(notificationText('abc\u202Egpj.exe'), 'abcgpj.exe');
  assert.equal(notificationText('a\nb'), 'ab');
  assert.equal(notificationText('x'.repeat(200), 80).length, 80);
  assert.equal(notificationText(null), '');
});

test('open prints what happened: switched to an open tab, or waiting for the user', async () => {
  await withServer(async (env) => {
    const r = await runCli(['open', 'other-session', '--agent', 'codex'], env);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /confirm in the editor/);
    assert.equal((await runCli(['open', 'x', '--agent', 'emacs'], env)).code, 1);
  });
});

// ---- through the shims, as an agent's shell runs it ----

function shimEnv(env: Record<string, string>) {
  const binDir = path.join(ROOT, 'bin', 'path');
  return { ...process.env, ...env, ...prependPath(process.env as any, binDir), [ENV.NODE]: process.execPath };
}

function hasSh(): boolean {
  return spawnSync('sh', ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0;
}

test('sh shim (Git Bash / POSIX) runs the CLI with the launcher runtime', { skip: !hasSh() && 'no sh on PATH' }, async () => {
  await withServer(async (env) => {
    // Async spawn: the server lives on this event loop.
    const { spawn } = require('node:child_process');
    const result: { code: number; out: string; err: string } = await new Promise((resolve) => {
      const child = spawn('sh', ['-c', 'cli-launcher link --title "한글 제목"'], { env: shimEnv(env) });
      let out = '';
      let err = '';
      child.stdout.on('data', (d: Buffer) => { out += d; });
      child.stderr.on('data', (d: Buffer) => { err += d; });
      child.on('close', (code: number) => resolve({ code, out: out.trim(), err }));
    });
    assert.equal(result.code, 0, result.err);
    assert.equal(parseSessionLink(result.out).title, '한글 제목');
  });
});

test('sh shim passes path-like arguments through Git Bash untouched', { skip: !hasSh() && 'no sh on PATH' }, async () => {
  await withServer(async (env, panels) => {
    const { spawn } = require('node:child_process');
    const code: number = await new Promise((resolve) => {
      const child = spawn('sh', ['-c', 'cli-launcher rename /plan-result'], { env: shimEnv(env) });
      child.on('close', resolve);
    });
    assert.equal(code, 0);
    // Without MSYS_NO_PATHCONV Git Bash turned this into "C:/Program Files/Git/plan-result"
    assert.equal(panels.get(1).title, '/plan-result');
  });
});

test('cmd shim (cmd / PowerShell) passes Korean arguments and the exit code through', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  await withServer(async (env) => {
    const { spawn } = require('node:child_process');
    const run = (cmdline: string, extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string }> => new Promise((resolve) => {
      const child = spawn('cmd.exe', ['/d', '/s', '/c', cmdline], { env: { ...shimEnv(env), ...extraEnv }, windowsVerbatimArguments: true });
      let out = '';
      child.stdout.on('data', (d: Buffer) => { out += d; });
      child.on('close', (code: number) => resolve({ code, out: out.trim() }));
    });
    const ok = await run('"cli-launcher link --title 한글"');
    assert.equal(ok.code, 0);
    assert.equal(parseSessionLink(ok.out).title, '한글');
    const refused = await run('"cli-launcher link"', { [ENV.NONCE]: 'deadbeef' });
    assert.equal(refused.code, 1);
  });
});

test('shims: LF for sh, CRLF for cmd, and Git keeps them that way', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'bin/path/cli-launcher'), 'utf8');
  assert.ok(sh.startsWith('#!/bin/sh\n'));
  assert.ok(!sh.includes('\r'), 'sh shim must not contain CR');
  const cmd = fs.readFileSync(path.join(ROOT, 'bin/path/cli-launcher.cmd'), 'utf8');
  assert.ok(cmd.split('\n').slice(0, -1).every((l) => l.endsWith('\r')), 'cmd shim must be CRLF');
  assert.match(cmd, /^[\x00-\x7f]*$/, 'cmd shim must be ASCII (code page independent)');
  const attrs = read('.gitattributes');
  assert.match(attrs, /^bin\/path\/cli-launcher text eol=lf$/m);
  assert.match(attrs, /^bin\/path\/\*\.cmd text eol=crlf$/m);
  // Only the shims sit on PATH — not chief-repl.js (PATHEXT runs .js through WSH)
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'bin/path')).sort(), ['cli-launcher', 'cli-launcher.cmd']);
});

// ---- vscode glue ----

function loadGlueWithStub(opts: { enabled: boolean; workspace: string; choice?: string }) {
  const Module = require('node:module');
  const calls: any[] = [];
  const vscodeStub = {
    workspace: {
      getConfiguration: () => ({ get: (k: string, d: unknown) => (k === 'agentCli.enabled' ? opts.enabled : d) }),
      workspaceFolders: [{ uri: { fsPath: opts.workspace } }],
    },
    env: { uriScheme: 'vscodium', language: 'en', appRoot: '' },
    window: {
      showWarningMessage: (m: string) => { calls.push(['warn', m]); },
      showInformationMessage: (m: string, ...items: string[]) => {
        calls.push(['info', m, items]);
        return Promise.resolve(opts.choice);
      },
      registerUriHandler: () => ({ dispose() {} }),
    },
    commands: { executeCommand: (...a: unknown[]) => { calls.push(['exec', ...a]); return Promise.resolve(); } },
  };
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (this: unknown, req: string, ...rest: unknown[]) {
    return req === 'vscode' ? 'vscode' : origResolve.call(this, req, ...rest);
  };
  require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeStub } as any;
  for (const rel of ['src/handlers/agentCli.js', 'src/uri/sessionUriHandler.js']) {
    delete require.cache[require.resolve(path.join(ROOT, rel))];
  }
  return {
    mod: require(path.join(ROOT, 'src/handlers/agentCli.js')),
    uri: require(path.join(ROOT, 'src/uri/sessionUriHandler.js')),
    state: require(path.join(ROOT, 'src/state.js')),
    calls,
  };
}

test('glue: link titles prefer a user-given tab name, then the Sessions view title', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-ws-'));
  fs.mkdirSync(path.join(ws, '.claude-launcher'));
  fs.writeFileSync(path.join(ws, '.claude-launcher', 'sessions.json'), JSON.stringify({
    claudeSessionTitles: { [CLAUDE_ID]: '사이드바 제목' },
    codexSessionTitles: { 'cx-1': '코덱스 제목' },
  }));
  try {
    const { mod } = loadGlueWithStub({ enabled: true, workspace: ws });
    const { titleFor } = mod._test;
    assert.equal(titleFor({ agent: 'claude', title: '내가 지은 이름', cwd: ws }, CLAUDE_ID), '내가 지은 이름');
    assert.equal(titleFor({ agent: 'claude', title: 'Claude Code (2)', cwd: ws }, CLAUDE_ID), '사이드바 제목');
    assert.equal(titleFor({ agent: 'codex', title: 'Codex', cwd: ws }, 'cx-1'), '코덱스 제목');
    assert.equal(titleFor({ agent: 'claude', title: 'Claude Code', cwd: ws }, 'unknown-id'), null);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('glue: disabled setting → no server and no environment', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-ws-'));
  try {
    const { mod } = loadGlueWithStub({ enabled: false, workspace: ws });
    const subs: any[] = [];
    assert.equal(mod.startAgentCli({ extensionPath: ROOT, subscriptions: subs }), null);
    // No variables added, and ones inherited from elsewhere are dropped
    const env = { PATH: '/bin', CLI_LAUNCHER_IPC: 'other-window', CLI_LAUNCHER_TAB: '9' };
    assert.deepEqual(mod.applyAgentCliEnv(env, { tabId: 1, agent: 'claude', cwd: ws }), { PATH: '/bin' });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('glue: enabled → a listening server and per-tab environment', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-ws-'));
  const subs: any[] = [];
  try {
    const { mod } = loadGlueWithStub({ enabled: true, workspace: ws });
    const running = mod.startAgentCli({ extensionPath: ROOT, subscriptions: subs, extension: { id: 'rockuen.cli-launcher-for-claude', packageJSON: { version: '3.26.0' } } });
    assert.ok(running);
    const env = mod.applyAgentCliEnv({ PATH: '/bin', CLI_LAUNCHER_TAB: '9' }, { tabId: 5, agent: 'gjc', cwd: ws });
    assert.equal(env[ENV.TAB], '5');
    assert.equal(env[ENV.AGENT], 'gjc');
    assert.equal(env[ENV.SCHEME], 'vscodium');
    assert.equal(env[ENV.NODE], process.execPath);
    // A multiplexer tab gets nothing (the server's environment would win)
    const mux = mod.applyAgentCliEnv({ PATH: '/bin' }, { tabId: 6, agent: 'claude', cwd: ws, enabled: false });
    assert.deepEqual(mux, { PATH: '/bin' });
    // The endpoint answers (tab 5 does not exist in the real state → no-tab)
    await new Promise((r) => setTimeout(r, 100));
    const reply = await lib.sendRequest({ ipcPath: env[ENV.IPC], nonce: env[ENV.NONCE], tab: '5', op: 'ping' });
    assert.equal(reply.ok, true);
    assert.equal(reply.result.version, '3.26.0');
    const gone = await lib.sendRequest({ ipcPath: env[ENV.IPC], nonce: env[ENV.NONCE], tab: '5', op: 'session' });
    assert.equal(gone.code, 'no-tab');
  } finally {
    for (const s of subs) s.dispose();
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('glue: an agent asking to open a session waits for the user; an open tab is just focused', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-ws-'));
  const subs: any[] = [];
  try {
    const { mod, state, calls } = loadGlueWithStub({ enabled: true, workspace: ws, choice: 'Open' });
    state.panels.clear();
    state.panels.set(1, { agent: 'claude', sessionId: CLAUDE_ID, cwd: ws, title: '[x](command:evil) 탭', panel: { reveal() { calls.push(['reveal']); } } });
    const running = mod.startAgentCli({ extensionPath: ROOT, subscriptions: subs });
    await new Promise((r) => setTimeout(r, 100));
    const ask = (args: any) => lib.sendRequest({ ipcPath: running.ipcPath, nonce: running.nonce, tab: '1', op: 'open', args });

    const revealed = await ask({ session: CLAUDE_ID });
    assert.equal(revealed.result.status, 'revealed');
    assert.deepEqual(calls, [['reveal']]);

    const asked = await ask({ session: 'other-session', cwd: ws });
    assert.equal(asked.result.status, 'confirm');
    const prompt = calls.find((c) => c[0] === 'info');
    assert.ok(prompt, 'a confirmation notification was shown');
    assert.deepEqual(prompt[2], ['Open']);
    assert.doesNotMatch(prompt[1], /\[|\]|\(|\)/, 'agent-supplied text cannot form a notification link');
    await new Promise((r) => setTimeout(r, 20));
    // Clicking Open resumes through the deep-link path (cwd is this workspace → here)
    assert.ok(calls.some((c) => c[0] === 'exec' && c[1] === 'claudeCodeLauncher.resumeSession' && c[2] === 'other-session'));
  } finally {
    for (const s of subs) s.dispose();
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('deep links (URI or IPC) with a UNC / relative folder are refused before the path is touched', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-ws-'));
  try {
    const { uri, calls } = loadGlueWithStub({ enabled: true, workspace: ws });
    for (const cwd of ['\\\\attacker\\share', '//attacker/share', 'relative [Open](command:evil)']) {
      assert.equal(uri.handleLink({}, { sessionId: 'abc', agent: 'claude', cwd, title: null }), 'rejected', cwd);
    }
    const warnings = calls.filter((c) => c[0] === 'warn');
    assert.equal(warnings.length, 3);
    // No [ ] means no [text](target) link in the notification
    for (const w of warnings) assert.doesNotMatch(w[1], /\[|\]/, 'the link text cannot form a notification link');
    assert.ok(!calls.some((c) => c[0] === 'exec'));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ---- wiring guards ----

test('every PTY spawn gets the agent CLI environment (multiplexer tabs excluded)', () => {
  const createPanel = read('src/panel/createPanel.js');
  assert.match(createPanel, /applyAgentCliEnv\(sessionEnv, \{ tabId, agent, cwd, enabled: backend !== 'multiplexer' \}\);/);
  assert.match(createPanel, /entry\._resolveSessionPath = resolvePath;/);
  // A tmux server started inside a tab carries that tab's identity — unset it for new mux sessions
  assert.match(createPanel, /'env -u CLI_LAUNCHER_IPC -u CLI_LAUNCHER_NONCE -u CLI_LAUNCHER_TAB '/);
  assert.match(createPanel, /const claudeCmdString = unsetAgentCli \+ \[shell, \.\.\.args\]/);
  const restart = read('src/panel/restartPty.js');
  assert.match(restart, /applyAgentCliEnv\(sessionEnv, \{ tabId: entry\.tabId, agent, cwd: entry\.cwd \}\);/);
  // The env is built after the agent's own extraEnv (Codex prepends PATH there)
  assert.ok(createPanel.indexOf('applyAgentCliEnv(sessionEnv') > createPanel.indexOf('const sessionEnv = { ...prepareProjectSessionEnvironment'));
  const activation = read('src/activation.js');
  const start = activation.indexOf('startAgentCli(context);');
  assert.ok(start > 0 && start < activation.indexOf('restoreSessions('), 'server starts before tabs are restored');
});

test('package.json declares the setting and ships bin/', () => {
  const pkg = JSON.parse(read('package.json'));
  const conf = pkg.contributes.configuration;
  const props = Array.isArray(conf) ? Object.assign({}, ...conf.map((b: any) => b.properties || {})) : conf.properties;
  assert.equal(props['claudeCodeLauncher.agentCli.enabled'].type, 'boolean');
  assert.equal(props['claudeCodeLauncher.agentCli.enabled'].default, true);
  const ignore = read('.vscodeignore');
  assert.doesNotMatch(ignore, /^bin\b/m);
});
