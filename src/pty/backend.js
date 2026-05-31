// @module pty/backend — the session-backend seam.
//
// WHY THIS EXISTS:
//   The panel (createPanel.js / restartPty.js) used to call `pty.spawn(...)`
//   inline and then treat the returned node-pty handle (`entry.pty`) as the one
//   and only way to drive a Claude session. That hard-wires the whole extension
//   to "spawn the claude CLI in a terminal and screen-scrape its TUI". This
//   module introduces a thin BACKEND seam so the panel talks to an abstract
//   "session backend" instead of a raw pty. Today the only backend is the pty
//   one; a future SdkBackend can drive Claude through @anthropic-ai/claude-agent-sdk
//   (structured messages, no terminal) by implementing the same surface.
//
// THE BACKEND SURFACE (what callers depend on — kept node-pty-compatible on
// purpose so the existing downstream code stays untouched):
//   onData(cb: (data: string) => void): IDisposable      // output stream
//   onExit(cb: (e: { exitCode: number }) => void): IDisposable
//   write(data: string): void                            // user input
//   resize(cols: number, rows: number): void             // SdkBackend: no-op
//   kill(): void
//   get pid(): number | undefined                        // SdkBackend: undefined (liveness via iterator)
//   backendKind: 'pty' | 'sdk'                            // discriminator
//   muxSessionName: string | null                        // pty/multiplexer only
//
// DESIGN NOTE (zero-behaviour-change step): a PtyBackend IS a node-pty IPty
// with two inert metadata fields tagged on. We deliberately do NOT wrap it in a
// forwarding proxy yet — the IPty already satisfies the surface 1:1, so
// returning it directly keeps `entry.pty.write/.resize/.onData/.onExit/.pid/
// .kill`, the `entry.pty !== initialPty` identity guard, and `entry.pty = null`
// byte-for-byte identical. When the SdkBackend lands (which genuinely cannot be
// an IPty), both paths get a real wrapper object and `entry.pty` can be renamed
// to `entry.backend`. Until then this is a pure extraction: spawn options live
// in one place and the seam is named.

const SPAWN_NAME = 'xterm-256color';

// Build the spawn env the same way both call sites did: inherit the process
// env and force colour so the TUI renders ANSI. Read at spawn time (matches the
// previous inline behaviour).
function spawnEnv() {
  return { ...process.env, FORCE_COLOR: '1' };
}

// Spawn the claude CLI (optionally wrapped by a multiplexer) and return a
// pty-backed Backend. Throws on spawn failure — callers keep their existing
// try/catch so the posix_spawnp / "run npm rebuild" guidance is unchanged.
//
// opts: { spawnBin, spawnArgs, cwd, cols, rows, muxSessionName? }
function createPtyBackend(opts) {
  const pty = require('node-pty');
  const ptyProcess = pty.spawn(opts.spawnBin, opts.spawnArgs, {
    name: SPAWN_NAME,
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: spawnEnv(),
  });
  // IPty already exposes onData/onExit/write/resize/kill/pid. Tag the two
  // metadata fields the seam adds; everything else is the real pty, so callers
  // that keep using entry.pty.* see no behavioural difference.
  ptyProcess.backendKind = 'pty';
  ptyProcess.muxSessionName = opts.muxSessionName || null;
  return ptyProcess;
}

// Backend factory / dispatcher. The single place the panel asks for a session
// backend. Adding SDK mode is a new `case 'sdk'` here returning an SdkBackend
// that implements the surface above — createPanel/restartPty don't change again.
//
// opts: { kind?: 'pty' | 'sdk', ...backend-specific }
function createBackend(opts) {
  const kind = (opts && opts.kind) || 'pty';
  switch (kind) {
    case 'pty':
      return createPtyBackend(opts);
    case 'sdk':
      // Reserved for the Claude Agent SDK backend (see C-feasibility analysis).
      throw new Error("createBackend: 'sdk' backend is not implemented yet");
    default:
      throw new Error('createBackend: unknown backend kind: ' + kind);
  }
}

module.exports = { createBackend, createPtyBackend };
