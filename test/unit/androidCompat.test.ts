import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const resolveCli = require('../../src/pty/resolveCli');
const repoRoot = path.join(__dirname, '..', '..', '..');

// Not reached by tsconfig.test's includes, so load the shipped source itself.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { loadNodePty } = require(path.join(repoRoot, 'src', 'pty', 'loadNodePty'));

function hasBash(): boolean {
  try {
    return execFileSync('bash', ['-c', 'echo ok'], { encoding: 'utf8', timeout: 5000 }).trim() === 'ok';
  } catch {
    return false;
  }
}

// VSCodroid's `claude` is a bash function from BASH_ENV, not a file on PATH.
function withShellFunction(name: string, fn: () => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'android-shell-'));
  const envFile = path.join(dir, 'bash_env');
  fs.writeFileSync(envFile, `${name}() { printf 'got:%s|' "$@"; }\n`);
  const saved = { SHELL: process.env.SHELL, BASH_ENV: process.env.BASH_ENV };
  process.env.SHELL = 'bash';
  process.env.BASH_ENV = envFile.replace(/\\/g, '/');
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function asAndroid(fn: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'android' });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

test('resolveViaShell launches a shell function and passes the caller args through as "$@"', { skip: !hasBash() && 'bash not available' }, () => {
  withShellFunction('fakeagent', () => {
    const resolved = resolveCli._test.resolveViaShell('fakeagent');
    assert.deepEqual(resolved, { shell: 'bash', args: ['-c', 'fakeagent "$@"', 'fakeagent'] });
    const out = execFileSync(resolved.shell, [...resolved.args, '--resume', 'a b'], { encoding: 'utf8', env: process.env });
    assert.equal(out, 'got:--resume|got:a b|');
  });
});

test('resolveViaShell answers null for a command the shell does not know', { skip: !hasBash() && 'bash not available' }, () => {
  withShellFunction('fakeagent', () => {
    assert.equal(resolveCli._test.resolveViaShell('no-such-agent-cli-xyz'), null);
  });
});

test('resolveViaShell caches the probe, so repeated resolver sweeps do not respawn bash', { skip: !hasBash() && 'bash not available' }, () => {
  withShellFunction('cachedagent', () => {
    const first = resolveCli._test.resolveViaShell('cachedagent');
    assert.ok(first);
    // A fresh probe would now fail: the function is gone from BASH_ENV.
    fs.writeFileSync(process.env.BASH_ENV!, '');
    assert.deepEqual(resolveCli._test.resolveViaShell('cachedagent'), first);
  });
});

test('on Android every agent resolver goes through the shell, ahead of ~/.local/bin', { skip: !hasBash() && 'bash not available' }, () => {
  withShellFunction('claude', () => {
    asAndroid(() => {
      assert.deepEqual(resolveCli.resolveClaudeCli(), { shell: 'bash', args: ['-c', 'claude "$@"', 'claude'] });
    });
  });
});

test('every agent resolver has the Android branch', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'pty', 'resolveCli.js'), 'utf8');
  for (const [fn, cli] of [['resolveClaudeCli', 'claude'], ['resolveKiroCli', 'kiro-cli'], ['resolveAntigravityCli', 'agy'],
    ['resolveCodexCli', 'codex'], ['resolveGrokCli', 'grok'], ['resolveGjcCli', 'gjc']]) {
    const body = src.slice(src.indexOf(`function ${fn}() {`));
    const firstStatement = body.split(/\r?\n/)[1].trim();
    assert.equal(firstStatement, `if (process.platform === 'android') return resolveViaShell('${cli}');`, fn);
  }
});

test('loadNodePty prefers the bundled node-pty', () => {
  const bundled = { spawn() {} };
  const req = (id: string) => {
    if (id === 'node-pty') return bundled;
    throw new Error('unexpected require ' + id);
  };
  assert.equal(loadNodePty(req, '/editor'), bundled);
});

test('loadNodePty falls back to the editor node-pty under appRoot', () => {
  const editorPty = { spawn() {} };
  const root = path.join(path.sep, 'data', 'server', 'vscode-reh');
  const req = (id: string) => {
    if (id === path.join(root, 'node_modules', 'node-pty')) return editorPty;
    throw new Error('Failed to load native module: pty.node');
  };
  assert.equal(loadNodePty(req, root), editorPty);
});

test('loadNodePty checks the Electron asar location too, then rethrows the bundled error', () => {
  const editorPty = { spawn() {} };
  const root = path.join(path.sep, 'app');
  assert.equal(loadNodePty((id: string) => {
    if (id === path.join(root, 'node_modules.asar', 'node-pty')) return editorPty;
    throw new Error('nope');
  }, root), editorPty);

  const bundledErr = new Error('bundled failed');
  assert.throws(() => loadNodePty((id: string) => {
    if (id === 'node-pty') throw bundledErr;
    throw new Error('editor failed');
  }, root), (e: unknown) => e === bundledErr);
});

// The fallback only triggers because require('node-pty') itself throws when the
// binary is missing. node-pty 1.1.0 loads it eagerly off Windows; if an upgrade
// made that lazy, the failure would move to spawn() and skip the fallback.
test('bundled node-pty loads its binary at require time off Windows', () => {
  const index = fs.readFileSync(path.join(repoRoot, 'node_modules', 'node-pty', 'lib', 'index.js'), 'utf8');
  assert.ok(index.includes(`exports.native = (process.platform !== 'win32' ? utils_1.loadNativeModule('pty').module : null);`));
});

test('nothing in src requires node-pty directly, so the fallback cannot be bypassed', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(js|ts)$/.test(ent.name) && ent.name !== 'loadNodePty.js'
        && /require\(\s*['"]node-pty['"]\s*\)/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(repoRoot, p));
    }
  };
  walk(path.join(repoRoot, 'src'));
  assert.deepEqual(offenders, []);
});

test('CI builds the alpine-arm64 target VSCodroid asks for, without node-pty binaries', () => {
  const wf = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'publish.yml'), 'utf8');
  assert.match(wf, /target: alpine-arm64\s+editorPty: true/);
  assert.match(wf, /if: \$\{\{ matrix\.editorPty \}\}\s+run: rm -rf node_modules\/node-pty\/build node_modules\/node-pty\/prebuilds/);
  assert.match(wf, /if: \$\{\{ !matrix\.editorPty \}\}\s+run: npx @electron\/rebuild/);
});
