import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { listAgents } = require('../../src/agents/registry');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveChiefCli } = require('../../src/pty/resolveCli');

test('listAgents includes chief', () => {
  const ids = listAgents().map((a: any) => a.id);
  assert.ok(ids.includes('chief'));
});

test('resolveChiefCli returns null when no Chief API key is configured', () => {
  const oldKey = process.env.CHIEF_API_KEY;
  try {
    delete process.env.CHIEF_API_KEY;
    assert.equal(resolveChiefCli(), null);
  } finally {
    if (oldKey === undefined) delete process.env.CHIEF_API_KEY;
    else process.env.CHIEF_API_KEY = oldKey;
  }
});

test('resolveChiefCli uses node and bundled chief-repl when API key is present', () => {
  const oldKey = process.env.CHIEF_API_KEY;
  try {
    process.env.CHIEF_API_KEY = 'test-key';
    const resolved = resolveChiefCli();
    assert.ok(resolved);
    assert.equal(resolved.shell, process.execPath);
    assert.equal(resolved.args[0], path.join(process.cwd(), 'bin', 'chief-repl.js'));
  } finally {
    if (oldKey === undefined) delete process.env.CHIEF_API_KEY;
    else process.env.CHIEF_API_KEY = oldKey;
  }
});
