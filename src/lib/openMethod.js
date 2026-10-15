// @module lib/openMethod — decides how a file link opens from the
// fileAssociations setting, and how that setting is stored. vscode-free so the
// rules are unit-tested; handlers/openFile.js executes the method this returns.
//
// Markdown rules:
//   - 'auto' on .md/.markdown → 'notewise' when the NoteWise Markdown Editor
//     extension is installed (and enabled), otherwise 'default' — the IDE's
//     own default editor for the file (vscode.open).
//   - 'notewise' without NoteWise installed → 'default' rather than an
//     openWith on a viewType nobody registered.
//
// Storage: VS Code deep-merges an object setting with its default, so the
// settings panel used to save the whole merged map and freeze every default
// into the user's settings.json — `.md: 'obsidian'` included, for anyone who
// ever added or removed an entry. Only overrides are stored now; a default
// key the user removed is stored as null (omitting it would merge it back).

const NOTEWISE_EXTENSION_ID = 'rockuen.notewise-editor';
const NOTEWISE_VIEW_TYPE = 'notewise.editor';

const MARKDOWN_EXTS = new Set(['.md', '.markdown']);

// fileAssociations default up to v3.24.1, used to recognize a panel-frozen map.
const LEGACY_FILE_ASSOC_DEFAULTS = Object.freeze({
  '.csv': 'excel',
  '.xlsx': 'excel',
  '.xls': 'excel',
  '.pptx': 'excel',
  '.docx': 'system',
  '.pdf': 'system',
  '.html': 'browser',
  '.htm': 'browser',
  '.md': 'obsidian',
  '.png': 'system',
  '.jpg': 'system',
  '.gif': 'system',
  '.svg': 'system',
});

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function resolveOpenMethod(ext, fileAssoc, opts) {
  const notewiseInstalled = !!(opts && opts.notewiseInstalled);
  const method = (fileAssoc && fileAssoc[ext]) || 'auto';
  if (method === 'auto' && MARKDOWN_EXTS.has(ext)) {
    return notewiseInstalled ? 'notewise' : 'default';
  }
  if (method === 'notewise' && !notewiseInstalled) return 'default';
  return method;
}

// Entries with a null value are removed defaults — not shown, not opened.
function visibleFileAssociations(merged) {
  const out = {};
  if (!isPlainObject(merged)) return out;
  for (const [ext, method] of Object.entries(merged)) {
    if (typeof method === 'string' && method) out[ext] = method;
  }
  return out;
}

// The map to store in settings.json for what the user sees as `map`.
function fileAssociationOverrides(map, defaults) {
  const src = isPlainObject(map) ? map : {};
  const defs = isPlainObject(defaults) ? defaults : {};
  const out = {};
  for (const [ext, method] of Object.entries(src)) {
    if (typeof method === 'string' && method && defs[ext] !== method) out[ext] = method;
  }
  for (const ext of Object.keys(defs)) {
    if (!(ext in out) && !(typeof src[ext] === 'string' && src[ext])) out[ext] = null;
  }
  return out;
}

// One-time fix for a stored map the old panel froze. That panel wrote every
// legacy default key on each save, so a map holding all of them with `.md`
// still 'obsidian' got that value from the old default, not from the user.
// Values of the other keys may differ (the user changed them, or a newer
// device synced a null) and are kept when they differ from today's defaults.
// Returns the overrides to store instead, or null when there is nothing to do
// (a hand-written `{ ".md": "obsidian" }` does not match and is kept).
function migrateFrozenFileAssociations(stored, defaults) {
  if (!isPlainObject(stored) || stored['.md'] !== 'obsidian') return null;
  const frozen = Object.keys(LEGACY_FILE_ASSOC_DEFAULTS).every((ext) => ext in stored);
  if (!frozen) return null;
  const defs = isPlainObject(defaults) ? defaults : {};
  const out = {};
  for (const [ext, method] of Object.entries(stored)) {
    if (ext === '.md' || defs[ext] === method) continue;
    out[ext] = method;
  }
  return out;
}

module.exports = {
  resolveOpenMethod,
  visibleFileAssociations,
  fileAssociationOverrides,
  migrateFrozenFileAssociations,
  LEGACY_FILE_ASSOC_DEFAULTS,
  NOTEWISE_EXTENSION_ID,
  NOTEWISE_VIEW_TYPE,
};
