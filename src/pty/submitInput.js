// @module pty/submitInput — build a reliable PTY payload for launcher textarea submits.
//
// Direct terminal typing still goes through raw `input` messages. This helper is
// only for the launcher-owned textarea/Reader submit surfaces, where the user
// expects "paste this prompt, then press Enter" as one action.

function normalizeSubmitText(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

const DEFAULT_ENTER_DELAY_MS = 120;
const CODEX_ENTER_DELAY_MS = 300;

function shouldUseBracketedPaste(agent, text) {
  // Codex has its own paste-burst detector. Explicitly marking even a
  // single-line launcher submit as a paste keeps the following Enter out of
  // that detector; every agent still needs bracketed paste for real newlines.
  return agent === 'codex' || text.includes('\n');
}

function buildSubmitInputWrites(text, opts = {}) {
  const normalized = normalizeSubmitText(text);
  if (!normalized.trim()) return [];

  const pastePayload = shouldUseBracketedPaste(opts.agent, normalized)
    ? '\x1b[200~' + normalized + '\x1b[201~'
    : normalized;

  // claude, codex, kiro, grok, and gjc all use a deferred Enter: their
  // readline/TUI implementations on macOS have a race where text + CR in the
  // same PTY write can miss the submit. Send text first, then CR after a short
  // delay. Codex gets a little longer because its paste composer can still be
  // finalizing a paste after the bytes have arrived. messageRouter applies the
  // Codex delay after the prompt write fully drains, not from write start.
  // (gjc is an opencode-style Ink TUI, same as the others here.)
  if (opts.agent === 'claude' || opts.agent === 'codex' || opts.agent === 'kiro' || opts.agent === 'grok' || opts.agent === 'gjc') {
    return [
      { data: pastePayload, delayMs: 0 },
      { data: '\r', delayMs: opts.agent === 'codex' ? CODEX_ENTER_DELAY_MS : DEFAULT_ENTER_DELAY_MS },
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

function writeSubmitInput(entry, text, writePty, schedule = setTimeout) {
  const writes = buildSubmitInputWrites(text, { agent: entry && entry.agent });
  if (!writes.length) return false;

  // Codex finalizes pasted text asynchronously. Its Enter delay must start
  // after the full (possibly chunked) prompt has drained to the PTY; a
  // wall-clock timer started now can expire while a long prompt is still being
  // written, making CR arrive immediately after the last chunk.
  if (entry.agent === 'codex' && writes.length === 2 && writes[1].delayMs > 0) {
    writePty(entry, writes[0].data, { afterDelayMs: writes[1].delayMs });
    writePty(entry, writes[1].data);
    return true;
  }

  let delay = 0;
  for (const write of writes) {
    delay += write.delayMs || 0;
    if (delay > 0) {
      schedule(() => {
        if (entry.pty && !entry._disposed) writePty(entry, write.data);
      }, delay);
    } else {
      writePty(entry, write.data);
    }
  }
  return true;
}

module.exports = {
  buildSubmitInputWrites,
  buildSubmitInputPayload,
  writeSubmitInput,
  normalizeSubmitText,
  shouldUseBracketedPaste,
  DEFAULT_ENTER_DELAY_MS,
  CODEX_ENTER_DELAY_MS,
};
