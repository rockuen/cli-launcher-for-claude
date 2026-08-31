// Session deep links — build/parse round-trip and the rejection rules.
// The link is what a Burst todo (or a note, or a chat message) stores, so a
// malformed or hostile value must not reach `resumeSession`'s --resume-id.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';

const { buildSessionLink, parseSessionLink, isValidSessionId, isKnownAgent } = require(
  path.join(process.cwd(), 'src/lib/sessionLink')
) as {
  buildSessionLink: (o: any) => string | null;
  parseSessionLink: (i: any) => { sessionId: string; agent: string; cwd: string | null; title: string | null } | null;
  isValidSessionId: (id: any) => boolean;
  isKnownAgent: (a: any) => boolean;
};

test('buildSessionLink: uses the editor scheme and the extension id as authority', () => {
  const link = buildSessionLink({
    scheme: 'vscodium',
    extensionId: 'rockuen.cli-launcher-for-claude',
    sessionId: 'abc-123',
    agent: 'codex',
  });
  assert.ok(link);
  assert.ok(link!.startsWith('vscodium://rockuen.cli-launcher-for-claude/resume?'));
});

test('round-trip: a Windows cwd with drive letter, backslashes and spaces survives', () => {
  const cwd = 'C:\\dev\\my project\\burst';
  const link = buildSessionLink({
    scheme: 'vscodium',
    sessionId: '0199a1de-1f2b-7a01-9c33-aa0011223344',
    agent: 'codex',
    cwd,
    title: '보드 드래그 작업',
  });
  const parsed = parseSessionLink(link!);
  assert.deepEqual(parsed, {
    sessionId: '0199a1de-1f2b-7a01-9c33-aa0011223344',
    agent: 'codex',
    cwd,
    title: '보드 드래그 작업',
  });
});

test('round-trip: an ampersand in the title does not split the query', () => {
  const link = buildSessionLink({ sessionId: 's1', agent: 'claude', title: 'a & b=c' });
  const parsed = parseSessionLink(link!);
  assert.equal(parsed!.title, 'a & b=c');
  assert.equal(parsed!.sessionId, 's1');
});

test('parseSessionLink: accepts the {path, query} shape vscode.Uri hands the handler', () => {
  const parsed = parseSessionLink({
    path: '/resume',
    query: 'agent=kiro&session=kiro-42&cwd=%2Fhome%2Fu%2Fdev',
  });
  assert.deepEqual(parsed, { sessionId: 'kiro-42', agent: 'kiro', cwd: '/home/u/dev', title: null });
});

test('parseSessionLink: a trailing slash on /resume still routes', () => {
  assert.ok(parseSessionLink({ path: '/resume/', query: 'session=s1' }));
});

test('parseSessionLink: rejects any path that is not /resume', () => {
  assert.equal(parseSessionLink({ path: '/', query: 'session=s1' }), null);
  assert.equal(parseSessionLink({ path: '/open', query: 'session=s1' }), null);
  assert.equal(parseSessionLink({ path: '/resume/extra', query: 'session=s1' }), null);
});

test('parseSessionLink: rejects non-links', () => {
  assert.equal(parseSessionLink('not a uri'), null);
  assert.equal(parseSessionLink('vscodium://ext'), null);
  assert.equal(parseSessionLink(null), null);
  assert.equal(parseSessionLink(42), null);
});

test('session ids with a path separator or traversal are refused on both sides', () => {
  for (const bad of ['../../etc/passwd', 'a/b', 'a\\b', '', ' ', 'a b', 'x'.repeat(201)]) {
    assert.equal(isValidSessionId(bad), false, `should reject ${JSON.stringify(bad)}`);
    assert.equal(buildSessionLink({ sessionId: bad }), null, `should not build ${JSON.stringify(bad)}`);
    assert.equal(
      parseSessionLink({ path: '/resume', query: 'session=' + encodeURIComponent(bad) }),
      null,
      `should not parse ${JSON.stringify(bad)}`
    );
  }
});

test('an unknown agent falls back to claude instead of reaching the spawn path', () => {
  assert.equal(isKnownAgent('rm-rf'), false);
  const link = buildSessionLink({ sessionId: 's1', agent: 'rm-rf' });
  assert.ok(link!.includes('agent=claude'));
  assert.equal(parseSessionLink({ path: '/resume', query: 'agent=rm-rf&session=s1' })!.agent, 'claude');
});

test('every agent the tree can show survives the round-trip', () => {
  for (const agent of ['claude', 'kiro', 'antigravity', 'codex', 'grok', 'gjc', 'chief']) {
    const link = buildSessionLink({ sessionId: 'sid-1', agent });
    assert.equal(parseSessionLink(link!)!.agent, agent);
  }
});

test('a malformed percent-escape drops that pair without losing the session', () => {
  const parsed = parseSessionLink({ path: '/resume', query: 'session=s1&title=%E0%A4%A' });
  assert.equal(parsed!.sessionId, 's1');
  assert.equal(parsed!.title, null);
});
