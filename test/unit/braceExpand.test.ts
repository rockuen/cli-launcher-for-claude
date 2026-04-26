// braceExpand — round-trip + expansion + safety tests.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

// JS module under src/. `allowJs:false` in tsconfig means the .js never
// gets copied into .test-out, so we resolve it from the repo root via
// process.cwd() (npm test runs from there).
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { expandBraces } = require(path.join(process.cwd(), 'src/util/braceExpand')) as {
  expandBraces: (input: string) => string[];
};

test('braceExpand: passes through plain strings unchanged', () => {
  assert.deepEqual(expandBraces('foo/bar.md'), ['foo/bar.md']);
});

test('braceExpand: passes through {single} groups (no comma)', () => {
  assert.deepEqual(expandBraces('keep{me}'), ['keep{me}']);
});

test('braceExpand: passes through unbalanced braces unchanged', () => {
  assert.deepEqual(expandBraces('left{a,b'), ['left{a,b']);
});

test('braceExpand: expands worker-{1,2,3}/answer.md into three paths', () => {
  assert.deepEqual(expandBraces('worker-{1,2,3}/answer.md'), [
    'worker-1/answer.md',
    'worker-2/answer.md',
    'worker-3/answer.md',
  ]);
});

test('braceExpand: expands the real-world OMC artifact pattern', () => {
  assert.deepEqual(
    expandBraces('.omc/state/team/3-a-b-c/workers/worker-{1,2,3}/answer.md'),
    [
      '.omc/state/team/3-a-b-c/workers/worker-1/answer.md',
      '.omc/state/team/3-a-b-c/workers/worker-2/answer.md',
      '.omc/state/team/3-a-b-c/workers/worker-3/answer.md',
    ],
  );
});

test('braceExpand: expands two adjacent groups (Cartesian product)', () => {
  // Two groups -> 2 * 2 = 4 combinations.
  assert.deepEqual(expandBraces('{a,b}-{x,y}'), ['a-x', 'a-y', 'b-x', 'b-y']);
});
