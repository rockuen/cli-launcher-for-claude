// @module bin/lib/bracketedPaste — collapse a bracketed-paste burst into one
// readline line.
//
// Why: chief-repl drives input through Node's built-in `readline`. Unlike a real
// TUI (Claude Code, Codex, …) readline recognizes the bracketed-paste markers
// (`ESC[200~` / `ESC[201~`) only well enough to STRIP them — it still treats
// every embedded `\n` as a separate Enter, so a multi-line paste (or the
// launcher's textarea "submit-input", which wraps multi-line text in the same
// markers) is delivered to Chief as N separate messages. That is the
// "each line sent on its own" bug.
//
// Fix: pipe stdin through this Transform BEFORE readline. While inside a paste
// burst we buffer the body, normalize CRLF/CR to LF, and re-encode the newlines
// as a sentinel byte so readline sees ONE line. chief-repl decodes the sentinel
// back to real newlines on the `line` event via `decodePastedLine`. Bytes
// outside a paste (normal typing, slash commands, the trailing CR that submits)
// pass through untouched, so interactive editing/history is unaffected.

const { Transform } = require('stream');

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
// Newline placeholder carried through readline. Must be a character readline's
// keypress parser self-inserts into the line buffer: C0 controls like U+0000
// are classified as ctrl-combos (NUL → ctrl+`) and silently dropped, which is
// exactly the "lines glued together" bug. U+2063 INVISIBLE SEPARATOR is a
// plain printable to readline, zero-width in both Node's cursor math and
// xterm.js rendering (paste preview stays clean), and never typed by a
// keyboard.
const NL_SENTINEL = '\u2063';

// Largest k in [1, marker.length) such that `data` ends with marker.slice(0, k).
// Lets a marker that is split across two chunks be detected on the next chunk
// instead of leaking half of it to readline.
function partialTailLen(data, marker) {
  const max = Math.min(marker.length - 1, data.length);
  for (let k = max; k > 0; k--) {
    if (data.endsWith(marker.slice(0, k))) return k;
  }
  return 0;
}

function encodePasteBody(body) {
  // Drop any pre-existing sentinel chars so decode can't invent newlines the
  // user never pasted (U+2063 is invisible, so nothing visible is lost).
  return body.replace(new RegExp(NL_SENTINEL, 'g'), '')
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').join(NL_SENTINEL);
}

// Decode a readline `line` produced through the joiner back into its original
// multi-line form. Safe to call on any line (no-op when no paste occurred).
function decodePastedLine(line) {
  return String(line == null ? '' : line).split(NL_SENTINEL).join('\n');
}

function createPasteJoiner() {
  let inPaste = false;
  let pasteBuf = '';
  let residual = '';

  return new Transform({
    transform(chunk, _enc, cb) {
      let data = residual + chunk.toString('utf8');
      residual = '';
      let out = '';

      while (data.length) {
        if (!inPaste) {
          const i = data.indexOf(PASTE_START);
          if (i === -1) {
            const keep = partialTailLen(data, PASTE_START);
            out += data.slice(0, data.length - keep);
            residual = data.slice(data.length - keep);
            data = '';
          } else {
            out += data.slice(0, i);
            data = data.slice(i + PASTE_START.length);
            inPaste = true;
            pasteBuf = '';
          }
        } else {
          const j = data.indexOf(PASTE_END);
          if (j === -1) {
            const keep = partialTailLen(data, PASTE_END);
            pasteBuf += data.slice(0, data.length - keep);
            residual = data.slice(data.length - keep);
            data = '';
          } else {
            pasteBuf += data.slice(0, j);
            data = data.slice(j + PASTE_END.length);
            inPaste = false;
            out += encodePasteBody(pasteBuf);
            pasteBuf = '';
          }
        }
      }

      cb(null, out);
    },
  });
}

module.exports = {
  PASTE_START,
  PASTE_END,
  NL_SENTINEL,
  partialTailLen,
  encodePasteBody,
  decodePastedLine,
  createPasteJoiner,
};
