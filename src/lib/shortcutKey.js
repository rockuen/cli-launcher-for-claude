// @module lib/shortcutKey — is this keydown Ctrl/Cmd + <letter>, whatever the
// input mode?
//
// The panel matched shortcuts with `e.key === 'c'`. With the Korean IME in
// Hangul mode e.key is the jamo on that key ('ㅊ' for C), and Caps Lock makes
// it 'C', so the launcher's own Ctrl+C handler skipped the key. VS Code's
// webview host (pre/index.html) matches copy/paste/cut by keyCode (67/86/88)
// instead, took the key, and ran its copy command — which, when the page body
// has focus (after a drag in the reader), first re-focuses the last focused
// element (the terminal or the message box). That collapses the reader
// selection, so Ctrl+C copied nothing while the menu's Copy worked.
//
// Match the way VS Code does: by keyCode (the layout's virtual key, so a
// Dvorak user's Ctrl+C still counts), or by e.key in any case, or — while an
// IME is composing (keyCode 229) — by the physical key.
//
// Inlined verbatim into the webview scripts via clientSource(), so keep it
// self-contained: no closures over module scope, no template literals.

function shortcutKeyIs(e, letter) {
  if (!e || !letter) return false;
  var upper = String(letter).toUpperCase();
  var key = typeof e.key === 'string' ? e.key.toUpperCase() : '';
  if (key === upper) return true;
  // AltGr arrives as Ctrl+Alt and types a character on many layouts
  // (Czech/Hungarian AltGr+F = "[", AltGr+V = "@"): with Alt held only the
  // character itself counts, never the key position.
  if (e.altKey) return false;
  if (e.keyCode === upper.charCodeAt(0)) return true;
  return e.keyCode === 229 && e.code === 'Key' + upper;
}

function clientSource() {
  return shortcutKeyIs.toString();
}

module.exports = { shortcutKeyIs, clientSource };
