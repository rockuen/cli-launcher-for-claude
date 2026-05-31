// @module lib/promptAffordance — conservative "is Claude waiting for the user?"
// detector. Used ONLY to fire a desktop notification (no inline buttons).
//
// WHY THIS REPLACES THE SELECTORS:
//   The old inline responders (detectBinaryPrompt → prompt-bar, detectChoicePrompt
//   → choice-bar) screen-scraped raw PTY bytes to REBUILD the menu as clickable
//   buttons. That needs the parse to be exactly right, and it mis-fired on plain
//   text / source code (bare "(y/n)" in prose, code line-numbers read as options).
//   We dropped the buttons. This detector only answers a yes/no question — "does
//   the screen show an interactive prompt waiting on the user?" — so its worst
//   failure is one extra notification, never a wrong button.
//
// HOW IT STAYS ROBUST:
//   1. IDLE-GATED by the caller: only run when output has settled, so the
//      "esc to interrupt" footer shown WHILE Claude is generating never reaches
//      it (that footer is gone by the time the screen is idle).
//   2. Keyed on Claude Code's distinctive interactive FOOTERS — phrases that
//      ordinary assistant prose and source code essentially never contain
//      ("Press Enter to confirm", "to use this session only", "Do you trust…"),
//      NOT a bare "y/n" token (the old false-positive source).
//   3. A numbered Ink-Select menu must show the caret row AND ≥2 options, so a
//      user typing a single "1. …" line into the prompt box can't trip it.
//
// Pure + unit-tested (test/unit/promptAffordance.test.js).

// Strip ANSI so footer phrases are matchable. CHA cursor-moves become spaces
// (Ink draws inter-word gaps that way), then OSC/CSI/charset/control bytes go.
function stripAnsi(s) {
  return String(s == null ? '' : s)
    .replace(/\x1b\[\d*G/g, ' ')                        // CHA cursor-move → space
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')  // OSC … BEL/ST
    .replace(/\x1b\[[0-9;?>=]*[A-Za-z]/g, '')           // CSI (colour, cursor, erase)
    .replace(/\x1b\([AB0]/g, '')                        // charset selects
    .replace(/\x1b[78>=cZ]/g, '')                       // misc ESC
    .replace(/[\x00-\x08\x0e-\x1f\x7f]/g, ' ');         // stray controls → space
}

// High-confidence interactive footers, priority order. Each marks Claude as
// BLOCKED on user input. "esc to interrupt" is deliberately excluded — that is
// the generating state, and idle-gating already filters it, but we leave it out
// of the patterns too for belt-and-suspenders.
var FOOTER_PATTERNS = [
  { kind: 'trust',   re: /do you (?:want to (?:proceed|continue)|trust (?:the|this|these))/i },
  { kind: 'confirm', re: /press enter to (?:confirm|continue|select|accept|retry|run)/i },
  { kind: 'confirm', re: /enter to (?:confirm|select|accept|submit|set as default)/i },
  { kind: 'menu',    re: /to use this session only/i },                  // /model menu footer
  { kind: 'menu',    re: /\besc to (?:cancel|go back|exit|dismiss)\b/i }, // NOT "interrupt"
  { kind: 'menu',    re: /[↑↓][^\n]{0,6}to (?:navigate|select|move|cycle)/i },
  { kind: 'binary',  re: /\?[\s)\]]*\s*(?:\[y\/n\]|\[y\/N\]|\[Y\/n\]|\(y\/n\)|\(yes\/no\))/i },
];

// A numbered Ink Select menu: a caret row "❯ N. label" AND ≥2 numbered option
// rows total. The two-option floor stops a single user-typed "1. foo" line in
// the input box (which also starts with ❯) from registering as a menu.
function looksLikeNumberedMenu(text) {
  // Scope to the current screen bottom — a waiting menu sits at the viewport
  // bottom. This keeps stray numbered lines elsewhere in the 6KB tail (e.g. an
  // assistant-printed ordered list far above) from summing to a false "menu".
  var tail = text.split('\n').slice(-25).join('\n');
  if (!/(?:^|\n)[^\S\n]*[❯➤]\s*\d{1,2}\.\s+\S/.test(tail)) return false;
  var rows = tail.match(/(?:^|\n)[^\S\n]*[❯➤]?\s*\d{1,2}\.\s+\S/g) || [];
  return rows.length >= 2;
}

// Return { kind, marker } when the (already-idle) screen tail shows an
// interactive prompt waiting for the user, else null. `marker` is a short
// stable string the caller dedupes on so menu-navigation redraws don't
// re-notify for the same prompt.
function detectPromptAffordance(rawTail) {
  // Normalize CR row-delimiters to LF. Ink's dynamic menus (/theme, /model)
  // delimit option rows with a bare CR and emit no LF, so the line-anchored
  // menu check below needs CR treated as a newline.
  var text = stripAnsi(rawTail).replace(/\r\n?/g, '\n');
  for (var i = 0; i < FOOTER_PATTERNS.length; i++) {
    var m = FOOTER_PATTERNS[i].re.exec(text);
    if (m) return { kind: FOOTER_PATTERNS[i].kind, marker: m[0].trim().slice(0, 48).toLowerCase() };
  }
  if (looksLikeNumberedMenu(text)) return { kind: 'menu', marker: 'numbered-select' };
  return null;
}

module.exports = {
  detectPromptAffordance: detectPromptAffordance,
  stripAnsi: stripAnsi,
};
