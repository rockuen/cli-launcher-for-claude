// v3.6.7 — pure helpers behind the GC observer + main-thread block timer.
// The runtime parts (PerformanceObserver subscription, setInterval) live in
// `diagnostics.js` which depends on `vscode`; these helpers are split out
// so we can verify the aggregation invariants without a vscode shim.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

const {
  newGcStats,
  newBlockStats,
  recordGcEntry,
  recordBlockSample,
} = require('../../src/lib/diagnosticsStats');

// Mirror of perf_hooks.constants — we don't import the real constants so
// the test stays free of platform-specific gc kinds.
const CONSTS = {
  NODE_PERFORMANCE_GC_MAJOR: 2,
  NODE_PERFORMANCE_GC_MINOR: 1,
  NODE_PERFORMANCE_GC_INCREMENTAL: 4,
  NODE_PERFORMANCE_GC_WEAKCB: 8,
};

test('newGcStats: shape', () => {
  const s = newGcStats();
  for (const bucket of ['major', 'minor', 'other']) {
    assert.equal(s[bucket].count, 0);
    assert.equal(s[bucket].totalMs, 0);
    assert.equal(s[bucket].maxMs, 0);
  }
});

test('newBlockStats: shape', () => {
  const s = newBlockStats();
  assert.equal(s.count, 0);
  assert.equal(s.totalMs, 0);
  assert.equal(s.maxMs, 0);
});

test('recordGcEntry: major bucket accumulates', () => {
  const s = newGcStats();
  recordGcEntry(s, CONSTS.NODE_PERFORMANCE_GC_MAJOR, 12, CONSTS);
  recordGcEntry(s, CONSTS.NODE_PERFORMANCE_GC_MAJOR, 30, CONSTS);
  assert.equal(s.major.count, 2);
  assert.equal(s.major.totalMs, 42);
  assert.equal(s.major.maxMs, 30);
  assert.equal(s.minor.count, 0);
  assert.equal(s.other.count, 0);
});

test('recordGcEntry: minor bucket accumulates separately', () => {
  const s = newGcStats();
  recordGcEntry(s, CONSTS.NODE_PERFORMANCE_GC_MINOR, 1.5, CONSTS);
  recordGcEntry(s, CONSTS.NODE_PERFORMANCE_GC_MINOR, 0.8, CONSTS);
  recordGcEntry(s, CONSTS.NODE_PERFORMANCE_GC_MAJOR, 50, CONSTS);
  assert.equal(s.minor.count, 2);
  assert.equal(s.minor.totalMs, 2.3);
  assert.equal(s.minor.maxMs, 1.5);
  assert.equal(s.major.count, 1);
  assert.equal(s.major.maxMs, 50);
});

test('recordGcEntry: unknown kind drops into other bucket', () => {
  const s = newGcStats();
  recordGcEntry(s, CONSTS.NODE_PERFORMANCE_GC_INCREMENTAL, 5, CONSTS);
  recordGcEntry(s, CONSTS.NODE_PERFORMANCE_GC_WEAKCB, 2, CONSTS);
  assert.equal(s.other.count, 2);
  assert.equal(s.other.totalMs, 7);
  assert.equal(s.major.count, 0);
  assert.equal(s.minor.count, 0);
});

test('recordGcEntry: maxMs only updates on a larger sample', () => {
  const s = newGcStats();
  recordGcEntry(s, CONSTS.NODE_PERFORMANCE_GC_MAJOR, 100, CONSTS);
  recordGcEntry(s, CONSTS.NODE_PERFORMANCE_GC_MAJOR, 20, CONSTS);
  recordGcEntry(s, CONSTS.NODE_PERFORMANCE_GC_MAJOR, 50, CONSTS);
  assert.equal(s.major.maxMs, 100);
  assert.equal(s.major.totalMs, 170);
});

test('recordGcEntry: missing constants degrades to other bucket', () => {
  const s = newGcStats();
  // Real-world fallback: if perf_hooks.constants is missing (older Node),
  // every entry lands in `other`. We still aggregate so the dump shows it.
  recordGcEntry(s, 2, 10, null);
  recordGcEntry(s, 1, 5, undefined);
  assert.equal(s.other.count, 2);
  assert.equal(s.major.count, 0);
  assert.equal(s.minor.count, 0);
});

test('recordBlockSample: drift below threshold is dropped', () => {
  const s = newBlockStats();
  recordBlockSample(s, 100, 500);
  recordBlockSample(s, 400, 500);
  recordBlockSample(s, 499, 500);
  assert.equal(s.count, 0);
  assert.equal(s.totalMs, 0);
  assert.equal(s.maxMs, 0);
});

test('recordBlockSample: drift above threshold accumulates', () => {
  const s = newBlockStats();
  recordBlockSample(s, 600, 500);
  recordBlockSample(s, 1500, 500);
  recordBlockSample(s, 800, 500);
  assert.equal(s.count, 3);
  assert.equal(s.totalMs, 2900);
  assert.equal(s.maxMs, 1500);
});

test('recordBlockSample: exact threshold value is dropped (strict >)', () => {
  const s = newBlockStats();
  recordBlockSample(s, 500, 500);
  assert.equal(s.count, 0);
  recordBlockSample(s, 501, 500);
  assert.equal(s.count, 1);
  assert.equal(s.totalMs, 501);
});

test('recordBlockSample: matches the v3.6.5 dump-timer-late pattern', () => {
  // The 14:24 KST freeze gave us a periodic dump that fired 52.4s late
  // (elapsed=652.4s where the timer was scheduled at 600s). At a 1Hz
  // block timer with a 500ms threshold, a 52-second block would emit a
  // single sample worth roughly 52000 ms drift.
  const s = newBlockStats();
  recordBlockSample(s, 52400, 500);
  assert.equal(s.count, 1);
  assert.equal(s.totalMs, 52400);
  assert.equal(s.maxMs, 52400);
});
