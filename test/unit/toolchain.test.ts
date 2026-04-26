// Toolchain smoke test — verifies that the TS + node:test harness is wired up.
// Replaced by phase-specific tests starting at Phase 1.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

test('toolchain: node:test runner is operational', () => {
  assert.equal(1 + 1, 2);
});
