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
    assert.equal(fs.existsSync(path.join(gjc.GJC_CODING_AGENT_DIR, 'sessions')), true);

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

// ── Claude session link self-heal (cross-device Mac↔Windows sync) ───────────
// Claude Code always writes to ~/.claude/projects/<encoded-cwd>; the vault-git
// sync model needs that folder linked into <ws>/.agent-sessions/claude.
// ensureClaudeSessionLink() repairs the link on launch so both machines share
// sessions. We patch the real os singleton so we never touch the real ~/.claude.
function withFakeHome(fakeHome: string, fn: () => void) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const osReq = require('os');
  const orig = osReq.homedir;
  osReq.homedir = () => fakeHome;
  try { fn(); } finally { osReq.homedir = orig; }
}

test('claudeProjectFolderName matches Claude Code cwd encoding', () => {
  withProjectSessions('project', (mod) => {
    assert.equal(mod.claudeProjectFolderName("c:\\obsidian\\Won's 2nd Brain"), 'c--obsidian-Won-s-2nd-Brain');
    assert.equal(mod.claudeProjectFolderName("/Users/rockuen/obsidian/Won's 2nd Brain"), '-Users-rockuen-obsidian-Won-s-2nd-Brain');
  });
});

test('ensureClaudeSessionLink creates the link, then is idempotent', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ws-'));
  withFakeHome(fakeHome, () => {
    withProjectSessions('project', (mod) => {
      const target = path.join(cwd, '.agent-sessions', 'claude');
      const linkPath = mod.claudeProjectLinkPath(cwd);

      const r1 = mod.ensureClaudeSessionLink(cwd);
      assert.equal(r1.state, 'created');
      assert.equal(fs.existsSync(target), true);
      assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
      assert.equal(fs.realpathSync(linkPath), fs.realpathSync(target));

      const r2 = mod.ensureClaudeSessionLink(cwd);
      assert.equal(r2.state, 'ok');
      assert.equal(r2.changed, false);
    });
  });
  fs.rmSync(fakeHome, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('ensureClaudeSessionLink rescues a pre-link REAL dir into the vault', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ws-'));
  withFakeHome(fakeHome, () => {
    withProjectSessions('project', (mod) => {
      const target = path.join(cwd, '.agent-sessions', 'claude');
      const linkPath = mod.claudeProjectLinkPath(cwd);
      // Claude wrote a session into a REAL projects dir before any link existed.
      fs.mkdirSync(linkPath, { recursive: true });
      fs.writeFileSync(path.join(linkPath, 'mac-session.jsonl'), '{"cwd":"x"}\n');

      const r = mod.ensureClaudeSessionLink(cwd);
      assert.equal(r.state, 'relinked-realdir');
      // session migrated into the git-tracked vault (no data loss)
      assert.equal(fs.existsSync(path.join(target, 'mac-session.jsonl')), true);
      // link path is now a symlink → vault
      assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
      assert.equal(fs.realpathSync(linkPath), fs.realpathSync(target));
      // original dir preserved as a backup (never destructively deleted)
      const backups = fs.readdirSync(path.dirname(linkPath)).filter((n) => n.includes('.pre-link-'));
      assert.equal(backups.length >= 1, true);
    });
  });
  fs.rmSync(fakeHome, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('ensureClaudeSessionLink repairs a foreign (OneDrive-style) link', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ws-'));
  const oneDrive = fs.mkdtempSync(path.join(os.tmpdir(), 'onedrive-claude-'));
  fs.writeFileSync(path.join(oneDrive, 'foreign.jsonl'), '{"cwd":"y"}\n');
  withFakeHome(fakeHome, () => {
    withProjectSessions('project', (mod) => {
      const target = path.join(cwd, '.agent-sessions', 'claude');
      const linkPath = mod.claudeProjectLinkPath(cwd);
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      fs.symlinkSync(oneDrive, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

      const r = mod.ensureClaudeSessionLink(cwd);
      assert.equal(r.state, 'relinked-foreign');
      // foreign-only session rescued into the vault before relinking
      assert.equal(fs.existsSync(path.join(target, 'foreign.jsonl')), true);
      assert.equal(fs.realpathSync(linkPath), fs.realpathSync(target));
    });
  });
  fs.rmSync(fakeHome, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(oneDrive, { recursive: true, force: true });
});

test('prepareProjectSessionEnvironment routes the Claude project link on launch', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ws-'));
  withFakeHome(fakeHome, () => {
    withProjectSessions('project', (mod) => {
      const env = mod.prepareProjectSessionEnvironment('claude', cwd, { KEEP: '1' });
      assert.equal(env.KEEP, '1'); // claude needs no env relocation
      const linkPath = mod.claudeProjectLinkPath(cwd);
      const target = path.join(cwd, '.agent-sessions', 'claude');
      assert.equal(fs.existsSync(linkPath), true, 'launching claude creates the project link');
      assert.equal(fs.realpathSync(linkPath), fs.realpathSync(target));
    });
  });
  fs.rmSync(fakeHome, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});
