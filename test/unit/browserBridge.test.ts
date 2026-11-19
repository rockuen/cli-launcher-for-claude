// browserBridge — browser extension "ask about this page" → new agent tab.
//
// The pure half (lib/browserBridge) is tested directly: the connection key,
// the Origin / Host / bearer checks, the request body, and the page file,
// prompt and title. The glue (handlers/browserBridge) runs a real HTTP server
// on a free 127.0.0.1 port against a stub `vscode` and stand-ins for
// createPanel, the editor CLI and the agent registry: the key, web pages
// refused, opening here and typing the prompt, handing a request to the window
// that owns the folder and claiming it there, and the refusals.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const ROOT = process.cwd();
const lib = require(path.join(ROOT, 'src/lib/browserBridge')) as any;

const TOKEN = 'A'.repeat(20) + 'b_c-' + 'Z'.repeat(19);

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test('connection key: round trip, and malformed keys are refused', () => {
  const token = lib.generateToken();
  assert.equal(lib.isValidToken(token), true);
  assert.deepEqual(lib.decodeKey(lib.encodeKey(47823, token)), { port: 47823, token });
  assert.deepEqual(lib.decodeKey(`  clb1.50000.${token}\n`), { port: 50000, token });
  assert.equal(lib.decodeKey(`clb1.80.${token}`), null); // privileged port
  assert.equal(lib.decodeKey(`clb1.70000.${token}`), null);
  assert.equal(lib.decodeKey('clb1.47823.short'), null);
  assert.equal(lib.decodeKey(`clb2.47823.${token}`), null);
  assert.equal(lib.decodeKey(''), null);
});

test('bearer token is read from the header and compared exactly', () => {
  assert.equal(lib.bearerToken(`Bearer ${TOKEN}`), TOKEN);
  assert.equal(lib.bearerToken(`bearer   ${TOKEN}`), TOKEN);
  assert.equal(lib.bearerToken(TOKEN), null);
  assert.equal(lib.bearerToken(undefined), null);
  assert.equal(lib.tokensMatch(TOKEN, TOKEN), true);
  assert.equal(lib.tokensMatch(TOKEN + 'x', TOKEN), false);
  assert.equal(lib.tokensMatch('', TOKEN), false);
  assert.equal(lib.tokensMatch(null, TOKEN), false);
  assert.equal(lib.tokensMatch(TOKEN, undefined), false);
});

test('origin: extension pages and origin-less tools only; host: loopback with our port only', () => {
  assert.equal(lib.isAllowedOrigin(undefined), true);
  assert.equal(lib.isAllowedOrigin('chrome-extension://abcdefghijklmnop'), true);
  assert.equal(lib.isAllowedOrigin('moz-extension://1234-abcd'), true);
  assert.equal(lib.isAllowedOrigin('https://evil.example'), false);
  assert.equal(lib.isAllowedOrigin('http://127.0.0.1:47823'), false);
  // Sandboxed frames and file:// pages send the literal string "null".
  assert.equal(lib.isAllowedOrigin('null'), false);
  assert.equal(lib.isAllowedOrigin('chrome-extension://abc/path'), false);

  assert.equal(lib.isAllowedHost('127.0.0.1:47823', 47823), true);
  assert.equal(lib.isAllowedHost('LOCALHOST:47823', 47823), true);
  assert.equal(lib.isAllowedHost('evil.example:47823', 47823), false);
  assert.equal(lib.isAllowedHost('127.0.0.1:1', 47823), false);
  assert.equal(lib.isAllowedHost(undefined, 47823), false);
});

test('~ expands to the home folder', () => {
  const home = path.join(os.tmpdir(), 'home-x');
  assert.equal(lib.expandHome('~', home), home);
  assert.equal(lib.expandHome('~/obsidian/iloom-workspace', home), path.join(home, 'obsidian', 'iloom-workspace'));
  assert.equal(lib.expandHome('~\\a', home), path.join(home, 'a'));
  assert.equal(lib.expandHome('~other/a', home), '~other/a');
  assert.equal(lib.expandHome('  /abs/x ', home), '/abs/x');
});

test('ask body: normalized, with the refusals', () => {
  // The real home/platform: expandHome joins with this OS's path module.
  const env = { home: os.homedir(), platform: process.platform };
  const good = { url: 'https://ex.com/a', title: ' A\n title ', content: '# Hi', question: ' 요약해줘\r\n둘째 줄 ', cwd: '~/w', agent: 'codex' };
  const r = lib.parseAskBody(good, env);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, {
    url: 'https://ex.com/a',
    title: 'A title',
    content: '# Hi',
    selection: '',
    question: '요약해줘\n둘째 줄',
    agent: 'codex',
    cwd: path.join(os.homedir(), 'w'),
    focus: true,
  });
  assert.equal(lib.parseAskBody({ ...good, agent: undefined }, env).value.agent, 'claude');
  assert.equal(lib.parseAskBody({ ...good, title: '' }, env).value.title, 'https://ex.com/a');
  assert.equal(lib.parseAskBody({ ...good, focus: false }, env).value.focus, false);
  assert.equal(lib.parseAskBody({ ...good, content: '', selection: 'sel' }, env).ok, true);

  assert.equal(lib.parseAskBody(null, env).error, 'bad-request');
  assert.equal(lib.parseAskBody([], env).error, 'bad-request');
  assert.equal(lib.parseAskBody({ ...good, url: 'javascript:alert(1)' }, env).error, 'bad-request');
  assert.equal(lib.parseAskBody({ ...good, content: ' ', selection: '' }, env).error, 'empty-page');
  assert.equal(lib.parseAskBody({ ...good, agent: '../x' }, env).error, 'unknown-agent');
  assert.equal(lib.parseAskBody({ ...good, cwd: '' }, env).error, 'bad-folder');
  assert.equal(lib.parseAskBody({ ...good, cwd: 'relative/dir' }, env).error, 'bad-folder');
  assert.equal(lib.parseAskBody({ ...good, cwd: '//server/share' }, env).error, 'bad-folder');
  assert.equal(lib.parseAskBody({ ...good, cwd: 'C:\\w' }, { platform: 'win32' }).ok, true);
  assert.equal(lib.parseAskBody({ ...good, cwd: '\\\\server\\share' }, { platform: 'win32' }).error, 'bad-folder');
});

test('page file: front matter, then the selection and the page under their own headings', () => {
  const name = lib.pageFileName(new Date(2026, 10, 19, 9, 5, 7), 'a1b2c3');
  assert.equal(name, 'web-261119-090507-a1b2c3.md');
  const md = lib.buildPageFile({
    title: 'Say "hi"\nthere',
    url: 'https://ex.com/a',
    content: 'Body text',
    selection: 'Picked',
    capturedAt: new Date('2026-11-19T00:00:00Z'),
  });
  assert.ok(md.startsWith('---\ntitle: "Say \\"hi\\" there"\nurl: "https://ex.com/a"\ncaptured: 2026-11-19T00:00:00.000Z\n---\n\n# Say "hi" there\n'));
  assert.ok(md.includes('## Selected part\n\nPicked\n'));
  assert.ok(md.includes('## Page content\n\nBody text\n'));
  assert.ok(md.indexOf('Selected part') < md.indexOf('Page content'));
  assert.ok(!lib.buildPageFile({ title: 't', url: 'u', content: 'c' }).includes('Selected part'));
});

test('prompt: Claude gets an @ mention, others a path; the request comes last', () => {
  const base = { title: 'T', url: 'https://ex.com', filePath: 'C:\\tmp\\claude-launcher-web\\web-1.md', question: '요약해줘' };
  const claude = lib.buildAskPrompt({ ...base, agent: 'claude' });
  assert.ok(claude.includes('- Page content: @C:/tmp/claude-launcher-web/web-1.md\n'));
  assert.ok(claude.endsWith('\n\nRequest:\n요약해줘'));
  assert.ok(!claude.includes('Selected part'));
  const codex = lib.buildAskPrompt({ ...base, agent: 'codex', hasSelection: true });
  assert.ok(codex.includes('- Page content: C:/tmp/claude-launcher-web/web-1.md\n'));
  assert.ok(codex.includes('"Selected part"'));
  const empty = lib.buildAskPrompt({ ...base, agent: 'claude', question: '  ' });
  assert.ok(empty.endsWith('Request:\nSummarize the key points of this page.'));
  // Control characters in a page title never reach the PTY.
  const dirty = lib.buildAskPrompt({ ...base, agent: 'claude', title: 'a\u001b[2Jb\u0007' });
  assert.ok(!/[\u0000-\u0008\u000b-\u001f]/.test(dirty));
});

test('page text: no @ survives (Claude Code also mentions after 。、？！); invisible characters go; long titles are cut', () => {
  const at = String.fromCharCode(0xff20);
  assert.equal(lib.pageLine('Docs @.env @~/.ssh/id_rsa a@b.com'), `Docs ${at}.env ${at}~/.ssh/id_rsa a${at}b.com`);
  // Claude Code's scanner treats these as mention starts inside a word too.
  for (const p of ['。', '、', '？', '！']) {
    assert.equal(lib.pageLine(`Notes${p}@.env`), `Notes${p}${at}.env`);
  }
  assert.equal(lib.pageLine('a、@"C:/Users/x/secret file.txt"'), `a、${at}"C:/Users/x/secret file.txt"`);
  assert.equal(lib.pageLine('@start'), `${at}start`);
  assert.equal(lib.pageLine('tab\t@x'), `tab ${at}x`);
  const hidden = ['x', String.fromCharCode(0x202e), 'y', String.fromCharCode(0x200b), 'z', String.fromCharCode(0x2066), String.fromCharCode(0xfeff)].join('');
  assert.equal(lib.pageLine(hidden), 'xyz');
  const cut = lib.pageLine('가'.repeat(400), 300);
  assert.equal(Array.from(cut).length, 300);
  assert.ok(cut.endsWith('…'));
  // In the body and the prompt.
  const body = lib.parseAskBody({ url: 'https://ex.com/@user', title: 'Hi @.env', content: 'c', cwd: os.homedir() }, { home: os.homedir(), platform: process.platform });
  assert.equal(body.value.title, `Hi ${at}.env`);
  const prompt = lib.buildAskPrompt({ title: 'Notes @~/.ssh/id_rsa', url: 'https://medium.com/@user/post', filePath: 'C:/t/web-1.md', agent: 'claude', question: 'q' });
  assert.ok(prompt.includes(`- Title: Notes ${at}~/.ssh/id_rsa\n`));
  assert.ok(prompt.includes(`- URL: https://medium.com/${at}user/post\n`));
  // The page file keeps the real address.
  assert.ok(lib.buildPageFile({ title: 't', url: 'https://medium.com/@user/post', content: 'c' }).includes('url: "https://medium.com/@user/post"'));
  // Only the page file is mentioned: it is the one @ in the prompt.
  assert.deepEqual(prompt.match(/@\S+/g), ['@C:/t/web-1.md']);
});

test('prompt: a page file path with a space is given plain, not as a broken @ mention', () => {
  const p = lib.buildAskPrompt({ title: 'T', url: 'https://ex.com', filePath: 'C:\\Users\\John Smith\\Temp\\web-1.md', agent: 'claude', question: 'q' });
  assert.ok(p.includes('- Page content: C:/Users/John Smith/Temp/web-1.md\n'));
  assert.ok(!/(^|\s)@/.test(p));
});

test('page file names: only names pageFileName makes are swept', () => {
  assert.equal(lib.PAGE_FILE_RE.test(lib.pageFileName(new Date(), 'a1b2c3')), true);
  assert.equal(lib.PAGE_FILE_RE.test('notes.md'), false);
  assert.equal(lib.PAGE_FILE_RE.test('web-261119-090507-a1.md.bak'), false);
});

test('tabs opened for outside text: every agent trust flag is gated on noPermissionBypass', () => {
  const create = fs.readFileSync(path.join(ROOT, 'src/panel/createPanel.js'), 'utf8');
  const restart = fs.readFileSync(path.join(ROOT, 'src/panel/restartPty.js'), 'utf8');
  const flagRead = /[^\n]*get\('(claude\.bypassPermissions|kiro\.trustAllTools|antigravity\.trustAllTools|codex\.trustAllTools|grok\.trustAllTools)'[^\n]*/g;
  for (const [src, guard] of [[create, '!noPermissionBypass && '], [restart, '!entry.noPermissionBypass && ']]) {
    const reads = src.match(flagRead) || [];
    assert.ok(reads.length >= 5, reads.join('\n'));
    for (const line of reads) assert.ok(line.includes(guard), line);
  }
  assert.match(create, /noPermissionBypass,\n/); // kept on the entry
  // Over the agents' own settings too.
  assert.ok(create.includes("...(noPermissionBypass ? ['--permission-mode', 'default'] : [])"));
  assert.ok(restart.includes("...(entry.noPermissionBypass ? ['--permission-mode', 'default'] : [])"));
  const codexHold = "codexArgs.push('--sandbox', 'workspace-write', '--ask-for-approval', 'on-request');";
  assert.ok(create.includes(`if (noPermissionBypass) ${codexHold}`));
  assert.ok(restart.includes(`if (entry.noPermissionBypass) ${codexHold}`));
  // Real ids found after spawn are remembered when found, not only on close.
  assert.equal(create.split('if (entry.noPermissionBypass) rememberNoBypassSession(state.context, fresh.sessionId);').length - 1, 4);
  // Remembered by session id, and checked whenever a session is opened.
  assert.ok(create.includes('isNoBypassSession(context, session.sessionId)'));
  assert.ok(create.includes('if (noPermissionBypass) rememberNoBypassSession(context, sessionId);'));
  assert.ok(create.includes('if (entry.noPermissionBypass) rememberNoBypassSession(context, entry.sessionId);'));
  assert.ok(fs.readFileSync(path.join(ROOT, 'src/activation.js'), 'utf8').includes('noPermissionBypass: !!activeEntry.noPermissionBypass'));
  for (const f of ['src/activation.js', 'src/store/sessionManager.js']) {
    assert.ok(fs.readFileSync(path.join(ROOT, f), 'utf8').includes('entry.noPermissionBypass ? { noPermissionBypass: true }'), f);
  }
});

test('remembered no-bypass sessions: dedup, newest last, capped, safe without storage', () => {
  const store = require(path.join(ROOT, 'src/store/noBypassSessions.js'));
  const data: Record<string, unknown> = {};
  const context = { globalState: { get: (k: string, d: unknown) => (k in data ? data[k] : d), update: (k: string, v: unknown) => { data[k] = v; } } };
  assert.equal(store.isNoBypassSession(context, 'a'), false);
  store.rememberNoBypassSession(context, 'a');
  store.rememberNoBypassSession(context, 'b');
  store.rememberNoBypassSession(context, 'a');
  assert.deepEqual(data[store.KEY], ['b', 'a']);
  assert.equal(store.isNoBypassSession(context, 'a'), true);
  assert.equal(store.isNoBypassSession(context, ''), false);
  for (let i = 0; i < store.MAX + 5; i++) store.rememberNoBypassSession(context, `s${i}`);
  assert.equal((data[store.KEY] as string[]).length, store.MAX);
  assert.equal(store.isNoBypassSession(context, 'a'), false);
  assert.equal(store.isNoBypassSession(context, `s${store.MAX + 4}`), true);
  assert.equal(store.isNoBypassSession(undefined, 'a'), false);
  store.rememberNoBypassSession(undefined, 'a');
  data[store.KEY] = 'garbage';
  assert.equal(store.isNoBypassSession(context, 'a'), false);
});

test('installed claude / codex still accept the hold flags', async (t) => {
  const { spawnSync } = require('child_process');
  const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000, shell: process.platform === 'win32' });
  const has = (cmd: string) => run(cmd, ['--version']).status === 0;
  if (!has('claude') && !has('codex')) {
    t.skip('neither claude nor codex installed');
    return;
  }
  if (has('claude')) {
    const r = run('claude', ['--permission-mode', 'default', '--version']);
    assert.equal(r.status, 0, `claude rejected --permission-mode default: ${r.stderr}`);
  }
  if (has('codex')) {
    const r = run('codex', ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', '--version']);
    assert.equal(r.status, 0, `codex rejected the hold flags: ${r.stderr}`);
    const resume = run('codex', ['resume', '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', '--help']);
    assert.equal(resume.status, 0, `codex resume rejected the hold flags: ${resume.stderr}`);
  }
});

test('tab title: Web · title, cut to 60 characters', () => {
  assert.equal(lib.browserTabTitle('Hello'), 'Web · Hello');
  assert.equal(lib.browserTabTitle(''), 'Web · -');
  const long = lib.browserTabTitle('가'.repeat(100));
  assert.equal(Array.from(long).length, 60);
  assert.ok(long.endsWith('…'));
});

// ---------------------------------------------------------------------------
// glue
// ---------------------------------------------------------------------------

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function request(port: number, o: { method?: string; path: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: o.method || 'GET', path: o.path, headers: o.headers || {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: any = text;
          try { body = JSON.parse(text); } catch (_) {}
          resolve({ status: res.statusCode || 0, body, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

function auth(extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...extra };
}

async function loadGlue(opts: { folders: string[]; port: number; openFolderOk?: boolean; failOpen?: boolean }) {
  const Module = require('module');
  const calls = {
    warns: [] as string[],
    opened: [] as any[],
    folderWindows: [] as string[],
    revealed: 0,
  };
  const config: Record<string, unknown> = {
    'browserBridge.enabled': true,
    'browserBridge.port': opts.port,
    enabledAgents: ['claude', 'codex'],
    agent: 'claude',
  };
  const vscodeStub = {
    workspace: {
      workspaceFolders: opts.folders.map((f) => ({ uri: { fsPath: f } })),
      workspaceFile: undefined,
      getConfiguration: () => ({
        get: (k: string, d: unknown) => (k in config ? config[k] : d),
        inspect: (k: string) => ({ key: k, globalValue: config[k] }),
        update: async (k: string, v: unknown) => {
          config[k] = v;
        },
      }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    window: {
      showWarningMessage: (m: string) => {
        calls.warns.push(m);
        return Promise.resolve(undefined);
      },
      showInformationMessage: () => Promise.resolve(undefined),
      showErrorMessage: () => Promise.resolve(undefined),
    },
    commands: {
      registerCommand: () => ({ dispose() {} }),
      executeCommand: () => undefined,
    },
    env: {
      appRoot: path.join(os.tmpdir(), 'no-editor'),
      appName: 'VSCodium',
      language: 'en',
      clipboard: { writeText: async () => undefined },
    },
    ConfigurationTarget: { Global: 1 },
  };
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (this: unknown, req: string, ...rest: unknown[]) {
    return req === 'vscode' ? 'vscode' : origResolve.call(this, req, ...rest);
  };
  require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeStub } as any;

  const state = require(path.join(ROOT, 'src/state.js'));
  const fake = (rel: string, exports: unknown) => {
    const file = require.resolve(path.join(ROOT, rel));
    require.cache[file] = { id: file, filename: file, loaded: true, exports } as any;
  };
  fake('src/panel/createPanel.js', {
    createPanel(_context: unknown, _ext: string, session: any, o: any) {
      state.tabCounter++;
      if (opts.failOpen) return;
      const writes: string[] = [];
      const entry = {
        agent: o.agent,
        pty: { write: (d: string) => writes.push(d) },
        panel: { viewColumn: 1, reveal: () => { calls.revealed++; } },
        _lastOutputAt: Date.now() - 10_000,
        _recentTail: '',
        writes,
      };
      state.panels.set(state.tabCounter, entry);
      calls.opened.push({ session, opts: o, entry });
    },
  });
  fake('src/lib/editorCli.js', {
    openFolderWindow: (dir: string) => {
      calls.folderWindows.push(dir);
      return opts.openFolderOk !== false;
    },
  });
  // Claude and Codex "installed", Grok not — independent of this machine.
  fake('src/agents/registry.js', {
    AGENTS: [
      { id: 'claude', label: 'Claude Code', cliName: 'claude', detect: () => true },
      { id: 'codex', label: 'Codex', cliName: 'codex', detect: () => true },
      { id: 'grok', label: 'Grok', cliName: 'grok', detect: () => false },
    ],
    isKnownAgent: (id: string) => ['claude', 'codex', 'grok'].includes(id),
    listAgents: () => [],
  });
  delete require.cache[require.resolve(path.join(ROOT, 'src/handlers/browserBridge.js'))];

  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-gs-'));
  const context = {
    subscriptions: [] as Array<{ dispose(): void }>,
    secrets: { get: async () => TOKEN, store: async () => undefined },
    globalStorageUri: { fsPath: storage },
    extensionPath: ROOT,
    extension: { packageJSON: { version: '9.9.9' } },
  };
  const mod = require(path.join(ROOT, 'src/handlers/browserBridge.js'));
  mod._test.startServer(context);
  // Wait until it listens.
  for (let i = 0; i < 100; i++) {
    try {
      const r = await request(opts.port, { path: '/v1/ping' });
      if (r.status === 200) break;
    } catch (_) {}
    await tick(20);
  }
  const dispose = () => {
    mod._test.stopServer();
    for (const d of context.subscriptions) {
      try { d.dispose(); } catch (_) {}
    }
    Module._resolveFilename = origResolve;
  };
  return { mod, calls, state, config, context, storage, vscodeStub, dispose };
}

function askBody(cwd: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    url: 'https://example.com/post',
    title: 'Example Post',
    content: '# Example\n\nSome body text.',
    question: '핵심만 요약해줘',
    cwd,
    agent: 'claude',
    ...extra,
  });
}

test('glue: ping needs no key; info and ask need the right key', async () => {
  const port = await freePort();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ws-'));
  const g = await loadGlue({ folders: [ws], port });
  try {
    const ping = await request(port, { path: '/v1/ping' });
    assert.equal(ping.status, 200);
    assert.deepEqual(ping.body, { ok: true, app: 'cli-launcher', api: 1 });

    assert.equal((await request(port, { path: '/v1/info' })).status, 401);
    assert.equal((await request(port, { path: '/v1/info', headers: { Authorization: 'Bearer wrong-key-wrong-key-wrong-key-wrong' } })).status, 401);
    assert.equal((await request(port, { method: 'POST', path: '/v1/ask', body: askBody(ws) })).status, 401);
    assert.equal(g.calls.opened.length, 0);

    const info = await request(port, { path: '/v1/info', headers: auth() });
    assert.equal(info.status, 200);
    assert.equal(info.body.version, '9.9.9');
    assert.equal(info.body.editor, 'VSCodium');
    assert.deepEqual(info.body.folders, [ws]);
    assert.deepEqual(
      info.body.agents.map((a: any) => [a.id, a.installed, a.enabled]),
      [['claude', true, true], ['codex', true, true], ['grok', false, false]]
    );
    assert.equal((await request(port, { path: '/v1/nope', headers: auth() })).status, 404);
  } finally {
    g.dispose();
  }
});

test('glue: web pages are refused by Origin, rebinding by Host; extensions get CORS headers', async () => {
  const port = await freePort();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ws-'));
  const g = await loadGlue({ folders: [ws], port });
  try {
    const web = await request(port, { method: 'POST', path: '/v1/ask', headers: auth({ Origin: 'https://evil.example' }), body: askBody(ws) });
    assert.equal(web.status, 403);
    assert.equal(web.headers['access-control-allow-origin'], undefined);
    const nullOrigin = await request(port, { path: '/v1/ping', headers: { Origin: 'null' } });
    assert.equal(nullOrigin.status, 403);
    const rebound = await request(port, { path: '/v1/info', headers: auth({ Host: `evil.example:${port}` }) });
    assert.equal(rebound.status, 403);
    assert.equal(g.calls.opened.length, 0);

    const ext = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const pre = await request(port, { method: 'OPTIONS', path: '/v1/ask', headers: { Origin: ext } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], ext);
    assert.equal(pre.headers['access-control-allow-private-network'], 'true');
    const info = await request(port, { path: '/v1/info', headers: auth({ Origin: ext }) });
    assert.equal(info.status, 200);
    assert.equal(info.headers['access-control-allow-origin'], ext);
  } finally {
    g.dispose();
  }
});

test('glue: ask opens a tab in this window, saves the page and types the prompt', async () => {
  const port = await freePort();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ws-'));
  const g = await loadGlue({ folders: [ws], port });
  try {
    const res = await request(port, {
      method: 'POST',
      path: '/v1/ask',
      headers: auth(),
      body: askBody(ws, { selection: 'picked words' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.result, 'opened');
    assert.equal(res.body.folder, path.basename(ws));
    assert.equal(g.calls.opened.length, 1);
    const { session, opts, entry } = g.calls.opened[0];
    // The page is someone else's text: no permission bypass by default.
    assert.deepEqual(opts, { agent: 'claude', noPermissionBypass: true });
    assert.equal(session.cwd, ws);
    assert.equal(session.title, 'Web · Example Post');
    assert.equal(g.calls.revealed, 1);
    // Single-folder window: the CLI is handed this folder to bring it forward.
    assert.deepEqual(g.calls.folderWindows, [ws]);

    const page = fs.readFileSync(res.body.file, 'utf8');
    assert.ok(page.includes('# Example Post'));
    assert.ok(page.includes('## Selected part\n\npicked words'));
    assert.ok(page.includes('Some body text.'));
    assert.ok(res.body.file.includes('claude-launcher-web'));

    assert.equal(entry.writes.length, 0);
    await tick(2400);
    const typed = entry.writes.join('');
    assert.ok(typed.startsWith('\x1b[200~This is a web page sent from my browser.'));
    assert.ok(typed.includes(`- Page content: @${res.body.file.replace(/\\/g, '/')}\n`));
    assert.ok(typed.includes('"Selected part"'));
    assert.ok(typed.includes('Request:\n핵심만 요약해줘\x1b[201~'));
    assert.ok(typed.endsWith('\r'));
    fs.unlinkSync(res.body.file);
  } finally {
    g.dispose();
  }
});

test('glue: another folder is handed to its window, which claims and opens it with the chosen agent', async () => {
  const port = await freePort();
  const here = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-here-'));
  const there = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-there-'));
  const g = await loadGlue({ folders: [here], port });
  try {
    const res = await request(port, { method: 'POST', path: '/v1/ask', headers: auth(), body: askBody(there, { agent: 'codex', focus: false }) });
    assert.equal(res.status, 200);
    assert.equal(res.body.result, 'handed-off');
    assert.equal(g.calls.opened.length, 0);
    assert.deepEqual(g.calls.folderWindows, [there]);
    const pending = fs.readdirSync(g.storage).filter((n) => n.startsWith('pending-browser-'));
    assert.equal(pending.length, 1);

    // This window does not own the folder: it leaves the record alone.
    g.mod._test.claimPending(g.context);
    assert.equal(g.calls.opened.length, 0);

    // The window that has the folder open claims it.
    (g.vscodeStub.workspace as any).workspaceFolders = [{ uri: { fsPath: there } }];
    g.mod._test.claimPending(g.context);
    assert.equal(g.calls.opened.length, 1);
    assert.deepEqual(g.calls.opened[0].opts, { agent: 'codex', noPermissionBypass: true });
    assert.equal(g.calls.opened[0].session.cwd, there);
    assert.equal(fs.readdirSync(g.storage).filter((n) => n.startsWith('pending-browser-')).length, 0);
    // Claimed once only.
    g.mod._test.claimPending(g.context);
    assert.equal(g.calls.opened.length, 1);
    fs.unlinkSync(res.body.file);
  } finally {
    g.dispose();
  }
});

test('glue: no window can take the folder → the tab opens here', async () => {
  const port = await freePort();
  const here = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-here-'));
  const there = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-there-'));
  const g = await loadGlue({ folders: [here], port, openFolderOk: false });
  try {
    const res = await request(port, { method: 'POST', path: '/v1/ask', headers: auth(), body: askBody(there, { focus: false }) });
    assert.equal(res.body.result, 'opened');
    assert.equal(g.calls.opened[0].session.cwd, there);
    assert.equal(fs.readdirSync(g.storage).filter((n) => n.startsWith('pending-browser-')).length, 0);
    fs.unlinkSync(res.body.file);
  } finally {
    g.dispose();
  }
});

test('glue: refusals — missing folder, agent not installed, bad JSON, oversized body, tab that fails to open', async () => {
  const port = await freePort();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ws-'));
  const g = await loadGlue({ folders: [ws], port });
  try {
    const missing = await request(port, { method: 'POST', path: '/v1/ask', headers: auth(), body: askBody(path.join(ws, 'nope')) });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, 'bad-folder');
    const grok = await request(port, { method: 'POST', path: '/v1/ask', headers: auth(), body: askBody(ws, { agent: 'grok' }) });
    assert.equal(grok.body.error, 'agent-not-installed');
    const unknown = await request(port, { method: 'POST', path: '/v1/ask', headers: auth(), body: askBody(ws, { agent: 'mystery' }) });
    assert.equal(unknown.body.error, 'unknown-agent');
    const bad = await request(port, { method: 'POST', path: '/v1/ask', headers: auth(), body: '{not json' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'bad-request');
    const big = await request(port, {
      method: 'POST',
      path: '/v1/ask',
      headers: auth(),
      body: askBody(ws, { content: 'x'.repeat(lib.MAX_BODY_BYTES + 10) }),
    });
    assert.equal(big.status, 413);
    assert.equal(big.body.error, 'too-large');
    assert.equal(g.calls.opened.length, 0);
  } finally {
    g.dispose();
  }

  const port2 = await freePort();
  const g2 = await loadGlue({ folders: [ws], port: port2, failOpen: true });
  try {
    const res = await request(port2, { method: 'POST', path: '/v1/ask', headers: auth(), body: askBody(ws) });
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'open-failed');
  } finally {
    g2.dispose();
  }
});

test('glue: allowPermissionBypass lets the tab use the agent trust settings', async () => {
  const port = await freePort();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ws-'));
  const g = await loadGlue({ folders: [ws], port });
  try {
    g.config['browserBridge.allowPermissionBypass'] = true;
    const res = await request(port, { method: 'POST', path: '/v1/ask', headers: auth(), body: askBody(ws, { focus: false }) });
    assert.equal(res.body.result, 'opened');
    assert.deepEqual(g.calls.opened[0].opts, { agent: 'claude', noPermissionBypass: false });
    fs.unlinkSync(res.body.file);
  } finally {
    g.dispose();
  }
});

test('glue: a window that already has a parent folder open claims the hand-off — no editor CLI, no extra window', async () => {
  const port = await freePort();
  const here = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-here-'));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-parent-'));
  const sub = path.join(parent, 'sub');
  fs.mkdirSync(sub);
  const g = await loadGlue({ folders: [here], port });
  // Stand-in for the other window's watcher: it claims the record at once.
  const watcher = fs.watch(g.storage, (_e, name) => {
    if (name && String(name).startsWith('pending-browser-')) {
      try { fs.unlinkSync(path.join(g.storage, String(name))); } catch (_) {}
    }
  });
  try {
    const res = await request(port, { method: 'POST', path: '/v1/ask', headers: auth(), body: askBody(sub) });
    assert.equal(res.body.result, 'handed-off');
    assert.deepEqual(g.calls.folderWindows, []);
    assert.equal(g.calls.opened.length, 0);
    fs.unlinkSync(res.body.file);
  } finally {
    watcher.close();
    g.dispose();
  }
});

test('glue: the claiming window brings itself forward when asked to; a record from the future is swept', async () => {
  const port = await freePort();
  const here = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-here-'));
  const g = await loadGlue({ folders: [here], port });
  try {
    fs.writeFileSync(path.join(g.storage, 'pending-browser-abc.json'), JSON.stringify({
      cwd: here, agent: 'claude', title: 'Web · x', prompt: 'p', focus: true, ts: Date.now(),
    }));
    // From the future (the clock moved back): swept, never opened.
    fs.writeFileSync(path.join(g.storage, 'pending-browser-future.json'), JSON.stringify({
      cwd: here, agent: 'claude', title: 'Web · y', prompt: 'p', ts: Date.now() + 3_600_000,
    }));
    g.mod._test.claimPending(g.context);
    assert.equal(g.calls.opened.length, 1);
    assert.equal(g.calls.opened[0].session.title, 'Web · x');
    assert.deepEqual(g.calls.folderWindows, [here]);
    assert.deepEqual(fs.readdirSync(g.storage).filter((n) => n.startsWith('pending-browser-')), []);
  } finally {
    g.dispose();
  }
});

test('glue: a second window waits for the port and takes over when the first goes away', async () => {
  const port = await freePort();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ws-'));
  // Something else holds the port.
  const blocker = http.createServer((_q, s) => { s.writeHead(418); s.end(); });
  await new Promise<void>((r) => blocker.listen(port, '127.0.0.1', () => r()));
  const g = await loadGlue({ folders: [ws], port });
  try {
    assert.equal((await request(port, { path: '/v1/ping' })).status, 418);
    await new Promise<void>((r) => blocker.close(() => r()));
    // RETRY_MS is 10 s; wait for the retry to bind.
    let status = 0;
    for (let i = 0; i < 60 && status !== 200; i++) {
      await tick(250);
      try { status = (await request(port, { path: '/v1/ping' })).status; } catch (_) {}
    }
    assert.equal(status, 200);
  } finally {
    g.dispose();
  }
});
