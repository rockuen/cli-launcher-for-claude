// Numbered-choice prompt detection for Claude Code's interactive menus
// (theme picker, login method, /model, /resume, permission prompts — all
// rendered through Ink's Select component).
//
// WHY THIS IS A SEPARATE MODULE: kept vscode-free and pure so it can be
// unit-tested directly (same pattern as sessionDecorationCore.js). It is
// required by createPanel.js's coalesced parse path.
//
// THE TRAP (why the 2026-05-03 attempt was rolled back): Ink/Yoga draws
// inter-word gaps as CHA cursor moves (\x1b[<N>G), NOT spaces. So a naive
// ANSI strip glues words together — "1.Auto(matchterminal)" — and the
// classic /\d+\.\s+\w+/ match never fires. The fix is to translate CHA to
// a single space FIRST, then strip the rest of the escape soup. Verified
// against a real PTY capture of the v2.1.158 theme picker: 7/7 options
// extracted, selected row identified by the ❯ (U+276F) caret in column 2.

// Turn one raw terminal line into readable text: CHA → space (restore word
// separation), then drop OSC / remaining CSI / 2-char escapes / charset
// selects. SGR colours, cursor moves, etc. all vanish; the visible glyphs
// (including box-drawing and the ❯ caret) survive.
function normalizeChoiceLine(s) {
  return String(s == null ? '' : s)
    .replace(/\x1b\[\d*G/g, ' ')                         // CHA → space
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')   // OSC ... BEL/ST
    .replace(/\x1b\[[0-9;?>=]*[A-Za-z]/g, '')            // remaining CSI
    .replace(/\x1b[78>=cZ]/g, '')                        // ESC 7/8/>/=/c/Z
    .replace(/\x1b\([AB0]/g, '');                        // charset selects
}

// Marker glyphs Ink uses for the highlighted row. ❯ is what v2.1.158 emits;
// → is accepted defensively in case a theme/older build differs.
var CARET_RE = /[❯→]/;
// A menu row: optional caret, then "N." (the dot is essential — it's what
// rejects code line-numbers like "1function" / "2 console.log"), then a
// non-empty label.
var OPTION_RE = /^\s*([❯→])?\s*(\d{1,2})\.\s+(\S.*?)\s*$/;

// Detect a numbered choice menu in a (coalesced) PTY payload. Returns
// { options: [{num,label}], selectedNum, count } or null.
//
// Guards against false positives (assistant text that happens to contain a
// "1. ... 2. ..." list):
//   1. a ❯/→ caret must be present somewhere in the raw payload, AND
//   2. the option numbers must form a clean ascending run 1..K (K>=2), AND
//   3. exactly the run must carry the caret on one of its rows.
// An interactive menu always satisfies all three; prose lists do not.
function detectChoicePrompt(data) {
  var raw = String(data == null ? '' : data);
  if (!CARET_RE.test(raw)) return null;

  // Split on CR and/or LF. CRUCIAL: Ink's dynamic menus (/theme, /model,
  // /resume) delimit rows with bare CR (\r) and emit NO line feeds at all,
  // so a /\r?\n/ split collapses the whole menu into one unmatchable line.
  // The onboarding/trust prompts happen to include LF — which is exactly
  // why those detected but /theme silently did not. Verified against a live
  // v2.1.158 /theme capture: 20 CRs, 0 LFs.
  var lines = raw.split(/[\r\n]+/);
  var options = [];
  var selectedIndex = -1;
  for (var i = 0; i < lines.length; i++) {
    var norm = normalizeChoiceLine(lines[i]).replace(/\s{2,}/g, ' ');
    var m = OPTION_RE.exec(norm);
    if (!m) continue;
    var selected = !!m[1];
    options.push({ num: parseInt(m[2], 10), label: m[3].trim(), selected: selected });
    if (selected) selectedIndex = options.length - 1;
  }

  // Ink Select draws ↑/↓ scroll indicators when the menu is taller than the
  // terminal viewport — only a WINDOW of options is visible, the rest clipped.
  // This drives validation (a clipped window can legitimately start mid-list)
  // and lets the panel briefly enlarge the pty to capture the full list.
  var truncated = /[↑↓]/.test(raw);

  if (options.length < 1) return null;
  // A lone option is only a menu if Ink also drew a scroll indicator (more are
  // clipped below/above); otherwise "1. foo" on its own is just prose.
  if (options.length === 1 && !truncated) return null;
  // Numbers must be contiguous. A fully-visible menu starts at 1; a CLIPPED
  // window can start mid-list because Ink's sliding window shows e.g. options
  // 2,3,4 around the caret. Requiring start-at-1 there is exactly why a tiny
  // terminal pane (1 visible option, num=2) detected nothing and never even
  // triggered the enlarge.
  for (var j = 1; j < options.length; j++) {
    if (options[j].num !== options[j - 1].num + 1) return null;
  }
  if (!truncated && options[0].num !== 1) return null;
  // No caret on any row → not a live menu (just a rendered list). Reject.
  if (selectedIndex === -1) return null;

  return {
    options: options.map(function (o) { return { num: o.num, label: o.label }; }),
    selectedNum: options[selectedIndex].num,
    count: options.length,
    truncated: truncated,
  };
}

module.exports = { normalizeChoiceLine: normalizeChoiceLine, detectChoicePrompt: detectChoicePrompt };
