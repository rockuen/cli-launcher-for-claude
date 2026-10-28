// @module lib/tabLabel — what an editor tab shows for a session title.
//
// Only the editor tab label is shortened, so many tabs stay readable side by
// side. The session keeps its full name (entry.title) everywhere else: the
// Sessions view, the title inside the panel, the rename box, notifications
// and session links. Two optional steps, both off by default:
//   - hideDatePrefix: drop a leading date such as the `260629_` the rename
//     prefix adds (lib/renamePrefix stripDatePrefix).
//   - maxLength: cut to that many characters, the last one `…`. 0 = no limit;
//     1–3 count as MIN_LENGTH, so a tab never shrinks to a bare `…`.
//
// Pure / vscode-free; panel/panelTitle reads the settings and applies it.

const { stripDatePrefix } = require('./renamePrefix');

const MIN_LENGTH = 4;

// Characters as the user sees them (grapheme clusters): a ZWJ emoji or a
// decomposed Hangul syllable (macOS file names) is never cut in half.
const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;
function graphemes(s) {
  return segmenter ? Array.from(segmenter.segment(s), (g) => g.segment) : Array.from(s);
}

function truncateLabel(text, maxLength) {
  const s = text == null ? '' : String(text);
  const n = Math.floor(Number(maxLength));
  if (!(n > 0)) return s;
  const max = Math.max(n, MIN_LENGTH);
  const chars = graphemes(s);
  if (chars.length <= max) return s;
  return chars.slice(0, max - 1).join('').trimEnd() + '…';
}

// opts: { hideDatePrefix, datePrefixFormat, maxLength }. The length is counted
// after the date is gone.
function formatTabLabel(title, opts) {
  const o = opts || {};
  let label = title == null ? '' : String(title);
  if (o.hideDatePrefix) label = stripDatePrefix(label, o.datePrefixFormat);
  return truncateLabel(label, o.maxLength);
}

module.exports = { MIN_LENGTH, truncateLabel, formatTabLabel };
