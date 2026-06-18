// @module lib/projectSessions — project-scoped session storage paths/env.
//
// Agent CLIs mostly store sessions under a user-global home directory. That is
// convenient until the home session folder is a OneDrive junction: large jsonl
// appends + live sync + reader polling can freeze the launcher. Project scope
// keeps each workspace's sessions under <workspace>/.agent-sessions while
// leaving auth/config in the real user profile.

const fs = require('fs');
const os = require('os');
const path = require('path');

function _getConfigScope() {
  try {
    // Lazy require so unit tests can load this module outside VS Code.
    const vscode = require('vscode');
    return vscode.workspace
      .getConfiguration('claudeCodeLauncher')
      .get('sessionStorage.scope', 'global');
  } catch (_) {
    return 'global';
  }
}

function isProjectSessionStorageEnabled() {
  return _getConfigScope() === 'project';
}

function _safeCwd(cwd) {
  return cwd && typeof cwd === 'string' ? cwd : null;
}

function projectSessionRoot(cwd) {
  const root = _safeCwd(cwd);
  return root ? path.join(root, '.agent-sessions') : null;
}

function codexHome(cwd) {
  const root = projectSessionRoot(cwd);
  return root ? path.join(root, '.home', 'codex') : path.join(os.homedir(), '.codex');
}

function codexSessionsDir(cwd) {
  const root = projectSessionRoot(cwd);
  return root ? path.join(root, 'codex') : path.join(codexHome(cwd), 'sessions');
}

function codexIndexFile(cwd) {
  return path.join(codexHome(cwd), 'session_index.jsonl');
}

function grokHome(cwd) {
  const root = projectSessionRoot(cwd);
  return root ? path.join(root, '.home', 'grok') : path.join(os.homedir(), '.grok');
}

function grokSessionsDir(cwd) {
  const root = projectSessionRoot(cwd);
  return root ? path.join(root, 'grok') : path.join(grokHome(cwd), 'sessions');
}

function kiroSessionsDir(cwd) {
  const root = projectSessionRoot(cwd);
  return root ? path.join(root, 'kiro') : path.join(os.homedir(), '.kiro', 'sessions', 'cli');
}

function antigravityBaseDir(cwd) {
  const root = projectSessionRoot(cwd);
  return root ? path.join(root, 'antigravity') : path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

function _mkdirp(p) {
  if (p) fs.mkdirSync(p, { recursive: true });
}

function _copyFileIfExists(src, dst) {
  try {
    if (!fs.existsSync(src) || fs.existsSync(dst)) return;
    _mkdirp(path.dirname(dst));
    fs.copyFileSync(src, dst);
  } catch (_) {}
}

function _linkDirIfExists(src, dst) {
  try {
    if (!fs.existsSync(src) || fs.existsSync(dst)) return;
    _mkdirp(path.dirname(dst));
    const type = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(src, dst, type);
  } catch (_) {
    // Fall back to a shallow directory copy only for tiny config dirs. Large
    // caches/binaries are intentionally not copied here.
    try {
      if (!fs.existsSync(dst)) fs.cpSync(src, dst, { recursive: true, force: false });
    } catch (__) {}
  }
}

function _prepareCodexHome(cwd) {
  const home = codexHome(cwd);
  const real = path.join(os.homedir(), '.codex');
  const sessionsDir = codexSessionsDir(cwd);
  _mkdirp(home);
  _mkdirp(sessionsDir);
  _linkDirIfExists(sessionsDir, path.join(home, 'sessions'));
  // Auth/config stay user-global in spirit. Copy files so the project home can
  // run independently; users can delete/regenerate if credentials rotate.
  for (const file of ['auth.json', 'config.toml', 'AGENTS.md', 'hooks.json', 'installation_id']) {
    _copyFileIfExists(path.join(real, file), path.join(home, file));
  }
  // Reuse installed Codex surfaces without duplicating plugin/package payloads.
  for (const dir of ['agents', 'skills', 'prompts', 'plugins', 'hooks', 'packages']) {
    _linkDirIfExists(path.join(real, dir), path.join(home, dir));
  }
  return home;
}

function _setVirtualHome(env, home) {
  env.HOME = home;
  env.USERPROFILE = home;
  if (process.platform === 'win32') {
    const root = path.parse(home).root.replace(/[\\/]$/, '');
    env.HOMEDRIVE = root;
    env.HOMEPATH = home.slice(root.length) || '\\';
    env.APPDATA = path.join(home, 'AppData', 'Roaming');
    env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
    _mkdirp(env.APPDATA);
    _mkdirp(env.LOCALAPPDATA);
  }
}

function _prepareKiroHome(cwd) {
  const root = projectSessionRoot(cwd);
  const home = path.join(root, '.home', 'kiro');
  const realKiro = path.join(os.homedir(), '.kiro');
  const virtualKiro = path.join(home, '.kiro');
  const cliDir = kiroSessionsDir(cwd);
  _mkdirp(cliDir);
  _mkdirp(path.join(virtualKiro, 'sessions'));
  _linkDirIfExists(cliDir, path.join(virtualKiro, 'sessions', 'cli'));
  for (const dir of ['settings', 'extensions', 'powers', 'skills', 'steering']) {
    _linkDirIfExists(path.join(realKiro, dir), path.join(virtualKiro, dir));
  }
  _copyFileIfExists(path.join(realKiro, 'argv.json'), path.join(virtualKiro, 'argv.json'));

  if (process.platform === 'win32') {
    const realLocal = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    _linkDirIfExists(path.join(realLocal, 'kiro-cli'), path.join(home, 'AppData', 'Local', 'kiro-cli'));
  }
  return home;
}

function _prepareAntigravityHome(cwd) {
  const root = projectSessionRoot(cwd);
  const home = path.join(root, '.home', 'antigravity');
  const realGemini = path.join(os.homedir(), '.gemini');
  const virtualGemini = path.join(home, '.gemini');
  _mkdirp(virtualGemini);
  _mkdirp(antigravityBaseDir(cwd));
  _linkDirIfExists(path.join(realGemini, 'config'), path.join(virtualGemini, 'config'));
  _linkDirIfExists(antigravityBaseDir(cwd), path.join(virtualGemini, 'antigravity-cli'));
  return home;
}

function _prepareGrokHome(cwd) {
  const home = grokHome(cwd);
  const real = path.join(os.homedir(), '.grok');
  const sessionsDir = grokSessionsDir(cwd);
  _mkdirp(home);
  _mkdirp(sessionsDir);
  _linkDirIfExists(sessionsDir, path.join(home, 'sessions'));
  // Grok honors GROK_HOME directly, so unlike Kiro no HOME/USERPROFILE
  // virtualization is needed. Copy lightweight config/auth metadata and link
  // reusable surfaces so the project home stays small.
  for (const file of ['auth.json', 'config.toml', 'active_sessions.json']) {
    _copyFileIfExists(path.join(real, file), path.join(home, file));
  }
  for (const dir of ['agents', 'skills', 'prompts', 'plugins', 'hooks', 'docs']) {
    _linkDirIfExists(path.join(real, dir), path.join(home, dir));
  }
  return home;
}

function prepareProjectSessionEnvironment(agent, cwd, baseEnv) {
  const env = { ...(baseEnv || process.env) };
  if (!isProjectSessionStorageEnabled() || !projectSessionRoot(cwd)) return env;
  try {
    if (agent === 'codex') {
      env.CODEX_HOME = _prepareCodexHome(cwd);
    } else if (agent === 'kiro') {
      const kiroHome = _prepareKiroHome(cwd);
      _setVirtualHome(env, kiroHome);
      // Windows: kiro-cli resolves its session dir via SHGetKnownFolderPath and
      // ignores HOME/USERPROFILE, so point it at the virtual .kiro explicitly.
      env.KIRO_HOME = path.join(kiroHome, '.kiro');
    } else if (agent === 'antigravity') {
      _setVirtualHome(env, _prepareAntigravityHome(cwd));
    } else if (agent === 'grok') {
      env.GROK_HOME = _prepareGrokHome(cwd);
    }
  } catch (_) {}
  return env;
}

function getCodexPaths(cwd) {
  if (isProjectSessionStorageEnabled() && projectSessionRoot(cwd)) {
    return { home: codexHome(cwd), sessionsDir: codexSessionsDir(cwd), indexFile: codexIndexFile(cwd) };
  }
  const home = path.join(os.homedir(), '.codex');
  return { home, sessionsDir: path.join(home, 'sessions'), indexFile: path.join(home, 'session_index.jsonl') };
}

function getKiroSessionsDir(cwd) {
  return isProjectSessionStorageEnabled() && projectSessionRoot(cwd)
    ? kiroSessionsDir(cwd)
    : path.join(os.homedir(), '.kiro', 'sessions', 'cli');
}

function getAntigravityBaseDir(cwd) {
  return isProjectSessionStorageEnabled() && projectSessionRoot(cwd)
    ? antigravityBaseDir(cwd)
    : path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

function getGrokPaths(cwd) {
  if (isProjectSessionStorageEnabled() && projectSessionRoot(cwd)) {
    return { home: grokHome(cwd), sessionsDir: grokSessionsDir(cwd) };
  }
  const home = path.join(os.homedir(), '.grok');
  return { home, sessionsDir: path.join(home, 'sessions') };
}

function getGrokSessionsDir(cwd) {
  return getGrokPaths(cwd).sessionsDir;
}

module.exports = {
  isProjectSessionStorageEnabled,
  projectSessionRoot,
  codexHome,
  codexSessionsDir,
  codexIndexFile,
  grokHome,
  grokSessionsDir,
  kiroSessionsDir,
  antigravityBaseDir,
  prepareProjectSessionEnvironment,
  getCodexPaths,
  getKiroSessionsDir,
  getAntigravityBaseDir,
  getGrokPaths,
  getGrokSessionsDir,
};
