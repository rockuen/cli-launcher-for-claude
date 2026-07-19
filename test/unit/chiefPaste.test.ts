import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const bp = require(path.join(process.cwd(), 'bin', 'lib', 'bracketedPaste'));
const { createPasteJoiner, decodePastedLine, encodePasteBody, NL_SENTINEL, PASTE_START, PASTE_END } = bp;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveChiefCli } = require(path.join(process.cwd(), 'src', 'pty', 'resolveCli'));

// Drive the Transform with the given chunks and collect the bytes it forwards
// to readline.
function runJoiner(chunks: string[]): Promise<string> {
  return new Promise((resolve) => {
    const j = createPasteJoiner();
    let out = '';
    j.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    j.on('end', () => resolve(out));
    for (const c of chunks) j.write(Buffer.from(c, 'utf8'));
    j.end();
  });
}

const BODY = 'line1\nline2\n\nline3';
const WRAPPED = PASTE_START + BODY + PASTE_END + '\r';

test('encode/decode round-trips a multi-line body', () => {
  const encoded = encodePasteBody(BODY);
  assert.equal(encoded.includes('\n'), false, 'encoded form must be single-line for readline');
  assert.equal(decodePastedLine(encoded), BODY);
});

test('a bracketed paste in one chunk collapses to a single readline line', async () => {
  const out = await runJoiner([WRAPPED]);
  // markers stripped, internal newlines hidden behind the sentinel, trailing CR kept
  assert.equal(out, BODY.split('\n').join(NL_SENTINEL) + '\r');
  assert.equal(out.includes('\n'), false);
  assert.equal(decodePastedLine(out.replace(/\r$/, '')), BODY);
});

test('a bracketed paste split across chunks (incl. mid-marker) still collapses', async () => {
  const parts = [WRAPPED.slice(0, 3), WRAPPED.slice(3, 8), WRAPPED.slice(8, 20), WRAPPED.slice(20)];
  const out = await runJoiner(parts);
  assert.equal(decodePastedLine(out.replace(/\r$/, '')), BODY);
  assert.equal(out.includes('\n'), false);
});

test('normal typing and slash commands pass through untouched', async () => {
  assert.equal(await runJoiner(['hello\r']), 'hello\r');
  assert.equal(await runJoiner(['/exit\r']), '/exit\r');
});

test('an escape sequence split exactly at ESC[ is not mistaken for a paste start', async () => {
  // arrow-up arriving as "\x1b[" then "A" must re-emerge intact, not be eaten
  assert.equal(await runJoiner(['abc\x1b[', 'A def']), 'abc\x1b[A def');
});

test('CRLF / CR inside a paste are normalized to LF on decode', async () => {
  const out = await runJoiner([PASTE_START + 'a\r\nb\rc' + PASTE_END]);
  assert.equal(decodePastedLine(out), 'a\nb\nc');
});

// Regression (v3.20.2): the sentinel must survive readline's keypress parsing.
// The original U+0000 sentinel was classified as a ctrl-combo (ctrl+`) and
// silently dropped from the line buffer, so decodePastedLine had nothing to
// restore and pasted lines arrived glued together. This drives the joiner
// through a REAL readline Interface in terminal mode — the exact layer that
// broke — and asserts the multi-line body round-trips.
test('the sentinel survives readline(terminal:true) and decodes back to newlines', async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const readline = require('node:readline');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PassThrough } = require('node:stream');

  const line: string = await new Promise((resolve, reject) => {
    const joiner = createPasteJoiner();
    const echo = new PassThrough();
    echo.resume(); // discard readline's echo/cursor writes
    const rl = readline.createInterface({ input: joiner, output: echo, terminal: true });
    const timer = setTimeout(() => reject(new Error('no line event')), 2000);
    rl.on('line', (l: string) => { clearTimeout(timer); rl.close(); resolve(l); });
    joiner.write(WRAPPED);
  });

  assert.equal(decodePastedLine(line), BODY);
});

// Integration: drive the real chief-repl wrapper under node-pty and confirm a
// multi-line bracketed paste is recorded as exactly ONE user turn (the bug was
// one transcript row per physical line). The transcript row is written before
// any network call, so unreachable creds don't matter. Run in a child process
// so node-pty's Windows handles can't keep node:test alive.
test('chief-repl records a multi-line paste as a single user message', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { spawnSync } = require('node:child_process');
  const resolved = resolveChiefCli();
  assert.ok(resolved);

  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-paste-'));
  const sessionId = 'chief-paste-smoke';
  const pasteBody = '안녕하세요, SCM팀입니다.\n둘째 줄입니다.\n\n넷째 줄(빈 줄 위)입니다.';

  const script = `
const pty = require('node-pty');
const fs = require('fs');
const path = require('path');
const args = JSON.parse(process.env.CHIEF_ARGS || '[]');
const body = process.env.PASTE_BODY;
const child = pty.spawn(process.env.CHIEF_SHELL, args, {
  name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
});
let output = '';
let sent = false;
const done = (code) => {
  try { child.kill(); } catch (_) {}
  const file = path.join(process.env.CHIEF_SESSIONS_DIR, process.env.SESSION_ID, 'updates.jsonl');
  let rows = [];
  try {
    rows = fs.readFileSync(file, 'utf8').split(/\\r?\\n/).filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) { console.error('read updates.jsonl failed: ' + e.message); process.exit(3); }
  const users = rows.filter((r) => r && r.role === 'user');
  console.log('USER_COUNT=' + users.length);
  console.log('USER_TEXT=' + JSON.stringify(users[0] ? users[0].text : null));
  process.exit(0);
};
const timer = setTimeout(() => { console.error('timeout; output=' + output); done(124); }, 8000);
child.onData((chunk) => {
  output += chunk;
  if (!sent && output.includes('chief>')) {
    sent = true;
    child.write('\\x1b[200~' + body + '\\x1b[201~\\r');
    // give the wrapper time to append the user row before we read it
    setTimeout(() => { clearTimeout(timer); done(0); }, 1500);
  }
});
child.onExit(() => {});
`;

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      ...resolved.env,
      CHIEF_SHELL: resolved.shell,
      CHIEF_ARGS: JSON.stringify([...resolved.args, '--session-id', sessionId, '--cwd', process.cwd()]),
      CHIEF_API_KEY: 'dummy',
      CHIEF_PROJECT_ID: 'dummy',
      CHIEF_BASE_URL: 'http://127.0.0.1:1',
      CHIEF_SESSIONS_DIR: sessionsDir,
      SESSION_ID: sessionId,
      PASTE_BODY: pasteBody,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  assert.match(result.stdout, /USER_COUNT=1\b/, `expected exactly one user row; got:\n${result.stdout}`);
  const m = result.stdout.match(/USER_TEXT=(.*)/);
  assert.ok(m, 'USER_TEXT not found');
  assert.equal(JSON.parse(m![1]), pasteBody);

  try { fs.rmSync(sessionsDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});
