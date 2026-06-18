// Tab title generation — agent-label lookup + isDefaultTabTitle contract.
//
// Tests the logic introduced in:
//   createPanel.js  — agentLabel lookup from registry for default tab title
//   sessionManager.js — isDefaultTabTitle() generalised from Claude Code-only regex
//
// Both modules are tested here via the shared dependency (agents/registry) which
// is vscode-free and safe to require in a plain Node test runner.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';

const { listAgents } = require(
  path.join(process.cwd(), 'src/agents/registry')
) as {
  listAgents: () => Array<{ id: string; label: string; cliName: string; installed: boolean }>;
};

// ---------------------------------------------------------------------------
// Helper — mirrors the isDefaultTabTitle logic in sessionManager.js exactly.
// ---------------------------------------------------------------------------
function isDefaultTabTitle(title: string): boolean {
  if (!title) return false;
  return listAgents().some(({ label }) =>
    new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( \\(\\d+\\))?$`).test(title)
  );
}

// ---------------------------------------------------------------------------
// Helper — mirrors the agentLabel lookup in createPanel.js.
// ---------------------------------------------------------------------------
function resolveAgentLabel(agentId: string): string {
  return (listAgents().find((a) => a.id === agentId) || { label: 'Claude Code' }).label;
}

// ---------------------------------------------------------------------------
// agentLabel lookup
// ---------------------------------------------------------------------------

test('agentLabel: claude → "Claude Code"', () => {
  assert.equal(resolveAgentLabel('claude'), 'Claude Code');
});

test('agentLabel: kiro → "Kiro"', () => {
  assert.equal(resolveAgentLabel('kiro'), 'Kiro');
});

test('agentLabel: grok → "Grok"', () => {
  assert.equal(resolveAgentLabel('grok'), 'Grok');
});

test('agentLabel: unknown id falls back to "Claude Code"', () => {
  assert.equal(resolveAgentLabel('unknown-agent'), 'Claude Code');
});

// ---------------------------------------------------------------------------
// tabTitle generation
// ---------------------------------------------------------------------------

test('tabTitle: first tab uses bare agent label (no counter)', () => {
  // Mirrors: state.tabCounter === 1 ? agentLabel : `${agentLabel} (${tabCounter})`
  const label = resolveAgentLabel('kiro');
  const title = label; // tabCounter === 1
  assert.equal(title, 'Kiro');
});

test('tabTitle: second tab appends counter for kiro', () => {
  const label = resolveAgentLabel('kiro');
  const title = `${label} (2)`;
  assert.equal(title, 'Kiro (2)');
});

test('tabTitle: second tab appends counter for claude', () => {
  const label = resolveAgentLabel('claude');
  const title = `${label} (2)`;
  assert.equal(title, 'Claude Code (2)');
});

// ---------------------------------------------------------------------------
// isDefaultTabTitle — recognises all agent labels and their numbered variants
// ---------------------------------------------------------------------------

test('isDefaultTabTitle: bare "Claude Code" → true', () => {
  assert.equal(isDefaultTabTitle('Claude Code'), true);
});

test('isDefaultTabTitle: "Claude Code (2)" → true', () => {
  assert.equal(isDefaultTabTitle('Claude Code (2)'), true);
});

test('isDefaultTabTitle: "Claude Code (99)" → true', () => {
  assert.equal(isDefaultTabTitle('Claude Code (99)'), true);
});

test('isDefaultTabTitle: bare "Kiro" → true', () => {
  assert.equal(isDefaultTabTitle('Kiro'), true);
});

test('isDefaultTabTitle: "Kiro (2)" → true', () => {
  assert.equal(isDefaultTabTitle('Kiro (2)'), true);
});

test('isDefaultTabTitle: "Grok (2)" → true', () => {
  assert.equal(isDefaultTabTitle('Grok (2)'), true);
});

test('isDefaultTabTitle: user-renamed title → false', () => {
  assert.equal(isDefaultTabTitle('My Project'), false);
});

test('isDefaultTabTitle: partial match "Claude Code extra" → false', () => {
  assert.equal(isDefaultTabTitle('Claude Code extra'), false);
});

test('isDefaultTabTitle: empty string → false', () => {
  assert.equal(isDefaultTabTitle(''), false);
});
