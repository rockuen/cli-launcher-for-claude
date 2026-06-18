// Reader display-name customization: resolveReaderNames (global user + per-agent
// AI name, with fallbacks) and renderBlocks honoring + escaping those names.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';

const { resolveReaderNames, renderBlocks } = require(
  path.join(process.cwd(), 'src/lib/readerRender')
) as {
  resolveReaderNames: (cfg: any, agent: string, agentLabel?: string) => { user: string; assistant: string };
  renderBlocks: (messages: any[], options?: any) => string;
};

// ─── resolveReaderNames ──────────────────────────────────────────────────────

test('resolveReaderNames: per-agent AI name + global user name', () => {
  assert.deepEqual(
    resolveReaderNames({ user: '나', codex: 'Codex' }, 'codex', 'Codex'),
    { user: '나', assistant: 'Codex' }
  );
  assert.deepEqual(
    resolveReaderNames({ user: '나', grok: 'Grok' }, 'grok', 'Grok'),
    { user: '나', assistant: 'Grok' }
  );
});

test('resolveReaderNames: empty cfg → You + agent label', () => {
  assert.deepEqual(resolveReaderNames({}, 'claude', 'Claude'), { user: 'You', assistant: 'Claude' });
});

test('resolveReaderNames: whitespace-only values treated as empty', () => {
  assert.deepEqual(
    resolveReaderNames({ user: '   ', kiro: '' }, 'kiro', 'Kiro'),
    { user: 'You', assistant: 'Kiro' }
  );
});

test('resolveReaderNames: null / non-object cfg is safe', () => {
  assert.deepEqual(resolveReaderNames(null, 'codex', 'Codex'), { user: 'You', assistant: 'Codex' });
  assert.deepEqual(resolveReaderNames('nope' as any, 'codex', 'Codex'), { user: 'You', assistant: 'Codex' });
});

test('resolveReaderNames: missing agentLabel → Assistant', () => {
  assert.deepEqual(resolveReaderNames({}, 'codex', undefined), { user: 'You', assistant: 'Assistant' });
});

test('resolveReaderNames: global user applies regardless of agent', () => {
  const cfg = { user: '낙원', claude: 'Claude', codex: 'Codex' };
  assert.equal(resolveReaderNames(cfg, 'claude', 'Claude').user, '낙원');
  assert.equal(resolveReaderNames(cfg, 'codex', 'Codex').user, '낙원');
});

// ─── renderBlocks honoring names ─────────────────────────────────────────────

test('renderBlocks: applies custom user + assistant labels', () => {
  const html = renderBlocks(
    [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }],
    { names: { user: '나', assistant: 'Codex' } }
  );
  assert.ok(html.includes('>나<'), 'user label present');
  assert.ok(html.includes('>Codex<'), 'assistant label present');
  assert.ok(!html.includes('>user<'), 'raw user role not shown');
  assert.ok(!html.includes('>assistant<'), 'raw assistant role not shown');
});

test('renderBlocks: falls back to raw role when no names given', () => {
  const html = renderBlocks([{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }], {});
  assert.ok(html.includes('>user<'));
  assert.ok(html.includes('>assistant<'));
});

test('renderBlocks: escapes a malicious custom name', () => {
  const html = renderBlocks(
    [{ role: 'assistant', text: 'x' }],
    { names: { assistant: '<img src=x onerror=alert(1)>' } }
  );
  assert.ok(!html.includes('<img src=x'), 'raw HTML must not leak into the role span');
  assert.ok(html.includes('&lt;img'), 'name is HTML-escaped');
});

test('renderBlocks: partial names map (only assistant) keeps raw user', () => {
  const html = renderBlocks(
    [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }],
    { names: { assistant: 'Codex' } }
  );
  assert.ok(html.includes('>Codex<'));
  assert.ok(html.includes('>user<'), 'user has no custom name → raw role');
});
