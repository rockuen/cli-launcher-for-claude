import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { _test } = require('../../src/pty/resolveCli');

test('Codex config parser reads CODEX_CLI_PATH from config.toml', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-'));
  try {
    const configPath = path.join(dir, 'config.toml');
    const expected = String.raw`C:\Users\Me\AppData\Local\OpenAI\Codex\bin\abc123\codex.exe`;
    fs.writeFileSync(configPath, `
[mcp_servers.node_repl.env]
CODEX_CLI_PATH = '${expected}'
`, 'utf8');

    assert.equal(_test.readCodexCliPathFromConfig(configPath), expected);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex Windows runtime resolver prefers runtime dir with sandbox setup helper', () => {
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-localappdata-'));
  try {
    const binRoot = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
    const withoutHelper = path.join(binRoot, 'old-runtime');
    const withHelper = path.join(binRoot, 'new-runtime');
    fs.mkdirSync(withoutHelper, { recursive: true });
    fs.mkdirSync(withHelper, { recursive: true });
    fs.writeFileSync(path.join(withoutHelper, 'codex.exe'), '');
    fs.writeFileSync(path.join(withHelper, 'codex.exe'), '');
    fs.writeFileSync(path.join(withHelper, 'codex-windows-sandbox-setup.exe'), '');

    assert.equal(
      _test.resolveCodexWindowsRuntimeCli(localAppData),
      path.join(withHelper, 'codex.exe')
    );
  } finally {
    fs.rmSync(localAppData, { recursive: true, force: true });
  }
});

// A Codex >= 0.165 package: <root>/codex-package.json + <root>/bin/codex.exe.
function makePackagedCodex(root: string): string {
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'codex-resources'), { recursive: true });
  fs.writeFileSync(path.join(root, 'codex-package.json'), JSON.stringify({
    layoutVersion: 1, version: '0.166.0', target: 'x86_64-pc-windows-msvc',
    variant: 'codex', entrypoint: 'bin/codex.exe', resourcesDir: 'codex-resources', pathDir: 'codex-path',
  }), 'utf8');
  const exe = path.join(root, 'bin', 'codex.exe');
  fs.writeFileSync(exe, '');
  return exe;
}

// Codex Desktop's runtime: a flat hash dir, sandbox helper beside codex.exe, no package manifest.
function makeDesktopRuntime(localAppData: string, hash: string): string {
  const dir = path.join(localAppData, 'OpenAI', 'Codex', 'bin', hash);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'codex-windows-sandbox-setup.exe'), '');
  const exe = path.join(dir, 'codex.exe');
  fs.writeFileSync(exe, '');
  return exe;
}

function withTmp(fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-resolve-'));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('Codex package check: complete layout yes, bare Desktop runtime no, foreign entrypoint no', () => {
  withTmp((dir) => {
    assert.equal(_test.isPackagedCodexCli(makePackagedCodex(path.join(dir, 'pkg'))), true);
    assert.equal(_test.isPackagedCodexCli(makeDesktopRuntime(path.join(dir, 'lad'), 'abc')), false);

    const other = makePackagedCodex(path.join(dir, 'other'));
    fs.writeFileSync(path.join(dir, 'other', 'codex-package.json'), JSON.stringify({ entrypoint: 'bin/codex-tui.exe' }), 'utf8');
    assert.equal(_test.isPackagedCodexCli(other), false);
    assert.equal(_test.isPackagedCodexCli(path.join(dir, 'missing', 'codex.exe')), false);
  });
});

test('Codex npm resolver finds the vendor binary and sets the wrapper env', () => {
  withTmp((prefix) => {
    const packageRoot = path.join(prefix, 'node_modules', '@openai', 'codex');
    const exe = makePackagedCodex(path.join(packageRoot, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc'));

    assert.deepEqual(_test.resolveCodexNpmCli(prefix, 'x64'), {
      shell: exe,
      env: { CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_PACKAGE_ROOT: fs.realpathSync(packageRoot) },
    });
    assert.equal(_test.resolveCodexNpmCli(prefix, 'arm64'), null);
    assert.equal(_test.resolveCodexNpmCli(prefix, 'ia32'), null);
    // No explicit arch: the editor's arch first, then the other one (x64 editor, arm64 Node).
    assert.equal(_test.resolveCodexNpmCli(prefix).shell, exe);
  });
  withTmp((prefix) => {
    // Older wrappers kept the binary at vendor/<triple>/codex/codex.exe, with no package.
    const old = path.join(prefix, 'node_modules', '@openai', 'codex', 'vendor', 'aarch64-pc-windows-msvc', 'codex', 'codex.exe');
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, '');
    assert.equal(_test.resolveCodexNpmCli(prefix).shell, old);
    assert.equal(_test.isPackagedCodexCli(old), false);
  });
});

test('Codex Windows resolver picks a packaged npm install over the bare Desktop runtime in CODEX_CLI_PATH', () => {
  withTmp((dir) => {
    const localAppData = path.join(dir, 'Local');
    const appData = path.join(dir, 'Roaming');
    const desktopExe = makeDesktopRuntime(localAppData, '08d187884f2330d1');
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, `[mcp_servers.node_repl.env]\nCODEX_CLI_PATH = '${desktopExe}'\n`, 'utf8');
    const packageRoot = path.join(appData, 'npm', 'node_modules', '@openai', 'codex');
    const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
    const pkg = process.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64';
    const npmExe = makePackagedCodex(path.join(packageRoot, 'node_modules', '@openai', pkg, 'vendor', triple));

    const resolved = _test.resolveCodexWindowsCli({
      homeDir: path.join(dir, 'home'), localAppData, appData, configPath,
      pathHit: path.join(appData, 'npm', 'codex'),
    });
    assert.equal(resolved.shell, npmExe);
    assert.equal(resolved.env.CODEX_MANAGED_BY_NPM, '1');
    assert.equal(resolved.env.CODEX_MANAGED_PACKAGE_ROOT, fs.realpathSync(packageRoot));
    if (process.platform === 'win32') assert.equal(resolved.env.CODEX_CLI_PATH, npmExe);
  });
});

test('Codex Windows resolver follows the standalone installer links, ahead of a packaged Desktop runtime', () => {
  withTmp((dir) => {
    const localAppData = path.join(dir, 'Local');
    const homeDir = path.join(dir, 'home');
    // The installer's real layout: Programs\OpenAI\Codex\bin → ~/.codex/packages/standalone/current/bin,
    // current → <version>. The manifest sits only at the far end of the links.
    const standaloneRoot = path.join(homeDir, '.codex', 'packages', 'standalone');
    makePackagedCodex(path.join(standaloneRoot, '0.166.0'));
    fs.symlinkSync(path.join(standaloneRoot, '0.166.0'), path.join(standaloneRoot, 'current'), 'junction');
    const shimDir = path.join(localAppData, 'Programs', 'OpenAI', 'Codex');
    fs.mkdirSync(shimDir, { recursive: true });
    fs.symlinkSync(path.join(standaloneRoot, 'current', 'bin'), path.join(shimDir, 'bin'), 'junction');
    const shim = path.join(shimDir, 'bin', 'codex.exe');
    assert.equal(fs.existsSync(path.join(shimDir, 'codex-package.json')), false);

    // A packaged Desktop runtime named by CODEX_CLI_PATH competes from the start. (Its bin/codex.exe
    // sits one level below the hashed dir, which the runtime scan does not list.)
    const desktopPkg = makePackagedCodex(path.join(localAppData, 'OpenAI', 'Codex', 'bin', 'pkg'));
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, `CODEX_CLI_PATH = '${desktopPkg}'\n`, 'utf8');
    const args = { homeDir, localAppData, appData: path.join(dir, 'Roaming'), configPath, pathHit: null };

    assert.equal(_test.isPackagedCodexCli(shim), true);
    assert.equal(_test.resolveCodexWindowsCli(args).shell, shim);

    // An unpackaged standalone (Codex < 0.165) loses to the packaged Desktop runtime.
    fs.rmSync(path.join(standaloneRoot, '0.166.0', 'codex-package.json'));
    assert.equal(_test.isPackagedCodexCli(shim), false);
    assert.equal(_test.resolveCodexWindowsCli(args).shell, desktopPkg);
  });
});

test('Codex Windows resolver keeps the Desktop-runtime-first order when nothing is packaged (Codex < 0.165)', () => {
  withTmp((dir) => {
    const localAppData = path.join(dir, 'Local');
    const desktopExe = makeDesktopRuntime(localAppData, 'old');
    const homeDir = path.join(dir, 'home');
    fs.mkdirSync(path.join(homeDir, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.local', 'bin', 'codex.exe'), '');

    const resolved = _test.resolveCodexWindowsCli({
      homeDir, localAppData, appData: path.join(dir, 'Roaming'), configPath: path.join(dir, 'none.toml'), pathHit: null,
    });
    assert.equal(resolved.shell, desktopExe);
    if (process.platform === 'win32') assert.equal(resolved.env.CODEX_CLI_PATH, desktopExe);
  });
  withTmp((dir) => {
    assert.equal(_test.resolveCodexWindowsCli({
      homeDir: dir, localAppData: dir, appData: dir, configPath: path.join(dir, 'none.toml'), pathHit: null,
    }), null);
  });
});

test('Codex Windows resolver looks up PATH only when it has to, and finds npm under a custom prefix', () => {
  const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const pkg = process.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64';
  const npmExeUnder = (prefix: string) =>
    makePackagedCodex(path.join(prefix, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', pkg, 'vendor', triple));

  withTmp((dir) => {
    const appData = path.join(dir, 'Roaming');
    const npmExe = npmExeUnder(path.join(appData, 'npm'));
    let lookups = 0;
    const resolved = _test.resolveCodexWindowsCli({
      homeDir: path.join(dir, 'home'), localAppData: path.join(dir, 'Local'), appData,
      configPath: path.join(dir, 'none.toml'), pathHit: () => { lookups++; return null; },
    });
    assert.equal(resolved.shell, npmExe);
    assert.equal(lookups, 0);
  });

  withTmp((dir) => {
    const prefix = path.join(dir, 'custom-npm');
    const npmExe = npmExeUnder(prefix);
    const desktopExe = makeDesktopRuntime(path.join(dir, 'Local'), 'abc');
    let lookups = 0;
    const resolved = _test.resolveCodexWindowsCli({
      homeDir: path.join(dir, 'home'), localAppData: path.join(dir, 'Local'), appData: path.join(dir, 'Roaming'),
      configPath: path.join(dir, 'none.toml'), pathHit: () => { lookups++; return path.join(prefix, 'codex'); },
    });
    assert.equal(resolved.shell, npmExe);
    assert.equal(resolved.env.CODEX_MANAGED_PACKAGE_ROOT, fs.realpathSync(path.join(prefix, 'node_modules', '@openai', 'codex')));
    assert.equal(lookups, 1);
    assert.notEqual(resolved.shell, desktopExe);
  });
});

test('Codex spawn paths merge resolver environment into PTY environment', () => {
  const createPanel = fs.readFileSync(path.join(process.cwd(), 'src', 'panel', 'createPanel.js'), 'utf8');
  const restartPty = fs.readFileSync(path.join(process.cwd(), 'src', 'panel', 'restartPty.js'), 'utf8');

  assert.match(createPanel, /extraEnv = resolvedCodex\.env \|\| \{\}/);
  assert.match(restartPty, /extraEnv = resolvedCodex\.env \|\| \{\}/);
});
