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

test('Codex spawn paths merge resolver environment into PTY environment', () => {
  const createPanel = fs.readFileSync(path.join(process.cwd(), 'src', 'panel', 'createPanel.js'), 'utf8');
  const restartPty = fs.readFileSync(path.join(process.cwd(), 'src', 'panel', 'restartPty.js'), 'utf8');

  assert.match(createPanel, /extraEnv = resolvedCodex\.env \|\| \{\}/);
  assert.match(restartPty, /extraEnv = resolvedCodex\.env \|\| \{\}/);
});
