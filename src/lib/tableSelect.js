// @module lib/tableSelect — select a block of reader table cells by dragging,
// like a spreadsheet, and copy it so Excel pastes it into cells.
//
// A drag inside one cell is an ordinary text selection. Once the pointer
// enters another cell of the same table the drag becomes a cell selection:
// the text selection is dropped and the rectangle from the start cell to the
// cell under the pointer is highlighted (the pointer may leave the table; the
// rectangle stops at its edge). Shift+click extends an existing cell
// selection. It is cleared by a left press anywhere (except where
// opts.keep(target) says so — the panel's context menu), Esc, or a text
// selection made any other way (Ctrl+A).
//
// Copy writes tab-separated rows as text/plain (Excel, Sheets and Numbers
// split it into cells) and a plain <table> as text/html, from the document
// `copy` event: copy() triggers it with execCommand('copy') and reports
// whether it ran. A copy event from a text field is left alone.
//
// The readers replace their whole HTML when a message arrives. A
// MutationObserver finds the selected table again — the one with the same
// text (preferring the same position), or one whose text starts with it (it
// grew a row while streaming) — and re-applies the highlight.
//
// Inlined verbatim into both reader webviews via clientSource(), so keep it
// self-contained: no closures over module scope, no template literals.

function installTableSelect(root, opts) {
  var o = opts || {};
  var CELL = 'td, th';
  var SEL_CLASS = 'rv-cell-sel';
  var DRAG_CLASS = 'rv-cell-selecting';
  var press = null; // { table, cell } while the left button is down on a cell
  var dragging = false; // the press became a cell drag
  var lastCell = null; // the cell the drag last painted to
  var swallowClick = false;
  var copied = false; // set by the copy listener for copy()
  var sel = null; // { table, sig, index, r0, c0, r1, c1 } — anchor r0/c0, focus r1/c1

  function cellOf(node) {
    var el = node && node.nodeType === 1 ? node : (node && node.parentElement);
    var cell = el && el.closest ? el.closest(CELL) : null;
    return cell && root.contains(cell) ? cell : null;
  }
  function tableOf(cell) {
    return cell && cell.closest ? cell.closest('table') : null;
  }
  function pos(cell) {
    var tr = cell.parentElement;
    return { r: tr ? tr.rowIndex : 0, c: cell.cellIndex };
  }
  function cellText(cell) {
    var t = cell.innerText != null ? cell.innerText : cell.textContent;
    return String(t || '').replace(/\s*[\r\n]+\s*/g, ' ').replace(/\t/g, ' ').trim();
  }
  function tables() {
    var list = root.querySelectorAll ? root.querySelectorAll('table') : [];
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(list[i]);
    return out;
  }
  function editable(el) {
    if (!el) return false;
    var tag = el.tagName || '';
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
  }
  function each(fn) {
    if (!sel) return;
    var rows = sel.table.rows;
    var r0 = Math.min(sel.r0, sel.r1), r1 = Math.max(sel.r0, sel.r1);
    var c0 = Math.min(sel.c0, sel.c1), c1 = Math.max(sel.c0, sel.c1);
    for (var r = r0; r <= r1; r++) {
      var row = rows[r];
      for (var c = c0; c <= c1; c++) fn(r, c, row && row.cells[c] ? row.cells[c] : null, c === c0);
    }
  }
  function paint(on) {
    each(function (r, c, cell) {
      if (!cell || !cell.classList) return;
      if (on) cell.classList.add(SEL_CLASS); else cell.classList.remove(SEL_CLASS);
    });
  }
  function clear() {
    if (!sel) return;
    paint(false);
    sel = null;
  }
  function select(table, a, b) {
    paint(false);
    var same = sel && sel.table === table;
    sel = {
      table: table,
      sig: same ? sel.sig : null, // text is read when the gesture ends (see sign)
      index: same ? sel.index : -1,
      r0: a.r, c0: a.c, r1: b.r, c1: b.c,
    };
    paint(true);
  }
  // A table's text, cell by cell (so [a|bc] and [ab|c] differ), each row
  // closed by a separator so a table that grew rows starts with the old one.
  function tableSig(table) {
    var rows = table.rows || [];
    var out = '';
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r].cells || [];
      var line = [];
      for (var c = 0; c < cells.length; c++) line.push(cells[c].textContent);
      out += line.join('\u001f') + '\u001e';
    }
    return out;
  }
  // The table in `list` matching `sig` exactly, else one that grew from it;
  // among several, the one at `index` (identical tables keep their place).
  function findTable(list, sig, index) {
    if (!sig) return null;
    var tests = [
      function (t) { return tableSig(t) === sig; },
      function (t) { return tableSig(t).indexOf(sig) === 0; },
    ];
    for (var i = 0; i < tests.length; i++) {
      var hits = list.filter(tests[i]);
      if (hits.length) return hits.indexOf(list[index]) >= 0 ? list[index] : hits[0];
    }
    return null;
  }
  function sign() {
    if (!sel) return;
    sel.sig = tableSig(sel.table);
    var at = tables().indexOf(sel.table);
    // A table swapped out mid-drag is no longer in the list: keep where the
    // press found it.
    sel.index = at >= 0 ? at : (press ? press.index : -1);
  }
  // After the reader re-rendered, point at the same table in the new DOM.
  function relink() {
    // Mid-drag the mousemove handler follows the table itself (relinkPress).
    if (!sel || press || sel.table.isConnected !== false) return;
    var list = tables();
    var match = findTable(list, sel.sig, sel.index);
    if (!match) { sel = null; return; }
    sel.table = match;
    sel.sig = tableSig(match);
    sel.index = list.indexOf(match);
    paint(true);
  }
  // The cell under (x, y) in `table`, clamped to the table's box.
  function cellAt(table, x, y) {
    var cell = cellOf(document.elementFromPoint ? document.elementFromPoint(x, y) : null);
    if (cell && tableOf(cell) === table) return cell;
    if (!table.getBoundingClientRect || !document.elementFromPoint) return null;
    var b = table.getBoundingClientRect();
    var cx = Math.max(b.left + 1, Math.min(b.right - 1, x));
    var cy = Math.max(b.top + 1, Math.min(b.bottom - 1, y));
    cell = cellOf(document.elementFromPoint(cx, cy));
    return cell && tableOf(cell) === table ? cell : null;
  }
  // preventDefault on a press also keeps focus where it was; release focus
  // held outside the reader (the terminal) the way a normal press would.
  function releaseFocus() {
    var active = document.activeElement;
    if (active && active !== document.body && !root.contains(active) && active.blur) active.blur();
  }
  function endPress() {
    if (press && press.table.classList) press.table.classList.remove(DRAG_CLASS);
    if (press && dragging) sign();
    press = null;
    dragging = false;
    lastCell = null;
    // The reader may have swapped its HTML during the drag with no move since.
    relink();
  }

  function getText() {
    relink();
    if (!sel) return '';
    var lines = [];
    var line = null;
    each(function (r, c, cell, first) {
      if (first) { line = []; lines.push(line); }
      line.push(cell ? cellText(cell) : '');
    });
    return lines.map(function (l) { return l.join('\t'); }).join('\n');
  }
  function getHtml() {
    relink();
    if (!sel) return '';
    var esc = function (s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    };
    var out = '<table>';
    var open = false;
    each(function (r, c, cell, first) {
      if (first) { out += (open ? '</tr>' : '') + '<tr>'; open = true; }
      var tag = cell && cell.tagName && cell.tagName.toLowerCase() === 'th' ? 'th' : 'td';
      out += '<' + tag + '>' + esc(cell ? cellText(cell) : '') + '</' + tag + '>';
    });
    return out + (open ? '</tr>' : '') + '</table>';
  }
  function hasSelection() {
    relink();
    return !!sel;
  }
  var forcing = false;
  function copy() {
    if (!hasSelection()) return false;
    copied = false;
    forcing = true;
    var ok = false;
    try { ok = !!(document.execCommand && document.execCommand('copy')); } catch (_) { ok = false; }
    forcing = false;
    return ok && copied;
  }

  // A press on a scrollbar (the reader's own, or the page's in the reader
  // tab, where it lands on <html>) is not a click in the content.
  function onScrollbar(e) {
    var t = e.target;
    if (!t || t === document.documentElement) return true;
    if (typeof e.offsetX === 'number' && t.clientWidth && e.offsetX >= t.clientWidth) return true;
    if (typeof e.offsetY === 'number' && t.clientHeight && e.offsetY >= t.clientHeight) return true;
    return false;
  }

  // Only a left press or a key starts a text selection that should replace
  // the cells: on macOS a right-click selects the word under the pointer.
  var textSelectionReplaces = true;
  document.addEventListener('keydown', function () { textSelectionReplaces = true; }, true);

  // A left press anywhere outside the reader (the input bar, the terminal)
  // clears the cells too, except where opts.keep says (the panel's menu).
  document.addEventListener('mousedown', function (e) {
    textSelectionReplaces = e.button === 0;
    if (e.button !== 0 || !sel) return;
    if (e.target && root.contains(e.target)) return;
    if (onScrollbar(e)) return;
    if (o.keep && o.keep(e.target)) return;
    clear();
  }, true);

  root.addEventListener('mousedown', function (e) {
    swallowClick = false;
    if (e.button !== 0 || onScrollbar(e)) return;
    relink();
    var cell = cellOf(e.target);
    if (e.shiftKey) {
      if (cell && sel && tableOf(cell) === sel.table) {
        // Extend the cells; the click must not open a link in that cell.
        e.preventDefault();
        releaseFocus();
        select(sel.table, { r: sel.r0, c: sel.c0 }, pos(cell));
        sign();
        swallowClick = true;
        return;
      }
      // Ordinary Shift+click text selection: leave it to the browser.
      clear();
      press = null;
      return;
    }
    clear();
    var pressed = cell && !e.altKey && !e.ctrlKey && !e.metaKey ? tableOf(cell) : null;
    press = pressed ? { table: pressed, cell: cell, index: tables().indexOf(pressed) } : null;
    dragging = false;
    lastCell = null;
    // A press inside existing selected text makes Chrome drag that text
    // instead of selecting (no mousemove reaches us), so a single press on a
    // cell starts from no selection. Double/triple clicks keep theirs.
    if (press && e.detail <= 1) {
      try {
        var s = window.getSelection();
        if (s && !s.isCollapsed) s.removeAllRanges();
      } catch (_) {}
    }
  }, true);

  // Capture phase on document, installed before lib/linkDragSelect, so a
  // cell drag that started on a link stops that module's text selection.
  document.addEventListener('mousemove', function (e) {
    if (!press) return;
    if (!(e.buttons & 1)) { endPress(); return; }
    if (press.table.isConnected === false) {
      relinkPress();
      if (!press) return;
    }
    var cell = cellAt(press.table, e.clientX, e.clientY);
    if (!dragging) {
      if (!cell || cell === press.cell) return; // still inside the start cell: text selection
      dragging = true;
      if (press.table.classList) press.table.classList.add(DRAG_CLASS);
    }
    try { window.getSelection().removeAllRanges(); } catch (_) {}
    e.preventDefault();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    if (!cell || cell === lastCell) return;
    lastCell = cell;
    select(press.table, pos(press.cell), pos(cell));
  }, true);
  // Re-rendered mid-drag: follow the table, keep the start cell's place.
  function relinkPress() {
    var at = pos(press.cell);
    var list = tables();
    var table = findTable(list, tableSig(press.table), press.index);
    var row = table && table.rows[at.r];
    var cell = row && row.cells[at.c];
    if (!cell) { endPress(); return; }
    if (sel && sel.table === press.table) sel.table = table;
    press = { table: table, cell: cell, index: list.indexOf(table) };
    lastCell = null;
    if (dragging && table.classList) table.classList.add(DRAG_CLASS);
  }

  document.addEventListener('mouseup', function () {
    if (press && dragging) swallowClick = true;
    endPress();
    // The click (if any) is dispatched with this mouseup, before any timer;
    // a press that never gets one must not eat a later keyboard click.
    if (swallowClick) setTimeout(function () { swallowClick = false; }, 0);
  }, true);

  // The click that ends a cell drag or a Shift+click must not open a link.
  document.addEventListener('click', function (e) {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }, true);

  document.addEventListener('copy', function (e) {
    if (!e.clipboardData || !hasSelection()) return;
    if (!forcing) {
      // Someone copying in a text field (or the terminal's helper textarea),
      // or a text selection made since: theirs, not the cells.
      if (editable(e.target)) return;
      try {
        var s = window.getSelection();
        if (s && !s.isCollapsed) return;
      } catch (_) {}
    }
    e.clipboardData.setData('text/plain', getText());
    e.clipboardData.setData('text/html', getHtml());
    e.preventDefault();
    copied = true;
  });

  // A text selection made any other way (Ctrl+A, keyboard) replaces the cells.
  document.addEventListener('selectionchange', function () {
    if (!sel || press || !textSelectionReplaces) return;
    try {
      var s = window.getSelection();
      if (s && !s.isCollapsed) clear();
    } catch (_) {}
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { clear(); return; }
    if (!o.copyKey || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    if (e.key !== 'c' && e.key !== 'C') return;
    if (editable(e.target)) return;
    if (!hasSelection()) return;
    e.preventDefault();
    if (!copy() && o.fallbackCopy) o.fallbackCopy(getText());
  }, true);

  // Re-apply the highlight as soon as the reader swaps its HTML.
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(function () {
      if (sel && sel.table.isConnected === false) relink();
    }).observe(root, { childList: true, subtree: true });
  }

  return { hasSelection: hasSelection, getText: getText, getHtml: getHtml, copy: copy, clear: clear };
}

function clientSource() {
  return installTableSelect.toString();
}

module.exports = { installTableSelect, clientSource };
