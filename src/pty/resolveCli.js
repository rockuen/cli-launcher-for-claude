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

module.exports = { resolveClaudeCli, resolveKiroCli, resolveAntigravityCli };
