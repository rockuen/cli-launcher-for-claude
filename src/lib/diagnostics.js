// @module lib/diagnostics — opt-in measurement layer for diagnosing freeze
// reports. Off by default (zero cost when disabled); when toggled on through
// `claudeCodeLauncher.diagnostics.enabled` it records per-panel PTY chunk
// statistics and dumps a summary every 10 minutes to an `OutputChannel`.
//
// What this answers:
//   - Is the freeze pattern "many tiny chunks" (Ink redraw storm) or
//     "few huge chunks" (initial flush, table dumps)? The chunk-size
//     histogram makes the difference visible.
//   - Are inter-arrival intervals dense enough to keep the webview main
//     thread saturated? The median-interval bucket tells us.
//   - Is the extension host's heap creeping under load? `process.memoryUsage()`
//     in every dump shows trend.
//
// The recording path is intentionally cheap: one integer counter increment,
// one histogram bucket bump, one timestamp diff. When the toggle is off the
// `Diagnostics` instance is `null` and `createPanel.js` skips the call
// entirely via optional chaining.
//
// Why no per-tab file logs / no telemetry endpoint: this is a personal
// debugging aid, not a production observability layer. The OutputChannel
// is enough to copy/paste back into an issue or session memo.

const vscode = require('vscode');
const { PerformanceObserver, constants: perfConstants } = require('perf_hooks');
const {
  newGcStats,
  newBlockStats,
  recordGcEntry,
  recordBlockSample,
} = require('./diagnosticsStats');

// Chunk size buckets in bytes. Tight on the small end because the gut
// hypothesis is "many tiny chunks". Last bucket is the catch-all.
const SIZE_BUCKETS = [
  { max: 64,        label: '≤64B' },
  { max: 256,       label: '65–256B' },
  { max: 1024,      label: '257B–1KB' },
  { max: 4096,      label: '1–4KB' },
  { max: 16 * 1024, label: '4–16KB' },
  { max: 65536,     label: '16–64KB' },
  { max: Infinity,  label: '>64KB' },
];

// Inter-arrival interval buckets (ms). The first bucket spans the typical
// Ink redraw cadence so we can see clusters that would saturate the
// webview's microtask queue.
const INTERVAL_BUCKETS = [
  { max: 8,    label: '≤8ms' },
  { max: 32,   label: '9–32ms' },
  { max: 100,  label: '33–100ms' },
  { max: 1000, label: '101–1000ms' },
  { max: Infinity, label: '>1s' },
];

// Default dump cadence. 10 min matches the user-stated "long idle before
// recovery" timescale — a freeze that started mid-window still shows up
// in the next dump within the same order of magnitude.
const DEFAULT_DUMP_INTERVAL_MS = 10 * 60 * 1000;

// v3.6.7: main thread block timer. A 1Hz setInterval that records the
// drift between its expected and actual fire time — if main thread was
// blocked for N seconds, the next tick fires N seconds late and we count
// that as one block sample. 500ms threshold filters out normal scheduler
// jitter (GC minor pauses, OS context switches) while catching the
// 7-60s pauses that v3.6.5 diagnostics revealed.
const DEFAULT_BLOCK_INTERVAL_MS = 1000;
const DEFAULT_BLOCK_THRESHOLD_MS = 500;

function bucketIndex(buckets, value) {
  for (let i = 0; i < buckets.length; i++) {
    if (value <= buckets[i].max) return i;
  }
  return buckets.length - 1;
}

function formatBytes(n) {
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
  return (n / 1024 / 1024).toFixed(2) + 'MB';
}

// Per-panel rolling counters. Reset after each dump so successive dumps
// describe the most recent interval rather than the lifetime — easier
// to correlate against a freeze the user just experienced.
function newPanelStats() {
  return {
    chunks: 0,
    bytes: 0,
    maxChunk: 0,
    sizeBuckets: SIZE_BUCKETS.map(() => 0),
    intervalBuckets: INTERVAL_BUCKETS.map(() => 0),
    lastTs: 0,
    // v3.6.3: most recent webview-side measurement. Not rolling — the
    // probe reports a snapshot every minute and we keep the latest value
    // so each dump shows where the webview's V8 context is right now.
    // Reset() carries these forward so they survive between dumps.
    webview: null, // { used, total, limit, xtermScrollback, readerDomCount, readerHtmlSize, reportedAt }
  };
}

class Diagnostics {
  constructor() {
    this.output = vscode.window.createOutputChannel(
      'CLI Launcher — Diagnostics',
    );
    // tabId → panelStats. We key on tabId not panel so closed-and-reopened
    // tabs don't leak entries; tabId is also the value the user sees in
    // the tab title, easy to correlate.
    this.byPanel = new Map();
    this.startedAt = Date.now();
    this.lastDumpAt = Date.now();
    this.dumpTimer = null;
    // v3.6.7: GC pause + main thread block measurement. Both reset per dump.
    this.gcStats = newGcStats();
    this.blockStats = newBlockStats();
    this.gcObserver = null;
    this.blockTimer = null;
    this.blockLastTick = 0;
    this.blockIntervalMs = DEFAULT_BLOCK_INTERVAL_MS;
    this.blockThresholdMs = DEFAULT_BLOCK_THRESHOLD_MS;
  }

  start(intervalMs = DEFAULT_DUMP_INTERVAL_MS) {
    if (this.dumpTimer) return;
    this.output.appendLine(
      `[${new Date().toISOString()}] diagnostics started (dump every ${(intervalMs / 1000).toFixed(0)}s)`,
    );
    // v3.6.7: PerformanceObserver for GC pauses. Stop-the-world major GCs
    // are the prime suspect for the residual freeze after v3.6.5 — this
    // counts them per dump window. `buffered: true` so entries that fire
    // in tight bursts don't get dropped.
    try {
      this.gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const kind = entry.kind != null
            ? entry.kind
            : (entry.detail && entry.detail.kind);
          recordGcEntry(this.gcStats, kind, entry.duration, perfConstants);
        }
      });
      this.gcObserver.observe({ entryTypes: ['gc'], buffered: true });
    } catch (_) {
      this.gcObserver = null;
    }
    // v3.6.7: 1Hz timer measuring its own scheduling drift. If main thread
    // is blocked for N seconds, the next tick lands N seconds late.
    this.blockLastTick = Date.now();
    this.blockTimer = setInterval(() => {
      const now = Date.now();
      const drift = now - this.blockLastTick - this.blockIntervalMs;
      recordBlockSample(this.blockStats, drift, this.blockThresholdMs);
      this.blockLastTick = now;
    }, this.blockIntervalMs);
    // Immediate snapshot so the user sees the baseline without waiting
    // a full interval — useful when toggling on right before reproducing
    // the freeze.
    this.dump('startup');
    this.dumpTimer = setInterval(() => this.dump('periodic'), intervalMs);
  }

  /** Record the latest webview-side memory snapshot for `tabId`. Called
   *  from messageRouter when the webview probe reports (default cadence
   *  60s). Stores the snapshot as-is; the next dump shows it under that
   *  panel. */
  recordWebviewMemory(tabId, msg) {
    let s = this.byPanel.get(tabId);
    if (!s) {
      s = newPanelStats();
      this.byPanel.set(tabId, s);
    }
    s.webview = {
      used: msg && msg.mem ? msg.mem.used : null,
      total: msg && msg.mem ? msg.mem.total : null,
      limit: msg && msg.mem ? msg.mem.limit : null,
      xtermScrollback: typeof msg.xtermScrollback === 'number' ? msg.xtermScrollback : null,
      readerDomCount: typeof msg.readerDomCount === 'number' ? msg.readerDomCount : null,
      readerHtmlSize: typeof msg.readerHtmlSize === 'number' ? msg.readerHtmlSize : null,
      reportedAt: Date.now(),
    };
  }

  /** Record a single PTY chunk arriving on `tabId`. Called from createPanel
   *  on every onData callback when the toggle is on. Kept hot-path small:
   *  three reads, three writes, one histogram bump. */
  recordChunk(tabId, byteLen) {
    let s = this.byPanel.get(tabId);
    if (!s) {
      s = newPanelStats();
      this.byPanel.set(tabId, s);
    }
    s.chunks++;
    s.bytes += byteLen;
    if (byteLen > s.maxChunk) s.maxChunk = byteLen;
    s.sizeBuckets[bucketIndex(SIZE_BUCKETS, byteLen)]++;
    const now = Date.now();
    if (s.lastTs > 0) {
      s.intervalBuckets[bucketIndex(INTERVAL_BUCKETS, now - s.lastTs)]++;
    }
    s.lastTs = now;
  }

  dump(kind) {
    const now = Date.now();
    const elapsedMs = now - this.lastDumpAt;
    this.lastDumpAt = now;
    const mem = process.memoryUsage();
    const lines = [];
    lines.push(
      `[${new Date(now).toISOString()}] dump=${kind} elapsed=${(elapsedMs / 1000).toFixed(1)}s`,
    );
    lines.push(
      `  heap: rss=${formatBytes(mem.rss)} heapUsed=${formatBytes(mem.heapUsed)} heapTotal=${formatBytes(mem.heapTotal)} external=${formatBytes(mem.external)}`,
    );
    // v3.6.7: GC + main thread block lines. Both are window-scoped (reset
    // after each dump). Major GC count + max-duration are the headline
    // numbers for diagnosing stop-the-world freezes.
    const g = this.gcStats;
    lines.push(
      `  gc: major count=${g.major.count} total=${g.major.totalMs.toFixed(0)}ms max=${g.major.maxMs.toFixed(0)}ms / minor count=${g.minor.count} total=${g.minor.totalMs.toFixed(0)}ms max=${g.minor.maxMs.toFixed(0)}ms`,
    );
    const b = this.blockStats;
    lines.push(
      `  main-thread blocks (drift>${this.blockThresholdMs}ms): count=${b.count} total=${b.totalMs.toFixed(0)}ms max=${b.maxMs.toFixed(0)}ms`,
    );
    lines.push(`  panels-recording: ${this.byPanel.size}`);
    if (this.byPanel.size === 0) {
      lines.push('  (no PTY traffic in this window)');
    } else {
      for (const [tabId, s] of this.byPanel) {
        // Show the panel block when either PTY traffic happened in this
        // window OR a webview probe snapshot exists. Silent panels with
        // nothing to report stay hidden.
        if (s.chunks === 0 && !s.webview) continue;
        if (s.chunks > 0) {
          const avg = (s.bytes / s.chunks).toFixed(0);
          const sizeHist = SIZE_BUCKETS.map((b, i) =>
            `${b.label}=${s.sizeBuckets[i]}`,
          ).join(' ');
          const intervalHist = INTERVAL_BUCKETS.map((b, i) =>
            `${b.label}=${s.intervalBuckets[i]}`,
          ).join(' ');
          lines.push(
            `  panel ${tabId}: chunks=${s.chunks} total=${formatBytes(s.bytes)} avg=${avg}B max=${formatBytes(s.maxChunk)}`,
          );
          lines.push(`    size:     ${sizeHist}`);
          lines.push(`    interval: ${intervalHist}`);
        } else {
          lines.push(`  panel ${tabId}: (no PTY traffic this window)`);
        }
        if (s.webview) {
          const w = s.webview;
          const ageS = ((Date.now() - w.reportedAt) / 1000).toFixed(0);
          const memPart = w.used != null
            ? `used=${formatBytes(w.used)} total=${formatBytes(w.total)} limit=${formatBytes(w.limit)}`
            : 'used=(N/A — performance.memory not exposed)';
          lines.push(`    webview-heap (age ${ageS}s): ${memPart}`);
          if (w.xtermScrollback != null) {
            lines.push(`    xterm-scrollback: ${w.xtermScrollback} lines`);
          }
          if (w.readerDomCount != null) {
            lines.push(`    reader: dom-nodes=${w.readerDomCount} html=${formatBytes(w.readerHtmlSize)}`);
          }
        }
      }
    }
    for (const line of lines) this.output.appendLine(line);
    // Reset rolling counters so the next dump is a fresh window. The
    // last-timestamp survives so the interval histogram for the next
    // window starts from the actual gap, not from zero.
    for (const [, s] of this.byPanel) {
      const carriedTs = s.lastTs;
      const carriedWebview = s.webview;
      Object.assign(s, newPanelStats());
      s.lastTs = carriedTs;
      s.webview = carriedWebview;
    }
    // v3.6.7: GC + block stats also reset per window.
    this.gcStats = newGcStats();
    this.blockStats = newBlockStats();
  }

  /** Drop a tab's counters when its panel disposes. */
  removePanel(tabId) {
    this.byPanel.delete(tabId);
  }

  /** Force a dump on demand — used by the user-invokable command. */
  dumpNow() {
    this.dump('manual');
    this.output.show(true);
  }

  dispose() {
    if (this.dumpTimer) {
      clearInterval(this.dumpTimer);
      this.dumpTimer = null;
    }
    if (this.blockTimer) {
      clearInterval(this.blockTimer);
      this.blockTimer = null;
    }
    if (this.gcObserver) {
      try { this.gcObserver.disconnect(); } catch (_) { /* already disconnected */ }
      this.gcObserver = null;
    }
    try { this.output.dispose(); } catch (_) { /* already disposed */ }
    this.byPanel.clear();
  }
}

module.exports = {
  Diagnostics,
  DEFAULT_DUMP_INTERVAL_MS,
  DEFAULT_BLOCK_INTERVAL_MS,
  DEFAULT_BLOCK_THRESHOLD_MS,
};
