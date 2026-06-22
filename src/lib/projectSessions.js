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

function chiefHome(cwd) {
  const root = projectSessionRoot(cwd);
  return root ? path.join(root, '.home', 'chief') : path.join(os.homedir(), '.chief');
}

function chiefSessionsDir(cwd) {
  const root = projectSessionRoot(cwd);
  return root ? path.join(root, 'chief') : path.join(chiefHome(cwd), 'sessions');
}

function kiroSessionsDir(cwd) {
  const root = projectSessionRoot(cwd);
  return root ? path.join(root, 'kiro') : path.join(os.homedir(), '.kiro', 'sessions', 'cli');
}

function antigravityBaseDir(cwd) {
  const root = projectSessionRoot(cwd);
  return root ? path.join(root, 'antigravity') : path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

// gjc (Gajae Code) stores sessions under <agentDir>/sessions/<encoded-cwd>/,
// where agentDir defaults to ~/.gjc/agent and is overridable via the
// GJC_CODING_AGENT_DIR env var (verified in gjc's CLI help). Project scope puts
// the agent dir under .agent-sessions/.home/gjc/agent and links its sessions to
// .agent-sessions/gjc, mirroring the codex/grok layout.
function gjcAgentDir(cwd) {
  const root = projectSessionRoot(cwd);
  return root ? path.join(root, '.home', 'gjc', 'agent') : path.join(os.homedir(), '.gjc', 'agent');
}

function gjcSessionsDir(cwd) {
  const root = projectSessionRoot(cwd);
  return root ? path.join(root, 'gjc') : path.join(gjcAgentDir(cwd), 'sessions');
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

// Symlink src → dst when src exists and dst is absent. Unlike _linkDirIfExists
// there is NO copy fallback — used for the macOS Keychains dir, which must be
// the LIVE keychain (a copy would be stale and would leak secrets). Best-effort.
function _symlinkDirNoCopy(src, dst) {
  try {
    if (!fs.existsSync(src) || fs.existsSync(dst)) return;
    _mkdirp(path.dirname(dst));
    fs.symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (_) {}
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
  } else if (process.platform === 'darwin') {
    // Overriding HOME hides the macOS login keychain (resolved as
    // $HOME/Library/Keychains/login.keychain-db), so an agent that stores an
    // OAuth credential there — e.g. Antigravity's `agy` — pops a blocking
    // "키체인을 발견할 수 없음 / keychain not found" dialog on every launch.
    // Symlink the real Keychains dir so the LIVE login keychain resolves under
    // the virtual HOME (auth is user-global anyway). Lives under the gitignored
    // .agent-sessions/.home, so it is never synced or committed.
    _symlinkDirNoCopy(
      path.join(os.homedir(), 'Library', 'Keychains'),
      path.join(home, 'Library', 'Keychains')
    );
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

function _prepareGjcHome(cwd) {
  const agentDir = gjcAgentDir(cwd);
  const real = path.join(os.homedir(), '.gjc', 'agent');
  const sessionsDir = gjcSessionsDir(cwd);
  _mkdirp(agentDir);
  _mkdirp(sessionsDir);
  _linkDirIfExists(sessionsDir, path.join(agentDir, 'sessions'));
  // gjc honors GJC_CODING_AGENT_DIR directly, so no HOME/USERPROFILE
  // virtualization is needed. Copy gjc's config + auth/state SQLite DBs so the
  // project agent dir runs standalone (credentials can be re-imported if they
  // rotate). The -shm/-wal sidecars are copied alongside each DB so an open
  // WAL transaction isn't left dangling.
  for (const file of [
    'config.yml',
    'agent.db', 'agent.db-shm', 'agent.db-wal',
    'history.db', 'history.db-shm', 'history.db-wal',
    'models.db', 'models.db-shm', 'models.db-wal',
  ]) {
    _copyFileIfExists(path.join(real, file), path.join(agentDir, file));
  }
  return agentDir;
}

function _prepareChiefHome(cwd) {
  const paths = getChiefPaths(cwd);
  _mkdirp(paths.home);
  _mkdirp(paths.sessionsDir);
  return paths.home;
}

function _getConfigValue(key, fallback) {
  try {
    const vscode = require('vscode');
    return vscode.workspace
      .getConfiguration('claudeCodeLauncher')
      .get(key, fallback);
  } catch (_) {
    return fallback;
  }
}

function _getExplicitConfigValue(key) {
  try {
    const vscode = require('vscode');
    const inspected = vscode.workspace
      .getConfiguration('claudeCodeLauncher')
      .inspect(key);
    if (!inspected) return undefined;
    for (const k of ['workspaceFolderValue', 'workspaceValue', 'globalValue']) {
      if (inspected[k] !== undefined) return inspected[k];
    }
  } catch (_) {}
  return undefined;
}

function _applyChiefEnvironment(env, cwd) {
  const paths = getChiefPaths(cwd);
  env.CHIEF_SESSIONS_DIR = paths.sessionsDir;

  const apiKey = _getExplicitConfigValue('chief.apiKey') || _getConfigValue('chief.apiKey', '');
  const projectId = _getExplicitConfigValue('chief.projectId') || _getConfigValue('chief.projectId', '');
  const baseUrl = _getExplicitConfigValue('chief.baseUrl');
  const intelligence = _getExplicitConfigValue('chief.intelligence');
  const provider = _getExplicitConfigValue('chief.provider');
  const profile = _getExplicitConfigValue('chief.profile');

  if (apiKey) env.CHIEF_API_KEY = apiKey;
  if (projectId) env.CHIEF_PROJECT_ID = projectId;
  env.CHIEF_BASE_URL = baseUrl || env.CHIEF_BASE_URL || 'https://api.storytell.ai';
  env.CHIEF_INTELLIGENCE = intelligence || env.CHIEF_INTELLIGENCE || 'auto';
  env.CHIEF_PROVIDER = provider || env.CHIEF_PROVIDER || 'automatic';
  env.CHIEF_PROFILE = profile || env.CHIEF_PROFILE || 'general';
}

function prepareProjectSessionEnvironment(agent, cwd, baseEnv) {
  const env = { ...(baseEnv || process.env) };
  if (agent === 'chief') {
    try {
      _prepareChiefHome(cwd);
      _applyChiefEnvironment(env, cwd);
    } catch (_) {}
    return env;
  }
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
    } else if (agent === 'gjc') {
      env.GJC_CODING_AGENT_DIR = _prepareGjcHome(cwd);
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

function getGjcPaths(cwd) {
  if (isProjectSessionStorageEnabled() && projectSessionRoot(cwd)) {
    return { agentDir: gjcAgentDir(cwd), sessionsDir: gjcSessionsDir(cwd) };
  }
  const agentDir = path.join(os.homedir(), '.gjc', 'agent');
  return { agentDir, sessionsDir: path.join(agentDir, 'sessions') };
}

function getChiefPaths(cwd) {
  if (isProjectSessionStorageEnabled() && projectSessionRoot(cwd)) {
    return { home: chiefHome(cwd), sessionsDir: chiefSessionsDir(cwd) };
  }
  const home = path.join(os.homedir(), '.chief');
  return { home, sessionsDir: path.join(home, 'sessions') };
}

function getChiefSessionsDir(cwd) {
  return getChiefPaths(cwd).sessionsDir;
}

module.exports = {
  isProjectSessionStorageEnabled,
  projectSessionRoot,
  codexHome,
  codexSessionsDir,
  codexIndexFile,
  grokHome,
  grokSessionsDir,
  chiefHome,
  chiefSessionsDir,
  kiroSessionsDir,
  antigravityBaseDir,
  gjcAgentDir,
  gjcSessionsDir,
  prepareProjectSessionEnvironment,
  getCodexPaths,
  getKiroSessionsDir,
  getAntigravityBaseDir,
  getGrokPaths,
  getGrokSessionsDir,
  getGjcPaths,
  getChiefPaths,
  getChiefSessionsDir,
};
