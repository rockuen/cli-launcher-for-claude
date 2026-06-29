// @module lib/renamePrefix — date-token prefix for the session rename box.
//
// When claudeCodeLauncher.renamePrefix.enabled is on, the rename input boxes
// (tab rename via command / webview title click, and the sidebar per-session
// rename) open pre-filled with a date-based prefix so a session can be named
// like `260629_my-task` in one step. The format is user-editable via
// claudeCodeLauncher.renamePrefix.format (default `YYMMDD_`).
//
// Pure / vscode-free so it can be unit tested. Callers read the two settings
// and pass them in.

// Replace date tokens in `pattern` with values from `now` (default: today).
// Tokens are matched in one pass; the alternation lists longer tokens first so
// `YYYY` wins over `YY` (JS regex alternation is left-to-right at each
// position). Everything else in the pattern is kept literally, so a trailing
// separator like the `_` in `YYMMDD_` survives untouched.
//
//   YYYY → 4-digit year (2026)   HH → 2-digit hour, 24h (09)
//   YY   → 2-digit year (26)     mm → 2-digit minute (07)
//   MM   → 2-digit month (06)    ss → 2-digit second (05)
//   DD   → 2-digit day (29)
function formatDatePattern(pattern, now) {
  const d = now instanceof Date && !isNaN(now.getTime()) ? now : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const map = {
    YYYY: String(d.getFullYear()),
    YY: String(d.getFullYear()).slice(-2),
    MM: pad(d.getMonth() + 1),
    DD: pad(d.getDate()),
    HH: pad(d.getHours()),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
  };
  return String(pattern == null ? '' : pattern)
    .replace(/YYYY|YY|MM|DD|HH|mm|ss/g, (tok) => map[tok]);
}

// Build the { value, valueSelection } to feed vscode.window.showInputBox so the
// rename box opens with the date prefix already typed.
//
// opts: { enabled, format, existing, now }
//   - When disabled (or the format resolves to nothing) the existing value is
//     returned verbatim with no selection override, so callers can spread the
//     result unconditionally and keep the legacy behavior.
//   - When enabled, the prefix is prepended to the existing name and the
//     existing-name portion is SELECTED. Typing replaces it; pressing
//     End/→ keeps it. An empty existing name leaves the cursor parked right
//     after the prefix (valueSelection [len, len] = collapsed caret).
function buildRenamePrefill(opts) {
  const o = opts || {};
  const existing = o.existing == null ? '' : String(o.existing);
  if (!o.enabled || !o.format) {
    return { value: existing };
  }
  const prefix = formatDatePattern(o.format, o.now);
  if (!prefix) return { value: existing };
  const value = prefix + existing;
  return { value, valueSelection: [prefix.length, value.length] };
}

module.exports = { formatDatePattern, buildRenamePrefill };
