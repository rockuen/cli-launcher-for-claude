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

// gjc (Gajae Code) stores sessions under <agentDir>/sessions/, where agentDir
// defaults to ~/.gjc/agent and is overridable via the GJC_CODING_AGENT_DIR env
// var (verified in gjc's CLI help). Project scope puts the agent dir under
// .agent-sessions/.home/gjc/agent. Unlike codex/grok, the sessions dir stays
// physically inside the agent dir: gjc's managed-session security (>= 0.11.6)
// refuses a symlinked/junctioned sessions root ("The sessions root is not a
// safe directory"), so the old redirect link to .agent-sessions/gjc is dead.
function gjcAgentDir(cwd) {
  const root = projectSessionRoot(cwd);
  return root ? path.join(root, '.home', 'gjc', 'agent') : path.join(os.homedir(), '.gjc', 'agent');
}

function gjcSessionsDir(cwd) {
  return path.join(gjcAgentDir(cwd), 'sessions');
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

// Copy src → dst when src is strictly newer. Used for credentials, which rotate:
// a one-time seed pins whatever token existed at seed time, so re-logging in
// against the real home leaves the project home holding a revoked refresh token.
function _refreshFileIfNewer(src, dst) {
  try {
    if (!fs.existsSync(src)) return;
    if (!fs.existsSync(dst)) {
      _mkdirp(path.dirname(dst));
      fs.copyFileSync(src, dst);
      return;
    }
    if (fs.statSync(src).mtimeMs > fs.statSync(dst).mtimeMs) fs.copyFileSync(src, dst);
  } catch (_) {}
}

// Locate the contiguous run of TOML sections whose headers match `matches`.
// Returns null when no such section exists.
function _tomlSectionRange(lines, matches) {
  const isHeader = (l) => /^\s*\[/.test(l);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (matches(lines[i])) { start = i; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isHeader(lines[i]) && !matches(lines[i])) { end = i; break; }
  }
  while (end > start && lines[end - 1].trim() === '') end--;
  return { start, end };
}

// Mirror the `matches` sections of src into dst, leaving every other section
// alone. Codex caches machine-local runtime state in config.toml — the
// node_repl binary path is under a content-hashed runtime dir — and rewrites it
// in the real home on each runtime upgrade. A project home seeded once never
// sees those rewrites, so its stale path makes MCP startup fail with
// "os error 3". Syncing only these sections keeps the user's own settings
// (model, notify, hooks.state) intact.
function _syncTomlSections(src, dst, matches) {
  try {
    if (!fs.existsSync(dst)) return;
    const dstLines = fs.readFileSync(dst, 'utf8').split(/\r?\n/);
    let srcBlock = [];
    if (fs.existsSync(src)) {
      const srcLines = fs.readFileSync(src, 'utf8').split(/\r?\n/);
      const srcRange = _tomlSectionRange(srcLines, matches);
      if (srcRange) srcBlock = srcLines.slice(srcRange.start, srcRange.end);
    }
    const dstRange = _tomlSectionRange(dstLines, matches);
    let out;
    if (dstRange) {
      out = [...dstLines.slice(0, dstRange.start), ...srcBlock, ...dstLines.slice(dstRange.end)];
    } else if (srcBlock.length) {
      out = [...dstLines, '', ...srcBlock];
    } else {
      return;
    }
    const next = out.join('\n');
    if (next !== dstLines.join('\n')) fs.writeFileSync(dst, next);
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
  for (const file of ['config.toml', 'AGENTS.md', 'hooks.json', 'installation_id']) {
    _copyFileIfExists(path.join(real, file), path.join(home, file));
  }
  // Credentials must track the real home, or a re-login there strands the
  // project home on a revoked refresh token (401 token_expired).
  _refreshFileIfNewer(path.join(real, 'auth.json'), path.join(home, 'auth.json'));
  // Keep Codex's machine-local runtime cache current; see _syncTomlSections.
  _syncTomlSections(
    path.join(real, 'config.toml'),
    path.join(home, 'config.toml'),
    (line) => /^\s*\[mcp_servers\.node_repl(\.|\])/.test(line)
  );
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

// gjc's managed-session write protocol (>= 0.11.6) verifies the sessions root
// is owner-only before creating a session: on Windows a protected DACL whose
// only ACE is the current user (owner_mismatch otherwise), on POSIX mode 0700
// (mode_mismatch otherwise). ~/.gjc/agent/sessions gets that shape from gjc
// itself, but a launcher-created project dir inherits the workspace ACL/umask,
// so re-assert it here. Verified against gjc 0.11.6's resolve+prepare on a
// real workspace: junction removal alone still failed with owner_mismatch;
// with the protected single-ACE DACL, prepare succeeds.
function _ownerOnlySync(target, recursive) {
  if (process.platform === 'win32') {
    // No \\?\ prefix: icacls /reset rejects it (verified — 0 files processed).
    // Paths beyond MAX_PATH fail per-item and /C skips them; such entries keep
    // their old (readable) ACLs, which gjc does not verify below the root.
    const icacls = (args, timeout) => {
      try {
        require('child_process').execFileSync('icacls', args, { stdio: 'ignore', windowsHide: true, timeout });
      } catch (_) {}
    };
    // Protect the root: drop inherited ACEs, grant only the current user.
    icacls([target, '/inheritance:r', '/grant:r', `${os.userInfo().username}:(OI)(CI)F`, '/Q'], 15000);
    if (recursive) {
      // Children must NOT get the (OI)(CI) grant directly — icacls applied to
      // a FILE with those flags leaves it inaccessible (EPERM). /reset makes
      // the subtree re-inherit from the root's single-ACE DACL instead.
      // Bounded per entry: normalization is best-effort (moved payload stays
      // readable either way) and must not stall panel spawn on huge trees.
      let entries = [];
      try { entries = fs.readdirSync(target); } catch (_) {}
      for (const entry of entries) {
        icacls([path.join(target, entry), '/reset', '/T', '/C', '/Q'], 30000);
      }
    }
    return;
  }
  const walk = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch (_) { return; }
    if (st.isSymbolicLink()) return;
    try { fs.chmodSync(p, st.isDirectory() ? 0o700 : 0o600); } catch (_) {}
    if (!recursive || !st.isDirectory()) return;
    let entries;
    try { entries = fs.readdirSync(p); } catch (_) { return; }
    for (const e of entries) walk(path.join(p, e));
  };
  walk(target);
}

// Until v3.20.4 the gjc project layout linked <agentDir>/sessions to
// .agent-sessions/gjc (like codex/grok). gjc >= 0.11.6 refuses to create
// sessions behind that link ("The sessions root is not a safe directory"), so
// it must become a real directory. Drop the link and pull the legacy payload
// into the real sessions dir so history/resume keep working. Best-effort per
// entry: anything held open by a live session stays behind and is retried on
// the next launch. Returns whether any payload moved (callers then normalize
// the moved tree's security once).
function _absorbLegacyGjcSessions(cwd, sessionsDir) {
  const root = projectSessionRoot(cwd);
  if (!root) return false;
  try {
    if (fs.lstatSync(sessionsDir).isSymbolicLink()) {
      try { fs.rmdirSync(sessionsDir); } catch (_) { fs.unlinkSync(sessionsDir); }
    }
  } catch (_) {}
  const legacyDir = path.join(root, 'gjc');
  let entries;
  try {
    const st = fs.lstatSync(legacyDir);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    entries = fs.readdirSync(legacyDir);
  } catch (_) { return false; }
  _mkdirp(sessionsDir);
  let clean = true;
  let moved = false;
  for (const entry of entries) {
    try {
      if (fs.existsSync(path.join(sessionsDir, entry))) { clean = false; continue; }
      fs.renameSync(path.join(legacyDir, entry), path.join(sessionsDir, entry));
      moved = true;
    } catch (_) { clean = false; }
  }
  try { if (clean) fs.rmdirSync(legacyDir); } catch (_) {}
  return moved;
}

function _prepareGjcHome(cwd) {
  const agentDir = gjcAgentDir(cwd);
  const real = path.join(os.homedir(), '.gjc', 'agent');
  const sessionsDir = gjcSessionsDir(cwd);
  _mkdirp(agentDir);
  const migrated = _absorbLegacyGjcSessions(cwd, sessionsDir);
  _mkdirp(sessionsDir);
  // Root every launch (cheap, idempotent — gjc verifies only the root; its own
  // scope dirs are created with the right security). Recursive only right
  // after a migration, so absorbed legacy payload is normalized once.
  _ownerOnlySync(sessionsDir, migrated);
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
  _refreshFileIfNewer,
  _syncTomlSections,
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
