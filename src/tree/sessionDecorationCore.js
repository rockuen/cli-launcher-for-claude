// @module tree/sessionDecorationCore — vscode-free helpers for SessionDecorationProvider.
//
// SessionDecorationProvider needs vscode (Uri, ThemeColor, EventEmitter), but
// the decision logic doesn't. Factoring the pure pieces out lets the unit
// tests load this module without the vscode runtime, which keeps the
// threshold + tooltip + URI-query behavior verifiable in CI / `node --test`.

const SCHEME = 'claudeCodeLauncher-session';
const WARN_THRESHOLD = 5 * 1024 * 1024;   // 5 MB
const ERROR_THRESHOLD = 10 * 1024 * 1024; // 10 MB

// Default (English) tooltip wording. English is the default; the vscode-runtime
// caller (SessionDecorationProvider) passes localized labels from i18n so this
// module stays vscode-free and unit-testable. `{0}` is the size in MB.
const DEFAULT_SIZE_LABELS = {
  veryLargeTrash: '⚠ Very large session ({0} MB) — empty from trash too',
  veryLargeSplit: '⚠ Very large session ({0} MB) — split into a new session now',
  largeTrash: '⚠ Large session ({0} MB) — clean up from trash',
  largeSplit: '⚠ Large session ({0} MB) — split into a new session',
};

function formatMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

// Compose the `size=...&trashed=...` query string. Floors fractional sizes
// and forces booleans into 0/1 so consumers can rely on a fixed shape.
function formatQuery(size, trashed) {
  const s = Math.max(0, Math.floor(Number(size) || 0));
  return `size=${s}&trashed=${trashed ? 1 : 0}`;
}

// Parse the same shape back from a URI's `.query` (URLSearchParams string).
// Tolerates missing keys (defaults to 0 / false) so an older-format URI
// still flows through without throwing.
function parseQuery(query) {
  const params = new URLSearchParams(String(query || ''));
  const size = parseInt(params.get('size') || '0', 10);
  const trashed = params.get('trashed') === '1';
  return { size: isFinite(size) && size >= 0 ? size : 0, trashed };
}

// Compose the URI path component for a session id — encodes characters that
// would otherwise break URI parsing (spaces, slashes), and tolerates empty.
function encodeSessionPath(sessionId) {
  return '/' + encodeURIComponent(String(sessionId || ''));
}

// Pure decision: { colorId, severity, sizeMB, tooltip } for any size > the
// warning threshold; null otherwise. Trashed flag flips the recommendation
// wording so the message matches where the session lives. `labels` overrides
// the default (English) wording — the vscode caller passes localized strings;
// each label uses `{0}` for the size in MB.
function getDecoration(size, trashed, labels) {
  if (typeof size !== 'number' || !isFinite(size) || size < 0) return null;
  const L = labels || DEFAULT_SIZE_LABELS;
  const mb = formatMB(size);
  if (size > ERROR_THRESHOLD) {
    return {
      colorId: 'errorForeground',
      severity: 'error',
      sizeMB: mb,
      tooltip: (trashed ? L.veryLargeTrash : L.veryLargeSplit).replace('{0}', mb),
    };
  }
  if (size > WARN_THRESHOLD) {
    return {
      colorId: 'editorWarning.foreground',
      severity: 'warning',
      sizeMB: mb,
      tooltip: (trashed ? L.largeTrash : L.largeSplit).replace('{0}', mb),
    };
  }
  return null;
}

module.exports = {
  SCHEME,
  WARN_THRESHOLD,
  ERROR_THRESHOLD,
  DEFAULT_SIZE_LABELS,
  formatMB,
  formatQuery,
  parseQuery,
  encodeSessionPath,
  getDecoration,
};
