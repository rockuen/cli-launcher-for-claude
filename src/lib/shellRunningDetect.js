// @module lib/shellRunningDetect — parse Claude Code "N shells still running"
// hints out of raw PTY chunks so the panel can paint a blue tab dot when a
// background shell is the only thing keeping the session alive.
//
// The signal we match on is the line Claude Code prints after a turn whenever
// it left a background shell going (e.g.
//   `* Baked for 6m 49s · 1 shell still running`).
// We strip ANSI escape sequences first so colored output also matches.

const ANSI_RE = /\x1b\[[\d;?]*[a-zA-Z]/g;
const SHELL_RE = /(\d+)\s+shells?\s+still\s+running/i;
const TAIL_LIMIT = 1500;

function detectShellRunning(data) {
  if (typeof data !== 'string' || data.length === 0) return null;
  const tail = data.length > TAIL_LIMIT ? data.slice(-TAIL_LIMIT) : data;
  const stripped = tail.replace(ANSI_RE, '');
  const m = stripped.match(SHELL_RE);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

module.exports = { detectShellRunning };
