// Phase 3 — OMC runtime detection.
//
// detectOMC takes an optional homeOverride so we can point it at a temp
// directory. The cliOnPath signal still depends on the host environment,
// so tests assert behavior on the two filesystem signals (homeDir and
// configValid) — that's enough to validate the two-of-three majority
// rule and the path resolution.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectOMC } from '../../src/orchestration/core/OMCRuntime';

function mkTempHome(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `omc-detect-${label}-`));
}

test('detectOMC: empty home → both filesystem signals negative', async () => {
  const home = mkTempHome('empty');
  try {
    const res = await detectOMC(home);
    assert.equal(res.signals.homeDir, false);
    assert.equal(res.signals.configValid, false);
    assert.equal(res.homeDir, path.join(home, '.omc'));
    assert.equal(res.configPath, path.join(home, '.omc', 'config.json'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('detectOMC: .omc/ exists, no config → homeDir signal positive only', async () => {
  const home = mkTempHome('homeonly');
  try {
    fs.mkdirSync(path.join(home, '.omc'));
    const res = await detectOMC(home);
    assert.equal(res.signals.homeDir, true);
    assert.equal(res.signals.configValid, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('detectOMC: .omc/ + valid config.json → installed=true (majority hits two)', async () => {
  const home = mkTempHome('valid');
  try {
    const omcDir = path.join(home, '.omc');
    fs.mkdirSync(omcDir);
    fs.writeFileSync(path.join(omcDir, 'config.json'), JSON.stringify({ version: '4.13.4' }));
    const res = await detectOMC(home);
    assert.equal(res.signals.homeDir, true);
    assert.equal(res.signals.configValid, true);
    // Two-of-three majority — installed regardless of cliOnPath state.
    assert.equal(res.installed, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('detectOMC: .omc/ + invalid JSON → configValid stays false', async () => {
  const home = mkTempHome('invalid');
  try {
    const omcDir = path.join(home, '.omc');
    fs.mkdirSync(omcDir);
    fs.writeFileSync(path.join(omcDir, 'config.json'), '{ this is not valid json');
    const res = await detectOMC(home);
    assert.equal(res.signals.homeDir, true);
    assert.equal(res.signals.configValid, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('detectOMC: returns absolute paths even when nothing exists', async () => {
  const home = mkTempHome('paths');
  try {
    const res = await detectOMC(home);
    assert.ok(path.isAbsolute(res.homeDir));
    assert.ok(path.isAbsolute(res.configPath));
    assert.ok(res.homeDir.endsWith('.omc'));
    assert.ok(res.configPath.endsWith('config.json'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
