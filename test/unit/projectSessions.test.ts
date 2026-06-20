// Project-scoped session storage.
//
// Codex/Grok/Kiro/Antigravity normally store sessions in user-global CLI homes. The
// launcher can optionally route those session homes under the active workspace
// so each project has independent history without OneDrive/live-sync junctions.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');

function withProjectSessions(scope: 'global' | 'project', fn: (mod: any) => void) {
  const modulePath = path.join(process.cwd(), 'src/lib/projectSessions.js');
  delete require.cache[require.resolve(modulePath)];

  const origLoad = (Module as any)._load;
  (Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'vscode') {
      return {
        workspace: {
          getConfiguration: () => ({
            get: (key: string, fallback: any) => key === 'sessionStorage.scope' ? scope : fallback,
          }),
        },
      };
    }
    return origLoad.apply(this, [request, ...rest]);
  };
  try {
    fn(require(modulePath));
  } finally {
    (Module as any)._load = origLoad;
  }
}

test('project storage paths live under <workspace>/.agent-sessions', () => {
  withProjectSessions('project', (mod) => {
    const cwd = path.join(os.tmpdir(), 'workspace-a');

    assert.equal(mod.projectSessionRoot(cwd), path.join(cwd, '.agent-sessions'));
    assert.equal(mod.getCodexPaths(cwd).home, path.join(cwd, '.agent-sessions', '.home', 'codex'));
    assert.equal(mod.getCodexPaths(cwd).sessionsDir, path.join(cwd, '.agent-sessions', 'codex'));
    assert.equal(mod.getCodexPaths(cwd).indexFile, path.join(cwd, '.agent-sessions', '.home', 'codex', 'session_index.jsonl'));
    assert.equal(mod.getKiroSessionsDir(cwd), path.join(cwd, '.agent-sessions', 'kiro'));
    assert.equal(mod.getAntigravityBaseDir(cwd), path.join(cwd, '.agent-sessions', 'antigravity'));
    assert.equal(mod.getGrokPaths(cwd).home, path.join(cwd, '.agent-sessions', '.home', 'grok'));
    assert.equal(mod.getGrokPaths(cwd).sessionsDir, path.join(cwd, '.agent-sessions', 'grok'));
    assert.equal(mod.getGjcPaths(cwd).agentDir, path.join(cwd, '.agent-sessions', '.home', 'gjc', 'agent'));
    assert.equal(mod.getGjcPaths(cwd).sessionsDir, path.join(cwd, '.agent-sessions', 'gjc'));
  });
});

test('global storage keeps CLI default locations', () => {
  withProjectSessions('global', (mod) => {
    const cwd = path.join(os.tmpdir(), 'workspace-b');
    const codexHome = path.join(os.homedir(), '.codex');

    assert.equal(mod.getCodexPaths(cwd).home, codexHome);
    assert.equal(mod.getCodexPaths(cwd).sessionsDir, path.join(codexHome, 'sessions'));
    assert.equal(mod.getKiroSessionsDir(cwd), path.join(os.homedir(), '.kiro', 'sessions', 'cli'));
    assert.equal(mod.getAntigravityBaseDir(cwd), path.join(os.homedir(), '.gemini', 'antigravity-cli'));
    assert.equal(mod.getGrokPaths(cwd).home, path.join(os.homedir(), '.grok'));
    assert.equal(mod.getGrokPaths(cwd).sessionsDir, path.join(os.homedir(), '.grok', 'sessions'));
    assert.equal(mod.getGjcPaths(cwd).agentDir, path.join(os.homedir(), '.gjc', 'agent'));
    assert.equal(mod.getGjcPaths(cwd).sessionsDir, path.join(os.homedir(), '.gjc', 'agent', 'sessions'));
  });
});

test('prepareProjectSessionEnvironment sets per-agent project homes', () => {
  withProjectSessions('project', (mod) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sessions-env-'));

    const codex = mod.prepareProjectSessionEnvironment('codex', cwd, { KEEP: '1' });
    assert.equal(codex.KEEP, '1');
    assert.equal(codex.CODEX_HOME, path.join(cwd, '.agent-sessions', '.home', 'codex'));
    assert.equal(fs.existsSync(path.join(codex.CODEX_HOME, 'sessions')), true);

    const kiro = mod.prepareProjectSessionEnvironment('kiro', cwd, { KEEP: '1' });
    assert.equal(kiro.KEEP, '1');
    assert.equal(kiro.HOME, path.join(cwd, '.agent-sessions', '.home', 'kiro'));
    assert.equal(kiro.USERPROFILE, kiro.HOME);

    const antigravity = mod.prepareProjectSessionEnvironment('antigravity', cwd, { KEEP: '1' });
    assert.equal(antigravity.KEEP, '1');
    assert.equal(antigravity.HOME, path.join(cwd, '.agent-sessions', '.home', 'antigravity'));
    assert.equal(antigravity.USERPROFILE, antigravity.HOME);

    const grok = mod.prepareProjectSessionEnvironment('grok', cwd, { KEEP: '1', HOME: os.homedir() });
    assert.equal(grok.KEEP, '1');
    assert.equal(grok.GROK_HOME, path.join(cwd, '.agent-sessions', '.home', 'grok'));
    assert.equal(grok.HOME, os.homedir(), 'Grok uses GROK_HOME, not virtual HOME');
    assert.equal(fs.existsSync(path.join(grok.GROK_HOME, 'sessions')), true);

    const gjc = mod.prepareProjectSessionEnvironment('gjc', cwd, { KEEP: '1', HOME: os.homedir() });
    assert.equal(gjc.KEEP, '1');
    assert.equal(gjc.GJC_CODING_AGENT_DIR, path.join(cwd, '.agent-sessions', '.home', 'gjc', 'agent'));
    assert.equal(gjc.HOME, os.homedir(), 'gjc uses GJC_CODING_AGENT_DIR, not virtual HOME');
    assert.equal(fs.existsSync(path.join(gjc.GJC_CODING_AGENT_DIR, 'sessions')), true);

    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

test('panel and restart paths pass project session env to PTY spawn', () => {
  const createPanel = fs.readFileSync(path.join(process.cwd(), 'src/panel/createPanel.js'), 'utf8');
  const restartPty = fs.readFileSync(path.join(process.cwd(), 'src/panel/restartPty.js'), 'utf8');
  const backend = fs.readFileSync(path.join(process.cwd(), 'src/pty/backend.js'), 'utf8');

  assert.ok(createPanel.includes("require('../lib/projectSessions')"));
  assert.ok(createPanel.includes('prepareProjectSessionEnvironment(agent, cwd, process.env)'));
  assert.ok(createPanel.includes('env: sessionEnv'));
  assert.ok(restartPty.includes('prepareProjectSessionEnvironment(agent, entry.cwd, process.env)'));
  assert.ok(restartPty.includes('...sessionEnv'));
  assert.ok(backend.includes('function spawnEnv(extraEnv)'));
  assert.ok(backend.includes('...(extraEnv || {})'));
});
