// @module lib/ptyChunk — paces large PTY → webview chunks across event-loop turns.
//
// Why this exists:
//   A single 51KB PTY chunk (observed in the wild: box-drawing + a giant
//   table dump on session resume) used to be handed to `panel.webview.postMessage`
//   as one payload. The extension host serialized + marshalled + xterm-parsed
//   the whole thing on one tick of the main thread, which in combination with
//   chokidar event storms from `repoSync` would push the host into the
//   `unresponsive` state — every session frozen, no new sessions, no key input.
//
// Strategy:
//   - Small chunks (≤ SMALL_CHUNK) pass through unchanged (no overhead).
//   - Large chunks are sliced into PIECE_SIZE pieces, with `setImmediate`
//     between each so other pending tasks (other PTYs' data, user keystrokes,
//     command palette dispatch, status bar redraws) can run interleaved.
//   - Slice boundaries avoid splitting in the middle of an ANSI escape
//     sequence. xterm.js's parser does buffer partial escapes correctly, but
//     respecting boundaries keeps the IPC payloads self-contained and reduces
//     edge-case risk on third-party terminal frontends.

// Chunks ≤ this size are sent as a single message — the splitting machinery
// would only add overhead. Tuned to roughly one normal Claude Code render
// frame (header + a few lines of output).
const SMALL_CHUNK = 4096;

// Each piece sent to the webview. Small enough that one IPC roundtrip is
// well under a frame; large enough that the per-piece overhead doesn't
// dominate on huge payloads.
const PIECE_SIZE = 4096;

// Backwards scan window when looking for a safe ANSI boundary. CSI sequences
// (`\x1b[ ... <final>`) are usually <16 bytes; OSC sequences (title set,
// hyperlinks) can be longer but still well under this window.
const ANSI_SAFE_SCAN = 128;

// Look for an ANSI escape sequence straddling the proposed split point. If
// found, push the boundary past the end of the sequence so we never cut
// inside `\x1b[31m` or similar. Returns the chosen split index.
function findSafeBoundary(data, target) {
  if (typeof data !== 'string') return target;
  if (target >= data.length) return data.length;
  const scanStart = Math.max(0, target - ANSI_SAFE_SCAN);
  for (let i = target - 1; i >= scanStart; i--) {
    if (data.charCodeAt(i) !== 0x1b) continue;
    // Found an ESC. Determine where this escape sequence ends.
    const next = i + 1 < data.length ? data.charCodeAt(i + 1) : -1;
    let j;
    if (next === 0x5b /* '[' CSI */) {
      j = i + 2;
      while (j < data.length && j < i + ANSI_SAFE_SCAN) {
        const c = data.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) { j++; break; }
        j++;
      }
    } else if (next === 0x5d /* ']' OSC */) {
      j = i + 2;
      while (j < data.length && j < i + ANSI_SAFE_SCAN) {
        const c = data.charCodeAt(j);
        if (c === 0x07 /* BEL */) { j++; break; }
        if (c === 0x1b && j + 1 < data.length && data.charCodeAt(j + 1) === 0x5c /* ST */) {
          j += 2; break;
        }
        j++;
      }
    } else if (next === -1) {
      // Lone trailing ESC — defer the rest of the payload to the next slice.
      return i;
    } else {
      // ESC + single intermediate (e.g. `\x1b=`, `\x1b>`).
      j = i + 2;
    }
    if (j > target) return Math.min(j, data.length);
    return target; // sequence completed before target, safe to cut here
  }
  return target;
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Send a PTY chunk to the webview, paced so the host stays responsive on
// huge payloads. Fire-and-forget; failures (panel disposed mid-flush) are
// silently swallowed to match the rest of the codebase's postMessage style.
async function sendPtyChunkPaced(panel, data, entry) {
  if (!panel || !data || data.length === 0) return;
  const isDisposed = () => entry && entry._disposed;
  if (data.length <= SMALL_CHUNK) {
    if (isDisposed()) return;
    try { panel.webview.postMessage({ type: 'output', data }); } catch (_) {}
    return;
  }
  let offset = 0;
  while (offset < data.length) {
    if (isDisposed()) return;
    const target = Math.min(offset + PIECE_SIZE, data.length);
    const end = findSafeBoundary(data, target);
    // findSafeBoundary may legally return `offset` itself when the chunk
    // ends with a lone ESC partial — guard against an infinite loop by
    // forcing forward progress in that case.
    const cut = end > offset ? end : Math.min(offset + PIECE_SIZE, data.length);
    const piece = data.slice(offset, cut);
    try { panel.webview.postMessage({ type: 'output', data: piece }); } catch (_) {}
    offset = cut;
    if (offset < data.length) await yieldToEventLoop();
  }
}

module.exports = {
  sendPtyChunkPaced,
  findSafeBoundary,
  yieldToEventLoop,
  SMALL_CHUNK,
  PIECE_SIZE,
  ANSI_SAFE_SCAN,
};
