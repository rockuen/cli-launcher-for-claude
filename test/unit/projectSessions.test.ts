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
    // gjc >= 0.11.6 rejects a linked sessions root, so sessions live INSIDE the
    // project agent dir instead of a .agent-sessions/gjc redirect.
    assert.equal(mod.getGjcPaths(cwd).sessionsDir, path.join(cwd, '.agent-sessions', '.home', 'gjc', 'agent', 'sessions'));
    assert.equal(mod.getChiefPaths(cwd).home, path.join(cwd, '.agent-sessions', '.home', 'chief'));
    assert.equal(mod.getChiefPaths(cwd).sessionsDir, path.join(cwd, '.agent-sessions', 'chief'));
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
    assert.equal(mod.getChiefPaths(cwd).home, path.join(os.homedir(), '.chief'));
    assert.equal(mod.getChiefPaths(cwd).sessionsDir, path.join(os.homedir(), '.chief', 'sessions'));
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
    // macOS: the virtual HOME must expose the real login keychain (symlinked),
    // or agy pops a blocking "keychain not found" dialog on every launch.
    if (process.platform === 'darwin') {
      const realKc = path.join(os.homedir(), 'Library', 'Keychains');
      if (fs.existsSync(realKc)) {
        const linkedKc = path.join(antigravity.HOME, 'Library', 'Keychains');
        assert.equal(fs.existsSync(linkedKc), true, 'antigravity virtual HOME links the real Keychains');
        assert.equal(fs.realpathSync(linkedKc), fs.realpathSync(realKc), 'Keychains link resolves to the real keychain dir');
      }
    }

    const grok = mod.prepareProjectSessionEnvironment('grok', cwd, { KEEP: '1', HOME: os.homedir() });
    assert.equal(grok.KEEP, '1');
    assert.equal(grok.GROK_HOME, path.join(cwd, '.agent-sessions', '.home', 'grok'));
    assert.equal(grok.HOME, os.homedir(), 'Grok uses GROK_HOME, not virtual HOME');
    assert.equal(fs.existsSync(path.join(grok.GROK_HOME, 'sessions')), true);

    const gjc = mod.prepareProjectSessionEnvironment('gjc', cwd, { KEEP: '1', HOME: os.homedir() });
    assert.equal(gjc.KEEP, '1');
    assert.equal(gjc.GJC_CODING_AGENT_DIR, path.join(cwd, '.agent-sessions', '.home', 'gjc', 'agent'));
    assert.equal(gjc.HOME, os.homedir(), 'gjc uses GJC_CODING_AGENT_DIR, not virtual HOME');
    const gjcSessions = path.join(gjc.GJC_CODING_AGENT_DIR, 'sessions');
    assert.equal(fs.existsSync(gjcSessions), true);
    assert.equal(
      fs.lstatSync(gjcSessions).isSymbolicLink(),
      false,
      'gjc sessions root must be a real dir — gjc >= 0.11.6 rejects links'
    );

    const chief = mod.prepareProjectSessionEnvironment('chief', cwd, {
      KEEP: '1',
      CHIEF_API_KEY: 'env-key',
      CHIEF_PROJECT_ID: 'env-project',
    });
    assert.equal(chief.KEEP, '1');
    assert.equal(chief.CHIEF_API_KEY, 'env-key');
    assert.equal(chief.CHIEF_PROJECT_ID, 'env-project');
    assert.equal(chief.CHIEF_BASE_URL, 'https://api.storytell.ai');
    assert.equal(chief.CHIEF_INTELLIGENCE, 'auto');
    assert.equal(chief.CHIEF_PROVIDER, 'automatic');
    assert.equal(chief.CHIEF_PROFILE, 'general');
    assert.equal(chief.CHIEF_SESSIONS_DIR, path.join(cwd, '.agent-sessions', 'chief'));
    assert.equal(fs.existsSync(chief.CHIEF_SESSIONS_DIR), true);

    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

// gjc >= 0.11.6 fails launch with "The sessions root is not a safe directory"
// when <agentDir>/sessions is a junction/symlink — the pre-v3.20.5 layout.
// Preparing the gjc env must replace the link with a real directory and absorb
// the legacy .agent-sessions/gjc payload so history and resume keep working.
test('gjc legacy sessions link is replaced by a real dir and its payload absorbed', () => {
  withProjectSessions('project', (mod) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gjc-migrate-'));
    const legacy = path.join(cwd, '.agent-sessions', 'gjc');
    const agentDir = path.join(cwd, '.agent-sessions', '.home', 'gjc', 'agent');
    fs.mkdirSync(path.join(legacy, 'enc-cwd'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'enc-cwd', 'a.jsonl'), '{"type":"session"}');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.symlinkSync(legacy, path.join(agentDir, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');

    const env = mod.prepareProjectSessionEnvironment('gjc', cwd, {});
    const sessions = path.join(env.GJC_CODING_AGENT_DIR, 'sessions');
    assert.equal(fs.lstatSync(sessions).isSymbolicLink(), false, 'link replaced by a real dir');
    assert.equal(
      fs.readFileSync(path.join(sessions, 'enc-cwd', 'a.jsonl'), 'utf8'),
      '{"type":"session"}',
      'legacy payload moved into the real sessions dir'
    );
    assert.equal(fs.existsSync(legacy), false, 'emptied legacy dir removed');

    // gjc's write protocol also verifies the sessions root is owner-only
    // (protected single-ACE DACL / mode 0700) — otherwise owner_mismatch.
    if (process.platform === 'win32') {
      const acl = require('child_process').execFileSync('icacls', [sessions]).toString();
      assert.ok(!acl.includes('(I)'), 'inherited ACEs are stripped from the gjc sessions root');
    } else {
      assert.equal(fs.statSync(sessions).mode & 0o777, 0o700, 'gjc sessions root is 0700');
      assert.equal(
        fs.statSync(path.join(sessions, 'enc-cwd', 'a.jsonl')).mode & 0o777,
        0o600,
        'migrated payload normalized to owner-only'
      );
    }

    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

// A project home seeded once from ~/.codex used to pin whatever auth.json existed
// at seed time. Re-logging in against the real home revoked that refresh token,
// so the launcher-spawned Codex failed with "401 token_expired".
test('_refreshFileIfNewer tracks the real home only when it is newer', () => {
  withProjectSessions('project', (mod) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-newer-'));
    const src = path.join(dir, 'src.json');
    const dst = path.join(dir, 'dst.json');

    // absent dst → seed
    fs.writeFileSync(src, 'v1');
    mod._refreshFileIfNewer(src, dst);
    assert.equal(fs.readFileSync(dst, 'utf8'), 'v1');

    // src newer → refresh
    fs.writeFileSync(src, 'v2');
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(src, future, future);
    mod._refreshFileIfNewer(src, dst);
    assert.equal(fs.readFileSync(dst, 'utf8'), 'v2');

    // dst newer → keep local edits
    fs.writeFileSync(dst, 'local');
    const later = new Date(Date.now() + 120_000);
    fs.utimesSync(dst, later, later);
    mod._refreshFileIfNewer(src, dst);
    assert.equal(fs.readFileSync(dst, 'utf8'), 'local');

    // missing src → no-op
    fs.rmSync(src);
    mod._refreshFileIfNewer(src, dst);
    assert.equal(fs.readFileSync(dst, 'utf8'), 'local');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// Codex rewrites the content-hashed node_repl runtime path in the real home on
// every runtime upgrade. A stale copy made MCP startup fail with "os error 3".
test('_syncTomlSections refreshes node_repl only, preserving user settings', () => {
  withProjectSessions('project', (mod) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-toml-'));
    const src = path.join(dir, 'real.toml');
    const dst = path.join(dir, 'project.toml');
    const matches = (line: string) => /^\s*\[mcp_servers\.node_repl(\.|\])/.test(line);

    fs.writeFileSync(src, [
      'model_reasoning_effort = "medium"',
      '',
      '[mcp_servers.node_repl]',
      "command = 'C:\\rt\\NEW\\node_repl.exe'",
      '',
      '[mcp_servers.node_repl.env]',
      "NODE_REPL_NODE_PATH = 'C:\\rt\\NEW\\node.exe'",
      '',
      '[tui]',
      'theme = "dark"',
      '',
    ].join('\n'));

    fs.writeFileSync(dst, [
      'model_reasoning_effort = "xhigh"',
      '',
      '[mcp_servers.node_repl]',
      "command = 'C:\\rt\\OLD\\node_repl.exe'",
      '',
      '[mcp_servers.node_repl.env]',
      "NODE_REPL_NODE_PATH = 'C:\\rt\\OLD\\node.exe'",
      '',
      '[hooks.state]',
      'trusted = true',
      '',
    ].join('\n'));

    mod._syncTomlSections(src, dst, matches);
    const out = fs.readFileSync(dst, 'utf8');

    assert.ok(out.includes('C:\\rt\\NEW\\node_repl.exe'), 'node_repl path refreshed');
    assert.ok(out.includes('C:\\rt\\NEW\\node.exe'), 'node_repl env refreshed');
    assert.ok(!out.includes('OLD'), 'no stale runtime path remains');
    assert.ok(out.includes('model_reasoning_effort = "xhigh"'), 'user setting preserved');
    assert.ok(out.includes('[hooks.state]'), 'trailing sections preserved');
    assert.ok(!out.includes('[tui]'), 'unrelated real-home sections not imported');

    // real home dropped the section → project home must not keep a stale copy
    fs.writeFileSync(src, 'model_reasoning_effort = "medium"\n');
    mod._syncTomlSections(src, dst, matches);
    const pruned = fs.readFileSync(dst, 'utf8');
    assert.ok(!pruned.includes('node_repl'), 'stale node_repl block pruned');
    assert.ok(pruned.includes('[hooks.state]'), 'other sections survive pruning');

    fs.rmSync(dir, { recursive: true, force: true });
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
