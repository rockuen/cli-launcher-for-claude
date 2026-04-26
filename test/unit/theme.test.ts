// Phase 2 — UI Foundation smoke tests.
//
// Verifies that the color/theme module exports stay self-consistent so that
// downstream webviews and tree providers can rely on stable identifiers.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { COLOR_IDS, HEX, detectAgent, agentDisplayName } from '../../src/orchestration/ui/colors';
import { buildSharedWebviewCss } from '../../src/orchestration/ui/webviewTheme';

test('theme: COLOR_IDS keys match HEX keys (no orphans)', () => {
  const colorKeys = Object.keys(COLOR_IDS).sort();
  const hexKeys = Object.keys(HEX).sort();
  assert.deepEqual(colorKeys, hexKeys);
});

test('theme: every COLOR_IDS value uses the claudeCodeLauncher.* namespace', () => {
  for (const [, id] of Object.entries(COLOR_IDS)) {
    assert.ok(
      id.startsWith('claudeCodeLauncher.'),
      `expected '${id}' to start with 'claudeCodeLauncher.'`,
    );
  }
});

test('theme: detectAgent identifies common CLIs', () => {
  assert.equal(detectAgent('claude'), 'claude');
  assert.equal(detectAgent('claude.exe'), 'claude');
  assert.equal(detectAgent('codex --help'), 'codex');
  assert.equal(detectAgent('gemini'), 'gemini');
  assert.equal(detectAgent('zsh'), 'shell');
  assert.equal(detectAgent('something-unrelated'), 'unknown');
});

test('theme: agentDisplayName returns non-empty strings for known kinds', () => {
  for (const k of ['claude', 'codex', 'gemini', 'shell', 'unknown'] as const) {
    const name = agentDisplayName(k);
    assert.ok(typeof name === 'string' && name.length > 0);
  }
});

test('theme: buildSharedWebviewCss embeds every HEX value', () => {
  const css = buildSharedWebviewCss();
  for (const [key, value] of Object.entries(HEX)) {
    assert.ok(
      css.includes(value),
      `expected CSS to embed HEX.${key} (${value})`,
    );
  }
});

test('theme: shared CSS uses --ccl- prefix (not --podium-)', () => {
  const css = buildSharedWebviewCss();
  assert.ok(css.includes('--ccl-'), 'expected --ccl- variables');
  assert.ok(!css.includes('--podium-'), 'no --podium- residue allowed');
});
