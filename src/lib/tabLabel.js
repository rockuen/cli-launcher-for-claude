// @module lib/tabLabel — what an editor tab shows for a session title.
//
// Only the editor tab label is shortened, so many tabs stay readable side by
// side. The session keeps its full name (entry.title) everywhere else: the
// Sessions view, the title inside the panel, the rename box, notifications
// and session links. Optional steps, all off by default:
//   - hideDatePrefix: drop a leading date such as the `260629_` the rename
//     prefix adds (lib/renamePrefix stripDatePrefix).
//   - maxLength: cut to that many characters, the last one `…`. 0 = no limit;
//     1–3 count as MIN_LENGTH, so a tab never shrinks to a bare `…`.
//   - compactTabCount / compactLength: once `tabCount` tabs are open, every
//     one of them is cut to compactLength instead (default 5 = four characters
//     and `…`), and the date goes whether hideDatePrefix is on or not — four
//     characters of a date tell no two tabs apart.
//
// Pure / vscode-free; panel/panelTitle reads the settings, counts the tabs and
// applies it.

const { stripDatePrefix } = require('./renamePrefix');

const MIN_LENGTH = 4;
const DEFAULT_COMPACT_LENGTH = 5;

// Characters as the user sees them (grapheme clusters): a ZWJ emoji or a
// decomposed Hangul syllable (macOS file names) is never cut in half.
const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;
function graphemes(s) {
  return segmenter ? Array.from(segmenter.segment(s), (g) => g.segment) : Array.from(s);
}

// A whole number above 0, or 0 for anything else (blank, negative, NaN).
function positiveInt(v) {
  const n = Math.floor(Number(v));
  return n > 0 ? n : 0;
}

function truncateLabel(text, maxLength) {
  const s = text == null ? '' : String(text);
  const n = positiveInt(maxLength);
  if (!n) return s;
  const max = Math.max(n, MIN_LENGTH);
  const chars = graphemes(s);
  if (chars.length <= max) return s;
  return chars.slice(0, max - 1).join('').trimEnd() + '…';
}

// Compact once `tabCount` reaches `compactTabCount`; 0 / blank = never.
function isCompact(tabCount, compactTabCount) {
  const at = positiveInt(compactTabCount);
  return at > 0 && positiveInt(tabCount) >= at;
}

// opts: { hideDatePrefix, datePrefixFormat, maxLength, compactTabCount,
// compactLength, tabCount }. The length is counted after the date is gone.
// Compact never makes a tab longer: a smaller maxLength still wins.
function formatTabLabel(title, opts) {
  const o = opts || {};
  let label = title == null ? '' : String(title);
  const compact = isCompact(o.tabCount, o.compactTabCount);
  if (o.hideDatePrefix || compact) label = stripDatePrefix(label, o.datePrefixFormat);
  let max = positiveInt(o.maxLength);
  if (compact) {
    const c = positiveInt(o.compactLength) || DEFAULT_COMPACT_LENGTH;
    max = max ? Math.min(max, c) : c;
  }
  return truncateLabel(label, max);
}

module.exports = { MIN_LENGTH, DEFAULT_COMPACT_LENGTH, truncateLabel, isCompact, formatTabLabel };
