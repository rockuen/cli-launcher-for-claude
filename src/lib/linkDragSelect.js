// @module lib/linkDragSelect — a drag that starts on a reader link selects text.
//
// The reader turns every path it sees into a link (auto-link), so the paths
// people want to drag-select for Open File / Open Folder are links. Chrome
// never starts a text selection from a link (HTMLAnchorElement refuses to be
// a selection start), and since 3.28.2 links don't drag either, so a press on
// a link that moved did nothing at all — the only way to select a path was to
// start the drag in the plain text next to it. Neither CSS (user-select:
// text, draggable=false, -webkit-user-drag: none, alone or together) changes
// that; checked in Chrome with raw CDP mouse input.
//
// So the gesture is handled here: a left press on a link (no modifier) is
// taken over (preventDefault — otherwise Chrome starts dragging the selection
// we build as soon as it sits under the pointer), and once the pointer moves
// 4px — the same threshold the readers' click guard uses — the selection runs
// from the press point to the pointer, caret position to caret position. Once
// past 4px the press stays a drag: its click is swallowed even if the pointer
// came back over the press point. A plain click and a wobble under 4px still
// open the link. Alt+drag (Chrome's own link-text gesture), Shift/Ctrl/Cmd
// clicks and keyboard activation are left alone.
//
// Inlined verbatim into both reader webviews via clientSource(), so keep it
// self-contained: no closures over module scope, no template literals.

function installLinkDragSelect(root) {
  var THRESHOLD = 4;
  var start = null;
  var dragged = false; // the press moved past THRESHOLD: its click opens nothing
  var swallowClick = false;
  function caretAt(x, y) {
    if (document.caretPositionFromPoint) {
      var p = document.caretPositionFromPoint(x, y);
      if (p && p.offsetNode) return { node: p.offsetNode, offset: p.offset };
    }
    if (document.caretRangeFromPoint) {
      var r = document.caretRangeFromPoint(x, y);
      if (r) return { node: r.startContainer, offset: r.startOffset };
    }
    return null;
  }
  root.addEventListener('mousedown', function (e) {
    start = null;
    dragged = false;
    swallowClick = false;
    if (e.button !== 0 || e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) return;
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!a || !root.contains(a)) return;
    var c = caretAt(e.clientX, e.clientY);
    if (!c) return;
    start = { x: e.clientX, y: e.clientY, node: c.node, offset: c.offset };
    e.preventDefault();
    // preventDefault also keeps focus where it was. A press on the reader
    // normally takes focus off the terminal; without that, Ctrl+C after the
    // drag still counts as a terminal copy and copies the terminal's text.
    var active = document.activeElement;
    if (active && active !== document.body && !root.contains(active) && active.blur) active.blur();
    try { window.getSelection().removeAllRanges(); } catch (_) {}
  }, true);
  document.addEventListener('mousemove', function (e) {
    if (!start) return;
    if (!(e.buttons & 1)) { start = null; return; }
    if (!dragged && Math.abs(e.clientX - start.x) < THRESHOLD && Math.abs(e.clientY - start.y) < THRESHOLD) return;
    dragged = true;
    var c = caretAt(e.clientX, e.clientY);
    if (!c || !root.contains(c.node)) return;
    e.preventDefault();
    try { window.getSelection().setBaseAndExtent(start.node, start.offset, c.node, c.offset); } catch (_) {}
  }, true);
  document.addEventListener('dragstart', function (e) { if (start) e.preventDefault(); }, true);
  document.addEventListener('mouseup', function () {
    // A drag that came back to within THRESHOLD of the press before release
    // is still a drag: the click it fires must not open the link.
    swallowClick = !!start && dragged;
    start = null;
    dragged = false;
    // The click (if any) is dispatched with this mouseup, before any timer;
    // a press that never gets one must not eat a later keyboard click.
    if (swallowClick) setTimeout(function () { swallowClick = false; }, 0);
  }, true);
  document.addEventListener('click', function (e) {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }, true);
}

function clientSource() {
  return installLinkDragSelect.toString();
}

module.exports = { installLinkDragSelect, clientSource };
