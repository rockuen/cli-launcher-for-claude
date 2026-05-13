// @module lib/sizeFormat — short byte-size formatter for UI labels.
//
// Used by the session tree's metadata row (the row that appears when you
// expand a session item). Output sits next to the turn count + relative time
// so the format stays short:
//   - < 1 KB    : "847 B"
//   - < 1 MB    : "412 KB"  (no decimal)
//   - >= 1 MB   : "4.1 MB"  (one decimal — preserves the visible gap between
//                            small and big sessions in a vault)
//
// Returns '' for non-numeric / negative input so callers can safely
// concatenate without an "undefined" / "NaN" appearing in the label.

function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

module.exports = { formatBytes };
