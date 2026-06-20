// @module pty/resolveCli — locates the Claude / Kiro CLI binaries across install methods.
// Priority: ~/.local/bin (official standalone) → npm global / known install dir → PATH.
//
// IMPORTANT (Windows): node-pty's winpty/conpty does NOT search PATH — it needs an
// ABSOLUTE path to the executable. Returning a bare command name (e.g. 'kiro-cli.exe')
// passes a child_process `--version` probe (Node resolves it via PATH) but then fails
// inside node-pty with "File not found". So every resolver must return an absolute path
// on Windows; bare names are resolved to absolute paths via `where.exe`.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

// Resolve a bare command name to a spawnable shell value.
//   Windows → `where.exe <name>`, returns the first (PATH-order) absolute hit, or null.
//   Unix    → verify it runs (`<name> --version`), return the bare name (execvp searches PATH).
function resolveOnPath(name) {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('where.exe', [name], { timeout: 1500 }).toString();
      const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (first && fs.existsSync(first)) return first;
    } catch (_) {}
    return null;
  }
  try {
    execFileSync(name, ['--version'], { timeout: 1500, stdio: 'ignore' });
    return name;
  } catch (_) {
    return null;
  }
}

function resolveClaudeCli() {
  const isWin = process.platform === 'win32';

  // 1) ~/.local/bin/claude(.exe) — official standalone install
  const localBin = isWin
    ? path.join(os.homedir(), '.local', 'bin', 'claude.exe')
    : path.join(os.homedir(), '.local', 'bin', 'claude');
  if (fs.existsSync(localBin)) return { shell: localBin, args: [] };

  // 2) npm global install — Windows needs cmd.exe /c wrapper for .cmd shims
  if (isWin) {
    const npmCli = path.join(process.env.APPDATA || '', 'npm', 'claude.cmd');
    if (fs.existsSync(npmCli)) return { shell: 'cmd.exe', args: ['/c', 'claude'] };
  }

  // 3) PATH — resolved to an absolute path on Windows (node-pty needs it)
  const onPath = resolveOnPath('claude');
  if (onPath) return { shell: onPath, args: [] };
  return null;
}

// @module pty/resolveCli — locates the Kiro CLI binary.
// Priority: ~/.local/bin/kiro-cli → %LOCALAPPDATA%\Kiro-Cli (Windows installer) → PATH.
function resolveKiroCli() {
  const isWin = process.platform === 'win32';

  // 1) ~/.local/bin/kiro-cli(.exe) — official standalone install (macOS/Linux)
  const localBin = isWin
    ? path.join(os.homedir(), '.local', 'bin', 'kiro-cli.exe')
    : path.join(os.homedir(), '.local', 'bin', 'kiro-cli');
  if (fs.existsSync(localBin)) return { shell: localBin, args: [] };

  // 2) Windows installer location: %LOCALAPPDATA%\Kiro-Cli\kiro-cli.exe
  if (isWin) {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const winInstall = path.join(localAppData, 'Kiro-Cli', 'kiro-cli.exe');
    if (fs.existsSync(winInstall)) return { shell: winInstall, args: [] };
  }

  // 3) PATH — resolved to an absolute path on Windows (node-pty needs it)
  const onPath = resolveOnPath('kiro-cli');
  if (onPath) return { shell: onPath, args: [] };
  return null;
}

// @module pty/resolveCli — locates the Antigravity CLI (agy) binary.
// Priority: ~/.local/bin/agy → %LOCALAPPDATA%\agy\bin (Windows installer) → PATH.
function resolveAntigravityCli() {
  const isWin = process.platform === 'win32';

  // 1) ~/.local/bin/agy(.exe) — standalone install (macOS/Linux; some Windows)
  const localBin = isWin
    ? path.join(os.homedir(), '.local', 'bin', 'agy.exe')
    : path.join(os.homedir(), '.local', 'bin', 'agy');
  if (fs.existsSync(localBin)) return { shell: localBin, args: [] };

  // 2) Windows installer location: %LOCALAPPDATA%\agy\bin\agy.exe (verified)
  if (isWin) {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const winInstall = path.join(localAppData, 'agy', 'bin', 'agy.exe');
    if (fs.existsSync(winInstall)) return { shell: winInstall, args: [] };
  }

  // 3) PATH — resolved to an absolute path on Windows (node-pty needs it)
  const onPath = resolveOnPath('agy');
  if (onPath) return { shell: onPath, args: [] };
  return null;
}

// @module pty/resolveCli — locates the OpenAI Codex CLI binary.
// Priority: ~/.local/bin/codex → %LOCALAPPDATA%\Programs\OpenAI\Codex\bin (Windows installer) → PATH.
function resolveCodexCli() {
  const isWin = process.platform === 'win32';

  // 1) ~/.local/bin/codex(.exe) — official install script (macOS/Linux)
  const localBin = isWin
    ? path.join(os.homedir(), '.local', 'bin', 'codex.exe')
    : path.join(os.homedir(), '.local', 'bin', 'codex');
  if (fs.existsSync(localBin)) return { shell: localBin, args: [] };

  // 2) Windows installer location: %LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe (verified)
  if (isWin) {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const winInstall = path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
    if (fs.existsSync(winInstall)) return { shell: winInstall, args: [] };
  }

  // 3) PATH — resolved to an absolute path on Windows (node-pty needs it)
  const onPath = resolveOnPath('codex');
  if (onPath) return { shell: onPath, args: [] };
  return null;
}

// @module pty/resolveCli — locates xAI's Grok CLI (grok) binary.
// Priority: ~/.grok/bin/grok (official grok build) → ~/.local/bin/grok → PATH.
function resolveGrokCli() {
  const isWin = process.platform === 'win32';

  // 1) ~/.grok/bin/grok(.exe) — official installer location (verified on Windows).
  const grokHomeBin = isWin
    ? path.join(os.homedir(), '.grok', 'bin', 'grok.exe')
    : path.join(os.homedir(), '.grok', 'bin', 'grok');
  if (fs.existsSync(grokHomeBin)) return { shell: grokHomeBin, args: [] };

  // 2) ~/.local/bin/grok(.exe) — standalone/PATH-style install location.
  const localBin = isWin
    ? path.join(os.homedir(), '.local', 'bin', 'grok.exe')
    : path.join(os.homedir(), '.local', 'bin', 'grok');
  if (fs.existsSync(localBin)) return { shell: localBin, args: [] };

  // 3) PATH — resolved to an absolute path on Windows (node-pty needs it).
  const onPath = resolveOnPath('grok');
  if (onPath) return { shell: onPath, args: [] };
  return null;
}

// @module pty/resolveCli — locates the Gajae Code CLI (gjc) binary.
// gjc ships as the `gajae-code` npm package installed via Bun, so its bin lives
// in the Bun global bin dir (NOT npm). Priority: ~/.bun/bin/gjc(.exe) (bun
// global install — verified on Windows: gjc.exe present) → ~/.local/bin/gjc →
// PATH. Requires Bun ≥ 1.3.14 to run, but that's gjc's own runtime concern; the
// launcher only needs the absolute binary path for node-pty.
function resolveGjcCli() {
  const isWin = process.platform === 'win32';

  // 1) ~/.bun/bin/gjc(.exe) — bun global install (gajae-code package).
  const bunBin = isWin
    ? path.join(os.homedir(), '.bun', 'bin', 'gjc.exe')
    : path.join(os.homedir(), '.bun', 'bin', 'gjc');
  if (fs.existsSync(bunBin)) return { shell: bunBin, args: [] };

  // 2) ~/.local/bin/gjc(.exe) — alternate standalone location.
  const localBin = isWin
    ? path.join(os.homedir(), '.local', 'bin', 'gjc.exe')
    : path.join(os.homedir(), '.local', 'bin', 'gjc');
  if (fs.existsSync(localBin)) return { shell: localBin, args: [] };

  // 3) PATH — resolved to an absolute path on Windows (node-pty needs it).
  const onPath = resolveOnPath('gjc');
  if (onPath) return { shell: onPath, args: [] };
  return null;
}

function _resolveChiefReplPath() {
  const candidates = [
    path.join(__dirname, '..', '..', 'bin', 'chief-repl.js'),
    path.join(process.cwd(), 'bin', 'chief-repl.js'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}
function _resolveNodeRuntime() {
  const own = path.basename(process.execPath || '').toLowerCase();
  if (own === 'node.exe' || own === 'node') return process.execPath;

  const onPath = resolveOnPath('node');
  if (onPath) return onPath;

  if (process.platform === 'win32') {
    const programFiles = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
    ].filter(Boolean);
    for (const root of programFiles) {
      const candidate = path.join(root, 'nodejs', 'node.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return null;
}


// @module pty/resolveCli — locates the bundled Chief REPL wrapper.
//
// Chief is a REST service, not an external TUI CLI. Treat the bundled wrapper as
// "installed" even before credentials are configured, so the Settings UI can
// expose Chief and let the user enter claudeCodeLauncher.chief.* values.
//
// VS Code / VSCodium extension hosts run on Electron. process.execPath points at
// the GUI app executable there; launching that through node-pty silently exits on
// Windows instead of running the script. Chief's bundled wrapper is plain Node, so
// prefer a real node runtime. The Electron fallback is kept for non-PTY probes,
// but normal launcher installs should resolve node from PATH or Program Files.
function isChiefCliAvailable() {
  return !!(_resolveChiefReplPath() && (_resolveNodeRuntime() || process.execPath));
}

function resolveChiefCli() {
  const repl = _resolveChiefReplPath();
  if (!repl) return null;
  const nodeRuntime = _resolveNodeRuntime();
  if (nodeRuntime) {
    return { shell: nodeRuntime, args: [repl], env: {} };
  }
  return {
    shell: process.execPath,
    args: [repl],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

module.exports = { resolveClaudeCli, resolveKiroCli, resolveAntigravityCli, resolveCodexCli, resolveGrokCli, resolveGjcCli, resolveChiefCli, isChiefCliAvailable };
