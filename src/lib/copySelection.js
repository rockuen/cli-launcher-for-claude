// @module lib/copySelection — decide WHICH selection a panel-level Ctrl+C copies.
//
// v3.20.8 bug this exists for: the panel installs one document-level Ctrl+C
// handler (webviewClient) because xterm's own key handler misses drag-selects
// that leave focus on the viewport div. That handler used to resolve the text
// as `termSelection || cachedTermSelection || domSelection`, which broke Reader
// copies two ways:
//
//   1. A whitespace-only terminal selection (dragging across the blank rows a
//      line-based REPL like Chief leaves on screen) is a NON-EMPTY string, so
//      it won a truthiness test and the clipboard received "\n\n" — the copy
//      looked successful and pasting produced nothing.
//   2. xterm keeps its selection when you click outside #terminal, so any
//      earlier terminal selection outranked the Reader text the user had just
//      highlighted — the clipboard got stale terminal output instead.
//
// Fix: origin decides priority (a Ctrl+C fired inside #terminal prefers the
// terminal selection, everywhere else prefers the live DOM selection), and
// blank-only candidates never count as a selection.
//
// The function is inlined verbatim into the webview client script via
// clientSource() so the browser-side copy path and these unit tests exercise
// the same code. Keep it pure and self-contained (no closures, no template
// literals — the caller embeds it inside one).

function resolveCopyText(input) {
  var o = input || {};
  var pick = function (v) {
    var s = typeof v === 'string' ? v : '';
    return s.trim() ? s : '';
  };
  var term = pick(o.termSelection);
  var cached = pick(o.cachedTermSelection);
  var dom = pick(o.domSelection);
  if (o.fromTerminal) return term || cached || dom;
  return dom || term || cached;
}

function clientSource() {
  return resolveCopyText.toString();
}

module.exports = { resolveCopyText, clientSource };
