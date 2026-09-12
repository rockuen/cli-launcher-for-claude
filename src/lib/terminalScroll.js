// @module lib/terminalScroll — decide WHETHER a terminal pane follows the live
// bottom after new output or a relayout.
//
// v3.23.1 bug this exists for: the panel used to hard-pin every terminal to the
// bottom (`PIN_TERMINAL_TO_BOTTOM = true`), so `scrollToBottom()` ran after
// EVERY output chunk regardless of where the user was looking. Scrolling up in
// scrollback to read an earlier answer was useless — the next PTY chunk (and
// agent TUIs emit them constantly, even while idle) yanked the viewport back
// down. That pin was added to stop stale upper rows lingering after
// output/resize, but that symptom belongs to full-screen TUIs, which have no
// scrollback to get stuck in.
//
// Fix: follow the bottom only when the user is ALREADY at the bottom — standard
// terminal behavior: scroll up to pause, scroll back down to resume.
//
// Why there is no carve-out for the alternate screen or for scrollback-less
// panes (grok), even though those must always pin: they pin for free. xterm
// sizes a buffer with no scrollback to exactly `rows` (Buffer._getCorrectBuffer-
// Length), so BufferService.scroll() always takes its `willBufferBeTrimmed`
// branch and never increments `ybase` — leaving viewportY and baseY both at 0,
// which reads as "at the bottom" on every probe. An explicit branch for them
// would be dead code that cannot be exercised in a real panel.
//
// Why the probe is trustworthy even mid-redraw, which an earlier attempt
// (v3.7.3) got wrong: that one tracked intent through the `onScroll` EVENT,
// which a TUI's own redraw fires just as a user's wheel does — indistinguishable,
// so the follow flag flipped off and kiro stuck at the top (v3.7.13). Reading
// the buffer instead is not ambiguous. `ydisp < ybase` is reachable only via
// BufferService.scrollLines(negative), whose callers are all real user input
// (viewport wheel, PageUp/PageDown, selection drag, accessibility, public API);
// escape sequences go through scroll(), which moves ydisp up together with
// ybase and never sets isUserScrolling.
//
// The function is inlined verbatim into the webview client script via
// clientSource() so the browser-side scroll path and these unit tests exercise
// the same code. Keep it pure and self-contained (no closures, no template
// literals — the caller embeds it inside one).

function shouldFollowBottom(input) {
  var o = input || {};
  // Unknown position (xterm not ready / the probe threw) follows the bottom,
  // matching what a fresh pane does.
  return o.wasAtBottom !== false;
}

function clientSource() {
  return shouldFollowBottom.toString();
}

module.exports = { shouldFollowBottom, clientSource };
