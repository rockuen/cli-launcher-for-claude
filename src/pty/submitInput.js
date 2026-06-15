// @module pty/submitInput — build a reliable PTY payload for launcher textarea submits.
//
// Direct terminal typing still goes through raw `input` messages. This helper is
// only for the launcher-owned textarea/Reader submit surfaces, where the user
// expects "paste this prompt, then press Enter" as one action.

function normalizeSubmitText(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function shouldUseBracketedPaste(_agent, text) {
  return text.includes('\n');
}

function buildSubmitInputWrites(text, opts = {}) {
  const normalized = normalizeSubmitText(text);
  if (!normalized.trim()) return [];

  const pastePayload = shouldUseBracketedPaste(opts.agent, normalized)
    ? '\x1b[200~' + normalized + '\x1b[201~'
    : normalized;

  // claude, codex, and kiro all use a deferred Enter: their readline/TUI
  // implementations on macOS have a race where text + CR in the same PTY write
  // can miss the submit. Send text first, then CR after a short delay.
  if (opts.agent === 'claude' || opts.agent === 'codex' || opts.agent === 'kiro') {
    return [
      { data: pastePayload, delayMs: 0 },
      { data: '\r', delayMs: 120 },
    ];
  }

  if (shouldUseBracketedPaste(opts.agent, normalized)) {
    return [{ data: pastePayload + '\r', delayMs: 0 }];
  }
  return [{ data: normalized + '\r', delayMs: 0 }];
}

function buildSubmitInputPayload(text, opts = {}) {
  return buildSubmitInputWrites(text, opts).map(w => w.data).join('');
}

module.exports = {
  buildSubmitInputWrites,
  buildSubmitInputPayload,
  normalizeSubmitText,
  shouldUseBracketedPaste,
};
