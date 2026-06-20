import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { listAgents } = require('../../src/agents/registry');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveChiefCli, isChiefCliAvailable } = require('../../src/pty/resolveCli');

test('listAgents includes chief as an installed bundled agent', () => {
  const chief = listAgents().find((a: any) => a.id === 'chief');
  assert.ok(chief);
  assert.equal(chief.installed, true);
});

test('isChiefCliAvailable tracks the bundled Chief wrapper without requiring credentials', () => {
  assert.equal(isChiefCliAvailable(), true);
});

test('resolveChiefCli uses the bundled chief-repl wrapper through a Node runtime', () => {
  const resolved = resolveChiefCli();
  assert.ok(resolved);
  assert.match(path.basename(resolved.shell).toLowerCase(), /^node(\.exe)?$/);
  assert.equal(resolved.args[0], path.join(process.cwd(), 'bin', 'chief-repl.js'));
});


test('Chief spawn paths merge resolver environment into the PTY environment', () => {
  const createPanel = fs.readFileSync(path.join(process.cwd(), 'src', 'panel', 'createPanel.js'), 'utf8');
  const restartPty = fs.readFileSync(path.join(process.cwd(), 'src', 'panel', 'restartPty.js'), 'utf8');

  assert.match(createPanel, /extraEnv = resolvedChief\.env \|\| \{\}/);
  assert.match(createPanel, /\.\.\.prepareProjectSessionEnvironment\(agent, cwd, process\.env\), \.\.\.extraEnv/);
  assert.match(restartPty, /extraEnv = resolvedChief\.env \|\| \{\}/);
  assert.match(restartPty, /\.\.\.prepareProjectSessionEnvironment\(agent, entry\.cwd, process\.env\), \.\.\.extraEnv/);
});

test('resolved Chief wrapper emits startup text under node-pty', () => {
  // Keep node-pty in a child process; its Windows handles can keep node:test alive
  // after the smoke has passed.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { spawnSync } = require('node:child_process');
  const resolved = resolveChiefCli();
  assert.ok(resolved);

  const script = `
const pty = require('node-pty');
const args = JSON.parse(process.env.CHIEF_ARGS || '[]');
const child = pty.spawn(process.env.CHIEF_SHELL, args, {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
});
let output = '';
let sentExit = false;
const timer = setTimeout(() => {
  try { child.kill(); } catch (_) {}
  console.error('Chief PTY smoke timed out. Output: ' + output);
  process.exit(124);
}, 5000);
child.onData((chunk) => {
  output += chunk;
  process.stdout.write(chunk);
  if (!sentExit && output.includes('chief>')) {
    sentExit = true;
    child.write('/exit\\r');
  }
});
child.onExit(({ exitCode }) => {
  clearTimeout(timer);
  if (exitCode !== 0) {
    console.error('Chief PTY smoke exited with code ' + exitCode + '. Output: ' + output);
    process.exit(exitCode || 1);
  }
  if (!/Chief REPL - async REST chat via Storytell Chief\\./.test(output) || !/chief>/.test(output)) {
    console.error('Chief PTY smoke missed startup text. Output: ' + output);
    process.exit(2);
  }
  process.exit(0);
});
`;

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      ...resolved.env,
      CHIEF_SHELL: resolved.shell,
      CHIEF_ARGS: JSON.stringify([...resolved.args, '--session-id', 'chief-pty-smoke', '--cwd', process.cwd()]),
      CHIEF_API_KEY: 'dummy',
      CHIEF_PROJECT_ID: 'dummy',
      CHIEF_SESSIONS_DIR: path.join(process.cwd(), '.test-out', 'chief-pty-smoke'),
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  assert.match(result.stdout, /Chief REPL - async REST chat via Storytell Chief\./);
  assert.match(result.stdout, /chief>/);
});
