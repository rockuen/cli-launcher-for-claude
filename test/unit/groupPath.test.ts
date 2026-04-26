// Phase 13 — groupPath pure-function unit tests.
// Only pure helpers from src/util/groupPath.js are tested (no vscode dependency).

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { pathDepth, getParentPath, getLeafName, getDescendants, isAddAllowed, MAX_DEPTH } =
  require(path.join(process.cwd(), 'src/util/groupPath')) as {
    pathDepth: (name: string) => number;
    getParentPath: (name: string) => string | null;
    getLeafName: (name: string) => string;
    getDescendants: (groups: Record<string, unknown>, parent: string) => string[];
    isAddAllowed: (parentPath: string) => boolean;
    MAX_DEPTH: number;
  };

// --- pathDepth ---

test('pathDepth: empty string → 0', () => {
  assert.equal(pathDepth(''), 0);
});

test('pathDepth: single segment → 1', () => {
  assert.equal(pathDepth('a'), 1);
});

test('pathDepth: two segments → 2', () => {
  assert.equal(pathDepth('a/b'), 2);
});

test('pathDepth: three segments → 3', () => {
  assert.equal(pathDepth('a/b/c'), 3);
});

// --- getParentPath ---

test('getParentPath: single segment → null', () => {
  assert.equal(getParentPath('a'), null);
});

test('getParentPath: two segments → first segment', () => {
  assert.equal(getParentPath('a/b'), 'a');
});

test('getParentPath: three segments → first two', () => {
  assert.equal(getParentPath('a/b/c'), 'a/b');
});

test('getParentPath: empty string → null', () => {
  assert.equal(getParentPath(''), null);
});

// --- getLeafName ---

test('getLeafName: single segment → itself', () => {
  assert.equal(getLeafName('a'), 'a');
});

test('getLeafName: two segments → last', () => {
  assert.equal(getLeafName('a/b'), 'b');
});

test('getLeafName: three segments → last', () => {
  assert.equal(getLeafName('a/b/c'), 'c');
});

// --- getDescendants ---

test('getDescendants: returns only strict sub-paths of parent', () => {
  const groups = { 'a': [], 'a/b': [], 'a/b/c': [], 'x': [] };
  const result = getDescendants(groups, 'a');
  assert.deepEqual(result.sort(), ['a/b', 'a/b/c']);
});

test('getDescendants: no descendants → empty array', () => {
  const groups = { 'a': [], 'x': [] };
  const result = getDescendants(groups, 'a');
  assert.deepEqual(result, []);
});

test('getDescendants: does not include the parent itself', () => {
  const groups = { 'a': [], 'a/b': [] };
  const result = getDescendants(groups, 'a');
  assert.ok(!result.includes('a'));
});

// --- isAddAllowed ---

test('isAddAllowed: depth-1 parent → allowed (child would be depth 2)', () => {
  assert.equal(isAddAllowed('a'), true);
});

test('isAddAllowed: depth-2 parent → allowed (child would be depth 3)', () => {
  assert.equal(isAddAllowed('a/b'), true);
});

test('isAddAllowed: depth-3 parent → NOT allowed (child would be depth 4)', () => {
  assert.equal(isAddAllowed('a/b/c'), false);
});

test('MAX_DEPTH is 3', () => {
  assert.equal(MAX_DEPTH, 3);
});
