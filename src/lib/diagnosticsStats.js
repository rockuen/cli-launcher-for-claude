// @module lib/diagnosticsStats — pure helpers for diagnostics measurement.
// Split out from `diagnostics.js` so unit tests can require this module
// without dragging the `vscode` runtime dep into the test process.
//
// Two measurement axes added in v3.6.7:
//   1. GC pause aggregation — bucket each `perf_hooks` GC entry into
//      major/minor/other so a stop-the-world spike shows up as
//      `major count=N max=Mms` in the dump.
//   2. Main thread block sampling — given the drift of a fixed-interval
//      timer, accept samples whose drift exceeds a configurable threshold
//      and aggregate count / total / max.
//
// Both stat shapes carry the same three fields (count / totalMs / maxMs)
// so the dump renderer can format them identically.

function newGcStats() {
  return {
    major: { count: 0, totalMs: 0, maxMs: 0 },
    minor: { count: 0, totalMs: 0, maxMs: 0 },
    other: { count: 0, totalMs: 0, maxMs: 0 },
  };
}

function newBlockStats() {
  return { count: 0, totalMs: 0, maxMs: 0 };
}

/** Record one GC entry into the appropriate bucket.
 *  `kind` is the numeric `entry.kind` field from `perf_hooks` (or
 *  `entry.detail.kind` on Node 16+). `consts` carries the
 *  NODE_PERFORMANCE_GC_* constants so this helper stays pure for testing
 *  (callers in production pass `require('perf_hooks').constants`). */
function recordGcEntry(stats, kind, durationMs, consts) {
  let bucket = 'other';
  if (consts && kind === consts.NODE_PERFORMANCE_GC_MAJOR) bucket = 'major';
  else if (consts && kind === consts.NODE_PERFORMANCE_GC_MINOR) bucket = 'minor';
  const s = stats[bucket];
  s.count++;
  s.totalMs += durationMs;
  if (durationMs > s.maxMs) s.maxMs = durationMs;
}

/** Record one main-thread block sample if the measured drift exceeds the
 *  threshold. `drift` = (actual fire ts) - (last fire ts) - interval.
 *  Samples below the threshold are dropped — that filters scheduler
 *  jitter (GC minor pauses, OS context switches) and keeps the count
 *  focused on the seconds-long pauses that match user-visible freezes. */
function recordBlockSample(stats, drift, thresholdMs) {
  if (drift > thresholdMs) {
    stats.count++;
    stats.totalMs += drift;
    if (drift > stats.maxMs) stats.maxMs = drift;
  }
}

module.exports = {
  newGcStats,
  newBlockStats,
  recordGcEntry,
  recordBlockSample,
};
