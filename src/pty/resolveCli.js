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

// Android (VSCodroid): SELinux refuses execve() of anything under the app's
// filesDir, so the CLIs a user has there -- `claude` included -- are bash
// functions that hand the real binary to a loader, not files on PATH. A binary
// under ~/.local/bin cannot run at all, and `<name> --version` finds nothing.
// Ask the shell instead (the app's BASH_ENV defines those functions for
// non-interactive shells too) and launch through it: callers append their own
// args after these, and the function receives them as "$@".
//
// Probes are cached briefly: listAgents() runs all six resolvers and activation
// calls it several times, which on a phone was dozens of blocking bash startups
// in a row. 30s still picks up a CLI installed mid-session without a reload.
const SHELL_PROBE_TTL_MS = 30000;
const _shellProbes = new Map();
function resolveViaShell(name) {
  const shell = process.env.SHELL || 'bash';
  const key = shell + '\0' + name;
  let probe = _shellProbes.get(key);
  if (!probe || Date.now() - probe.at >= SHELL_PROBE_TTL_MS) {
    let found = false;
    try {
      execFileSync(shell, ['-c', 'command -v "$1" >/dev/null', 'probe', name], { timeout: 3000, stdio: 'ignore' });
      found = true;
    } catch (_) {}
    probe = { at: Date.now(), found };
    _shellProbes.set(key, probe);
  }
  return probe.found ? { shell, args: ['-c', `${name} "$@"`, name] } : null;
}

function _pathEnvKey(env) {
  if (process.platform !== 'win32') return 'PATH';
  return Object.keys(env || process.env).find((k) => k.toLowerCase() === 'path') || 'Path';
}

function _prependPathDirEnv(dir, baseEnv) {
  if (!dir) return {};
  const env = baseEnv || process.env;
  const key = _pathEnvKey(env);
  const current = env[key] || '';
  const alreadyPresent = current.split(path.delimiter).filter(Boolean).some((part) => {
    const left = path.resolve(part);
    const right = path.resolve(dir);
    return process.platform === 'win32'
      ? left.toLowerCase() === right.toLowerCase()
      : left === right;
  });
  return {
    [key]: alreadyPresent ? current : [dir, current].filter(Boolean).join(path.delimiter),
  };
}

function _codexWindowsEnv(shell) {
  if (process.platform !== 'win32' || !shell) return {};
  const dir = path.dirname(shell);
  return {
    ..._prependPathDirEnv(dir),
    CODEX_CLI_PATH: shell,
  };
}

function _readCodexCliPathFromConfig(configPath) {
  try {
    const text = fs.readFileSync(configPath, 'utf8');
    const match = text.match(/^\s*CODEX_CLI_PATH\s*=\s*(['"])(.*?)\1\s*$/m);
    if (!match) return null;
    if (match[1] === '"') {
      try {
        return JSON.parse(match[0].replace(/^\s*CODEX_CLI_PATH\s*=\s*/, '').trim());
      } catch (_) {
        return match[2].replace(/\\\\/g, '\\');
      }
    }
    return match[2];
  } catch (_) {
    return null;
  }
}

function _resolveCodexWindowsRuntimeCli(localAppData) {
  const binRoot = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  try {
    const candidates = fs.readdirSync(binRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const dir = path.join(binRoot, entry.name);
        const shell = path.join(dir, 'codex.exe');
        if (!fs.existsSync(shell)) return null;
        const hasSandboxSetup = fs.existsSync(path.join(dir, 'codex-windows-sandbox-setup.exe'));
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(shell).mtimeMs || 0; } catch (_) {}
        return { shell, hasSandboxSetup, mtimeMs };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (a.hasSandboxSetup !== b.hasSandboxSetup) return a.hasSandboxSetup ? -1 : 1;
        return b.mtimeMs - a.mtimeMs;
      });
    return candidates[0] ? candidates[0].shell : null;
  } catch (_) {
    return null;
  }
}

// Codex >= 0.165 runs its TUI (fresh, resume and fork) through a background
// server that it starts from its own install package: a directory holding
// codex-package.json whose `entrypoint` (bin/codex.exe) is the running binary,
// next to codex-resources/ (sandbox helpers) and codex-path/ (rg). A bare
// codex.exe outside that layout exits right after the banner with
//   "Error: this CLI has no complete local package; install a packaged Codex
//    CLI or use the standalone installer"
// The Codex Desktop runtime (%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\ — also
// what the desktop app writes into config.toml as CODEX_CLI_PATH) is such a
// bare directory. The npm package (vendor/<triple>/) and the standalone
// installer (~/.codex/packages/standalone/current) carry the full layout.
function _isPackagedCodexCli(exe) {
  try {
    const real = fs.realpathSync(exe);
    const root = path.dirname(path.dirname(real));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'codex-package.json'), 'utf8'));
    if (!manifest || typeof manifest.entrypoint !== 'string') return false;
    const entry = path.resolve(root, manifest.entrypoint);
    return process.platform === 'win32'
      ? entry.toLowerCase() === real.toLowerCase()
      : entry === real;
  } catch (_) {
    return false;
  }
}

const CODEX_NPM_WIN_TARGETS = {
  x64: { pkg: 'codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
  arm64: { pkg: 'codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' },
};

// npm installs Codex as a Node wrapper (codex.cmd → bin/codex.js) that spawns
// the native binary from the platform package. node-pty needs an absolute
// .exe, and the first `where codex` hit is the extensionless sh shim, which it
// cannot spawn — so go straight to the binary and set the env the wrapper sets.
// npm picks the platform package by the arch of the Node that installed it,
// which can differ from the editor's (x64 editor on Windows-on-ARM), so without
// an explicit `arch` the editor's arch is tried first, then the other one.
function _resolveCodexNpmCli(prefixDir, arch) {
  if (!prefixDir) return null;
  const packageRoot = path.join(prefixDir, 'node_modules', '@openai', 'codex');
  const archs = arch
    ? [arch]
    : [process.arch, ...Object.keys(CODEX_NPM_WIN_TARGETS).filter((a) => a !== process.arch)];
  for (const a of archs) {
    const target = CODEX_NPM_WIN_TARGETS[a];
    if (!target) continue;
    const shell = [
      path.join(packageRoot, 'node_modules', '@openai', target.pkg), // npm default (nested)
      path.join(prefixDir, 'node_modules', '@openai', target.pkg),   // hoisted
      packageRoot,                                                   // vendor/ inside the main package
    ]
      .flatMap((dir) => [
        path.join(dir, 'vendor', target.triple, 'bin', 'codex.exe'),   // 0.165+ package layout
        path.join(dir, 'vendor', target.triple, 'codex', 'codex.exe'), // older wrappers (no package)
      ])
      .find((p) => fs.existsSync(p));
    if (!shell) continue;
    // The wrapper passes realpath(<@openai/codex>) — differs under nvm-windows / Scoop links.
    let managedRoot = packageRoot;
    try { managedRoot = fs.realpathSync(packageRoot); } catch (_) {}
    return {
      shell,
      env: { CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_PACKAGE_ROOT: managedRoot },
    };
  }
  return null;
}

// Windows: every Codex install we know of, CLI installs first and the Codex
// Desktop runtime last. The first one carrying a complete package wins; when
// none does (Codex older than 0.165), keep the pre-3.30.1 order, which puts the
// Desktop runtime first because its directory holds the sandbox helper.
// `pathHit` (string, or a function returning one) is looked up only when the
// cheaper candidates came up empty: `where.exe` blocks ~150 ms, and listAgents()
// runs this several times during activation.
function _resolveCodexWindowsCli({ homeDir, localAppData, appData, configPath, pathHit }) {
  let hit;
  const getPathHit = () => {
    if (hit === undefined) hit = (typeof pathHit === 'function' ? pathHit() : pathHit) || null;
    return hit;
  };
  const existing = (shell) => (shell && fs.existsSync(shell) ? { shell } : null);
  const sameDir = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

  const appDataNpmDir = appData ? path.join(appData, 'npm') : null;
  const cli = [
    path.join(homeDir, '.local', 'bin', 'codex.exe'),
    path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
  ].map(existing).filter(Boolean);
  const appDataNpm = appDataNpmDir ? _resolveCodexNpmCli(appDataNpmDir) : null;
  // npm with a custom prefix: the `codex` shim on PATH sits in the prefix dir.
  const pathNpm = () => {
    const h = getPathHit();
    if (!h) return null;
    const dir = path.dirname(h);
    return appDataNpmDir && sameDir(dir, appDataNpmDir) ? null : _resolveCodexNpmCli(dir);
  };
  const pathExe = () => {
    const h = getPathHit();
    return h && /\.exe$/i.test(h) ? { shell: h } : null;
  };
  const desktop = [
    existing(_readCodexCliPathFromConfig(configPath)),
    existing(_resolveCodexWindowsRuntimeCli(localAppData)),
  ].filter(Boolean);

  const finish = (c) => ({
    shell: c.shell,
    args: [],
    env: { ..._codexWindowsEnv(c.shell), ...(c.env || {}) },
  });

  for (const stage of [() => cli, () => [appDataNpm], () => [pathNpm(), pathExe()], () => desktop]) {
    const packaged = stage().filter(Boolean).find((c) => _isPackagedCodexCli(c.shell));
    if (packaged) return finish(packaged);
  }

  const h = getPathHit();
  const legacy = desktop[0] || cli[0] || appDataNpm || pathNpm() || (h ? { shell: h } : null);
  return legacy ? finish(legacy) : null;
}

function resolveClaudeCli() {
  if (process.platform === 'android') return resolveViaShell('claude');
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
  if (process.platform === 'android') return resolveViaShell('kiro-cli');
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
  if (process.platform === 'android') return resolveViaShell('agy');
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
// Windows: a complete Codex package (standalone installer, npm, PATH, then the
// Codex Desktop runtime) — see _resolveCodexWindowsCli. Elsewhere:
// ~/.local/bin/codex → PATH (the npm wrapper execs the packaged binary itself).
function resolveCodexCli() {
  if (process.platform === 'android') return resolveViaShell('codex');

  if (process.platform === 'win32') {
    const homeDir = os.homedir();
    return _resolveCodexWindowsCli({
      homeDir,
      localAppData: process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local'),
      appData: process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'),
      configPath: path.join(homeDir, '.codex', 'config.toml'),
      pathHit: () => resolveOnPath('codex'),
    });
  }

  // 1) ~/.local/bin/codex — official install script (macOS/Linux)
  const localBin = path.join(os.homedir(), '.local', 'bin', 'codex');
  if (fs.existsSync(localBin)) return { shell: localBin, args: [], env: {} };

  // 2) PATH
  const onPath = resolveOnPath('codex');
  if (onPath) return { shell: onPath, args: [], env: {} };
  return null;
}

// @module pty/resolveCli — locates xAI's Grok CLI (grok) binary.
// Priority: ~/.grok/bin/grok (official grok build) → ~/.local/bin/grok → PATH.
function resolveGrokCli() {
  if (process.platform === 'android') return resolveViaShell('grok');
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
  if (process.platform === 'android') return resolveViaShell('gjc');
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

module.exports = {
  resolveClaudeCli,
  resolveKiroCli,
  resolveAntigravityCli,
  resolveCodexCli,
  resolveGrokCli,
  resolveGjcCli,
  resolveChiefCli,
  isChiefCliAvailable,
  _test: {
    readCodexCliPathFromConfig: _readCodexCliPathFromConfig,
    resolveCodexWindowsRuntimeCli: _resolveCodexWindowsRuntimeCli,
    isPackagedCodexCli: _isPackagedCodexCli,
    resolveCodexNpmCli: _resolveCodexNpmCli,
    resolveCodexWindowsCli: _resolveCodexWindowsCli,
    prependPathDirEnv: _prependPathDirEnv,
    resolveViaShell,
  },
};
