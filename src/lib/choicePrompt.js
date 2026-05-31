// Numbered-choice prompt detection for Claude Code's interactive menus
// (theme picker, login method, /model, /resume, permission prompts — all
// rendered through Ink's Select component).
//
// WHY THIS IS A SEPARATE MODULE: kept vscode-free and pure so it can be
// unit-tested directly (same pattern as sessionDecorationCore.js). It is
// required by createPanel.js's coalesced parse path.
//
// THE TRAPS (learned from real PTY captures, v2.1.158):
//  1. Ink draws inter-word gaps as CHA cursor moves (\x1b[<N>G), NOT spaces —
//     a naive ANSI strip glues words ("1.Auto(matchterminal)"). Fix: turn CHA
//     into a space FIRST, then strip the rest.
//  2. Dynamic menus delimit rows with bare CR and emit NO LF — split on both.
//  3. NON-selected rows in some menus (login method) render the number with
//     NO dot, just "2"+CHA. So an option is "a number immediately followed by
//     '.' OR a CHA", not "number + dot". Code line-numbers render "1"+SGR or
//     "1"+space, which this still excludes.

// Turn one raw terminal line into readable text: CHA → space (restore word
// separation), then drop OSC / remaining CSI / 2-char escapes / charset
// selects / stray control chars (SI/SO). Visible glyphs (incl. box-drawing
// and the ❯ caret) survive.
function normalizeChoiceLine(s) {
  return String(s == null ? '' : s)
    .replace(/\x1b\[\d*G/g, ' ')                         // CHA → space
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')   // OSC ... BEL/ST
    .replace(/\x1b\[[0-9;?>=]*[A-Za-z]/g, '')            // remaining CSI
    .replace(/\x1b[78>=cZ]/g, '')                        // ESC 7/8/>/=/c/Z
    .replace(/\x1b\([AB0]/g, '')                         // charset selects
    .replace(/[\x00-\x08\x0e-\x1f\x7f]/g, '');           // stray controls (SI/SO)
}

var CARET_RE = /[❯→]/;
// Option delimiter, checked on the RAW line: a number immediately followed by
// '.' OR a CHA cursor-move (\x1b[<n>G). Theme rows render "1."; login/other
// menus render non-selected rows as "2"+CHA with NO dot. Code line-numbers
// render "1"+SGR (\x1b[..m) or "1"+space, so requiring '.'-or-CHA right after
// the digit keeps them out.
var OPT_DELIM = /(\d{1,2})(?:\.|\x1b\[\d*G)/;
// After normalize: optional caret, number, dot-or-space(s), then label.
var OPT_NORM = /^([❯→])?\s*(\d{1,2})[.\s]+(\S.*)$/;
// A line that is ONLY box-drawing / block / rule chars (a separator), used to
// skip decoration when collecting the header.
var BOX_ONLY = /^[\s·‐-―─-▟.\-_=]+$/;

// Detect a numbered choice menu in a (coalesced) PTY payload. Returns
// { options:[{num,label}], selectedNum, count, truncated, header } or null.
//
// False-positive guards (prose / code that contains "1. ... 2. ..."):
//   1. a ❯/→ caret somewhere in the payload, AND
//   2. each option line passes BOTH the raw delimiter (number+dot/CHA) AND the
//      normalized shape (starts with the number), AND
//   3. numbers form a contiguous run (starting at 1 unless clipped), AND
//   4. one of the rows carries the caret.
function detectChoicePrompt(data) {
  var raw = String(data == null ? '' : data);
  if (!CARET_RE.test(raw)) return null;

  // ↑/↓ scroll indicators ⇒ the menu is taller than the viewport and only a
  // window is shown (lets a clipped window start mid-list, and the panel keep
  // the terminal tall enough to render the rest).
  var truncated = /[↑↓]/.test(raw);

  var rawLines = raw.split(/[\r\n]+/);
  var options = [];
  var optLineIdx = [];
  var selectedIndex = -1;

  for (var i = 0; i < rawLines.length; i++) {
    var line = rawLines[i];
    var delim = OPT_DELIM.exec(line);
    if (!delim) continue;
    var norm = normalizeChoiceLine(line).replace(/\s{2,}/g, ' ').trim();
    var nm = OPT_NORM.exec(norm);
    if (!nm) continue;
    var num = parseInt(nm[2], 10);
    if (num !== parseInt(delim[1], 10)) continue; // same number raw vs normalized
    options.push({ num: num, label: nm[3].trim(), selected: !!nm[1] });
    optLineIdx.push(i);
    if (nm[1]) selectedIndex = options.length - 1;
  }

  if (options.length < 1) return null;
  // A lone option is only a menu if Ink drew a scroll indicator (more clipped).
  if (options.length === 1 && !truncated) return null;
  // Contiguous numbering. Full menu starts at 1; a clipped window can start
  // mid-list (Ink shows e.g. 2,3,4 around the caret).
  for (var j = 1; j < options.length; j++) {
    if (options[j].num !== options[j - 1].num + 1) return null;
  }
  if (!truncated && options[0].num !== 1) return null;
  if (selectedIndex === -1) return null;

  // Header: meaningful text above the first option (the question — "Choose
  // the text style…", "Select login method:"). Skip blanks and box-drawing /
  // rule lines; keep the last 2 so the question survives a title/subtitle.
  var headerCand = [];
  for (var k = 0; k < optLineIdx[0]; k++) {
    var h = normalizeChoiceLine(rawLines[k]).replace(/\s{2,}/g, ' ').trim();
    if (!h || BOX_ONLY.test(h)) continue;
    headerCand.push(h);
  }
  var header = headerCand.slice(-2).join(' · ');

  return {
    options: options.map(function (o) { return { num: o.num, label: o.label }; }),
    selectedNum: options[selectedIndex].num,
    count: options.length,
    truncated: truncated,
    header: header,
  };
}

module.exports = { normalizeChoiceLine: normalizeChoiceLine, detectChoicePrompt: detectChoicePrompt };
