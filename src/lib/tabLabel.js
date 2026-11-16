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
//     one of them shows compactLength characters and `..` instead (default
//     5), and the date goes whether hideDatePrefix is on or not — the first
//     characters of a date tell no two tabs apart. compactLength counts
//     full-width characters (Hangul, kana, CJK, emoji). A narrow one (Latin
//     letters, digits, spaces) takes about half the room in a tab and counts
//     as half, so 5 shows five Hangul syllables or ten Latin letters.
//
// Pure / vscode-free; panel/panelTitle reads the settings, counts the tabs and
// applies it.

const { stripDatePrefix } = require('./renamePrefix');

const MIN_LENGTH = 4;
const DEFAULT_COMPACT_LENGTH = 5;
const MIN_COMPACT_LENGTH = 2;
const COMPACT_MARK = '..';
const COMPACT_MARK_WIDTH = 2; // two narrow characters, in the halves charWidth counts

// Code points a tab draws about twice as wide as a Latin letter. Ascending.
const WIDE_RANGES = [
  [0x1100, 0x115F], // Hangul Jamo — a decomposed syllable (macOS names) starts here
  [0x2300, 0x23FF], // technical symbols: watch, hourglass, alarm clock
  [0x2600, 0x27BF], // symbols and dingbats, mostly drawn as emoji
  [0x2B00, 0x2BFF], // arrows and shapes: star, large squares and circles
  [0x2E80, 0x303E], // CJK radicals, symbols and punctuation
  [0x3041, 0x33FF], // kana, Hangul compatibility Jamo, CJK compatibility
  [0x3400, 0x4DBF], // CJK extension A
  [0x4E00, 0x9FFF], // CJK ideographs
  [0xA960, 0xA97F], // Hangul Jamo extended-A
  [0xAC00, 0xD7A3], // Hangul syllables
  [0xF900, 0xFAFF], // CJK compatibility ideographs
  [0xFE30, 0xFE4F], // CJK compatibility forms
  [0xFF00, 0xFF60], // full-width forms
  [0xFFE0, 0xFFE6], // full-width signs
  [0x1F000, 0x1FAFF], // emoji, flags, pictographs
  [0x20000, 0x3FFFD], // CJK extensions B and later
];

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

// The selector that turns the character before it into an emoji (keycaps such
// as 1 + selector + box, or a plain symbol shown in colour).
const EMOJI_SELECTOR = String.fromCharCode(0xFE0F);

// Room a character takes in a tab, in halves of a full-width one: 2 for a wide
// character, 1 for the rest. Judged by the first code point of the cluster,
// or by an emoji selector inside it.
function charWidth(ch) {
  if (ch.length > 1 && ch.indexOf(EMOJI_SELECTOR) !== -1) return 2;
  const cp = ch.codePointAt(0);
  for (const [from, to] of WIDE_RANGES) {
    if (cp < from) break;
    if (cp <= to) return 2;
  }
  return 1;
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

// The compact cut: `length` full-width characters — a narrow one counts as
// half — and `..` after them. Blank / 0 = DEFAULT_COMPACT_LENGTH; 1 counts
// as MIN_COMPACT_LENGTH. A title that fits is shown whole, and so is one that
// is over by no more than the room the `..` takes (two narrow characters or a
// wide one): cutting it would not make the tab any smaller.
function compactLabel(text, length) {
  const s = text == null ? '' : String(text);
  const room = Math.max(positiveInt(length) || DEFAULT_COMPACT_LENGTH, MIN_COMPACT_LENGTH) * 2;
  const chars = graphemes(s);
  const widths = chars.map(charWidth);
  if (widths.reduce((a, b) => a + b, 0) <= room + COMPACT_MARK_WIDTH) return s;
  let used = 0;
  let keep = 0;
  while (keep < chars.length && used + widths[keep] <= room) used += widths[keep++];
  const head = chars.slice(0, keep).join('');
  // No space left hanging, and no third `.` when the cut lands on one.
  return (head.replace(/[\s.]+$/, '') || head) + COMPACT_MARK;
}

// Compact once `tabCount` reaches `compactTabCount`; 0 / blank = never.
function isCompact(tabCount, compactTabCount) {
  const at = positiveInt(compactTabCount);
  return at > 0 && positiveInt(tabCount) >= at;
}

// opts: { hideDatePrefix, datePrefixFormat, maxLength, compactTabCount,
// compactLength, tabCount }. The length is counted after the date is gone.
// Compact never makes a tab longer: a maxLength the compact title would go
// over still applies, with its own `…`.
function formatTabLabel(title, opts) {
  const o = opts || {};
  let label = title == null ? '' : String(title);
  const compact = isCompact(o.tabCount, o.compactTabCount);
  if (o.hideDatePrefix || compact) label = stripDatePrefix(label, o.datePrefixFormat);
  if (!compact) return truncateLabel(label, o.maxLength);
  const short = compactLabel(label, o.compactLength);
  const max = positiveInt(o.maxLength);
  if (max && graphemes(short).length > Math.max(max, MIN_LENGTH)) return truncateLabel(label, max);
  return short;
}

module.exports = {
  MIN_LENGTH,
  DEFAULT_COMPACT_LENGTH,
  MIN_COMPACT_LENGTH,
  truncateLabel,
  compactLabel,
  isCompact,
  formatTabLabel,
};
