// Agent registry — shape + installed-field contract.
// listAgents() must return a serializable view with id/label/cliName/installed
// for every registered agent, and isKnownAgent() must reflect the same set.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';

const { AGENTS, listAgents, isKnownAgent } = require(
  path.join(process.cwd(), 'src/agents/registry')
) as {
  AGENTS: Array<{ id: string; label: string; cliName: string; detect: () => boolean }>;
  listAgents: () => Array<{ id: string; label: string; cliName: string; installed: boolean }>;
  isKnownAgent: (id: string) => boolean;
};

test('listAgents: returns one entry per registered agent with the expected shape', () => {
  const agents = listAgents();
  assert.equal(agents.length, AGENTS.length);
  assert.ok(agents.length >= 2, 'expected at least claude + kiro');

  for (const a of agents) {
    assert.equal(typeof a.id, 'string');
    assert.equal(typeof a.label, 'string');
    assert.equal(typeof a.cliName, 'string');
    assert.equal(typeof a.installed, 'boolean');
  }

  const ids = agents.map((a) => a.id);
  assert.ok(ids.includes('claude'));
  assert.ok(ids.includes('kiro'));
  assert.ok(ids.includes('antigravity'));
  assert.ok(ids.includes('codex'));
  assert.ok(ids.includes('grok'));
  assert.ok(ids.includes('gjc'));

  // gjc registry entry uses the expected label + cliName.
  const gjc = agents.find((a) => a.id === 'gjc');
  assert.ok(gjc, 'expected a gjc agent entry');
  assert.equal(gjc!.label, 'Gajae');
  assert.equal(gjc!.cliName, 'gjc');
});

test('isKnownAgent: true for registered ids, false otherwise', () => {
  assert.equal(isKnownAgent('claude'), true);
  assert.equal(isKnownAgent('kiro'), true);
  assert.equal(isKnownAgent('antigravity'), true);
  assert.equal(isKnownAgent('codex'), true);
  assert.equal(isKnownAgent('grok'), true);
  assert.equal(isKnownAgent('gjc'), true);
  assert.equal(isKnownAgent('nope'), false);
});
