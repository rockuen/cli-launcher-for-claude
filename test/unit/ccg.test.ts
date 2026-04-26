// Phase 5 — CCG artifact watcher pure-function tests.
//
// Only vscode-free helpers are tested: parseArtifactFilename, buildPairs.
// CcgArtifactWatcher class itself requires a FileSystemWatcher and is covered
// by integration tests.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseArtifactFilename, buildPairs } from '../../src/orchestration/core/ccgHelpers';
import type { CcgArtifact } from '../../src/orchestration/types/ccg';

// --- parseArtifactFilename ---

test('parseArtifactFilename: codex file with timestamp', () => {
  const result = parseArtifactFilename('codex-test-slug-2026-04-26T13-14-53-009Z.md');
  assert.ok(result !== null, 'should not be null');
  assert.equal(result!.provider, 'codex');
  assert.equal(result!.slug, 'test-slug');
  assert.ok(result!.timestampMs !== null, 'should parse timestamp');
  assert.ok(typeof result!.timestampMs === 'number');
});

test('parseArtifactFilename: gemini file with timestamp', () => {
  const result = parseArtifactFilename('gemini-foo-bar-2026-04-26T10-00-00-000Z.md');
  assert.ok(result !== null, 'should not be null');
  assert.equal(result!.provider, 'gemini');
  assert.equal(result!.slug, 'foo-bar');
  assert.ok(result!.timestampMs !== null);
});

test('parseArtifactFilename: invalid file returns null', () => {
  const result = parseArtifactFilename('invalid.md');
  assert.equal(result, null);
});

test('parseArtifactFilename: claude file with timestamp', () => {
  const result = parseArtifactFilename('claude-my-question-2026-04-26T09-30-00-000Z.md');
  assert.ok(result !== null);
  assert.equal(result!.provider, 'claude');
  assert.equal(result!.slug, 'my-question');
});

test('parseArtifactFilename: file without timestamp still returns provider+slug', () => {
  const result = parseArtifactFilename('codex-notimestamp.md');
  assert.ok(result !== null);
  assert.equal(result!.provider, 'codex');
  assert.equal(result!.slug, 'notimestamp');
  assert.equal(result!.timestampMs, null);
});

// --- buildPairs ---

function makeArtifact(overrides: Partial<CcgArtifact>): CcgArtifact {
  return {
    filePath: '/fake/codex-slug-2026-04-26T10-00-00-000Z.md',
    fileName: 'codex-slug-2026-04-26T10-00-00-000Z.md',
    provider: 'codex',
    createdAt: Date.now(),
    mtimeMs: Date.now(),
    exitCode: 0,
    originalTask: 'test question',
    finalPrompt: '',
    rawOutput: 'output',
    questionKey: 'test question',
    slug: 'slug',
    ...overrides,
  };
}

test('buildPairs: codex+gemini within 5min window → 1 pair', () => {
  const base = 1_000_000_000_000;
  const codex = makeArtifact({
    filePath: '/fake/codex-q-2026-04-26T10-00-00-000Z.md',
    fileName: 'codex-q-2026-04-26T10-00-00-000Z.md',
    provider: 'codex',
    createdAt: base,
    mtimeMs: base,
    slug: 'q',
    questionKey: 'question',
  });
  const gemini = makeArtifact({
    filePath: '/fake/gemini-q-2026-04-26T10-01-00-000Z.md',
    fileName: 'gemini-q-2026-04-26T10-01-00-000Z.md',
    provider: 'gemini',
    createdAt: base + 60_000, // 1 minute later — within 5 min window
    mtimeMs: base + 60_000,
    slug: 'q',
    questionKey: 'question',
  });
  const pairs = buildPairs([codex, gemini]);
  assert.equal(pairs.length, 1, 'should produce exactly 1 pair');
  assert.ok(pairs[0].codex !== null, 'pair should have codex artifact');
  assert.ok(pairs[0].gemini !== null, 'pair should have gemini artifact');
});

test('buildPairs: codex+gemini >5min apart → 2 separate pairs', () => {
  const base = 1_000_000_000_000;
  const codex = makeArtifact({
    filePath: '/fake/codex-old-2026-04-26T10-00-00-000Z.md',
    fileName: 'codex-old-2026-04-26T10-00-00-000Z.md',
    provider: 'codex',
    createdAt: base,
    mtimeMs: base,
    slug: 'old',
    questionKey: 'old question',
  });
  const gemini = makeArtifact({
    filePath: '/fake/gemini-new-2026-04-26T10-10-00-000Z.md',
    fileName: 'gemini-new-2026-04-26T10-10-00-000Z.md',
    provider: 'gemini',
    createdAt: base + 10 * 60_000, // 10 minutes later — exceeds 5 min window
    mtimeMs: base + 10 * 60_000,
    slug: 'new',
    questionKey: 'new question',
  });
  const pairs = buildPairs([codex, gemini]);
  assert.equal(pairs.length, 2, 'should produce 2 separate pairs');
  // newer pair is first (sorted descending by createdAt)
  assert.ok(pairs[0].createdAt > pairs[1].createdAt);
});
