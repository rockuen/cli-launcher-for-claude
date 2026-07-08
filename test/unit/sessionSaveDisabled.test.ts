import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Wiring guards for the per-agent "Save sessions" toggle
// (claudeCodeLauncher.sessionSaveDisabledAgents). The feature spans four files;
// these source-level checks fail fast if any leg of the wiring is dropped in a
// later refactor (same style as settingsPanel.test.ts / renamePrefix guards).

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), ...rel.split('/')), 'utf8');
}

const ALL_AGENTS = ['claude', 'kiro', 'antigravity', 'codex', 'grok', 'gjc', 'chief'];

test('package.json declares sessionSaveDisabledAgents (array, default [])', () => {
  const pkg = JSON.parse(read('package.json'));
  const conf = pkg.contributes.configuration;
  const props = Array.isArray(conf)
    ? Object.assign({}, ...conf.map((b: any) => b.properties || {}))
    : (conf.properties || {});
  const def = props['claudeCodeLauncher.sessionSaveDisabledAgents'];
  assert.ok(def, 'setting must be declared');
  assert.equal(def.type, 'array');
  assert.deepEqual(def.default, []);
  // enum lists every supported agent id
  for (const id of ALL_AGENTS) assert.ok(def.items.enum.includes(id), `enum missing ${id}`);
});

test('settingsPanel wires the Save sessions toggle end to end', () => {
  const src = read('src/panel/settingsPanel.js');
  // Visible switch + label
  assert.match(src, /Save sessions/);
  // Mutable state seeded from globals
  assert.match(src, /let sessionSaveDisabled = /);
  assert.match(src, /GLOBALS\.sessionSaveDisabledAgents/);
  // Writes back through the gated set-global channel
  assert.match(src, /key: 'sessionSaveDisabledAgents'/);
  // Loaded into the globals payload + allowlisted for writes
  assert.match(src, /cfg\.get\('sessionSaveDisabledAgents', \[\]\)/);
  assert.match(src, /'sessionSaveDisabledAgents',/);
});

test('activation gates every <agent>Available key on sessionSaveDisabledAgents', () => {
  const src = read('src/activation.js');
  // Each split-view availability check ANDs in the save-disabled exclusion.
  for (const id of ALL_AGENTS.filter((a) => a !== 'claude')) {
    assert.match(
      src,
      new RegExp(`!saveDisabled\\.includes\\('${id}'\\)`),
      `availability for ${id} must exclude save-disabled agents`,
    );
  }
  // Config-change handler re-evaluates on the new key.
  assert.match(src, /affectsConfiguration\('claudeCodeLauncher\.sessionSaveDisabledAgents'\)/);
});

test('SessionTreeDataProvider drops save-disabled agents from the unified tree', () => {
  const src = read('src/tree/SessionTreeDataProvider.js');
  // Helper reads the config set.
  assert.match(src, /_saveDisabledAgents\(\)\s*\{[\s\S]*sessionSaveDisabledAgents/);
  // Non-claude agents skipped while folding other agents into the unified view.
  assert.match(src, /if \(saveDisabled\.has\(spec\.agent\)\) continue;/);
  // claude's own leaves dropped when claude is save-disabled.
  assert.match(src, /_saveDisabledAgents\(\)\.has\('claude'\)\) allItems\.length = 0;/);
});
