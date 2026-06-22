// resolveSessionAgent — the agent a panel runs is decided here.
//
// Regression target: a Claude session resumed/restored while the configured
// default agent is gjc (or codex/etc.) MUST still spawn Claude. The default
// agent only decides what a BRAND-NEW agentless launch spawns. The module is
// vscode-free, so it's required directly here and exercised as the real code.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';

const { resolveSessionAgent } = require(
  path.join(process.cwd(), 'src/lib/resolveSessionAgent')
) as {
  resolveSessionAgent: (a: {
    optsAgent?: string | false | null | undefined;
    session?: { agent?: string } | null;
    configuredDefaultAgent?: string | undefined;
  }) => string;
};

// ---------------------------------------------------------------------------
// THE BUG: resuming an existing session must ignore the configured default.
// ---------------------------------------------------------------------------

test('claude session resumes as claude even when default agent is gjc', () => {
  // Claude resume path passes { sessionId, title, agent: 'claude' }.
  assert.equal(
    resolveSessionAgent({ session: { agent: 'claude' }, configuredDefaultAgent: 'gjc' }),
    'claude'
  );
});

test('legacy agentless session resumes as claude (never the default), default=gjc', () => {
  // Sessions persisted before the agent field existed were always Claude.
  assert.equal(
    resolveSessionAgent({ session: {}, configuredDefaultAgent: 'gjc' }),
    'claude'
  );
});

test('gjc session resumes as gjc even when default agent is claude', () => {
  assert.equal(
    resolveSessionAgent({ session: { agent: 'gjc' }, configuredDefaultAgent: 'claude' }),
    'gjc'
  );
});

test('each agent session keeps its own identity regardless of default', () => {
  for (const a of ['claude', 'kiro', 'codex', 'grok', 'gjc', 'chief', 'antigravity']) {
    assert.equal(
      resolveSessionAgent({ session: { agent: a }, configuredDefaultAgent: 'gjc' }),
      a
    );
  }
});

// ---------------------------------------------------------------------------
// opts.agent (explicit force) always wins — handoff / agent-scoped commands.
// ---------------------------------------------------------------------------

test('explicit opts.agent wins over session.agent', () => {
  assert.equal(
    resolveSessionAgent({ optsAgent: 'codex', session: { agent: 'claude' }, configuredDefaultAgent: 'gjc' }),
    'codex'
  );
});

test('explicit opts.agent wins for a brand-new session', () => {
  assert.equal(
    resolveSessionAgent({ optsAgent: 'kiro', session: null, configuredDefaultAgent: 'gjc' }),
    'kiro'
  );
});

// ---------------------------------------------------------------------------
// Brand-new session (no session object) → the configured default applies.
// ---------------------------------------------------------------------------

test('brand-new agentless launch uses the configured default agent', () => {
  assert.equal(
    resolveSessionAgent({ session: null, configuredDefaultAgent: 'gjc' }),
    'gjc'
  );
});

test('brand-new launch with no default falls back to claude', () => {
  assert.equal(resolveSessionAgent({ session: null, configuredDefaultAgent: undefined }), 'claude');
  assert.equal(resolveSessionAgent({}), 'claude');
});
