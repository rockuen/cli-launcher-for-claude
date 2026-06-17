// @module store/sessionStore — JSON file-based persistence for session metadata.
// Location: <workspace>/.claude-launcher/sessions.json (workspace-scoped, not globalStorage).
//
// SYNC MODEL (v3.10.5):
//   - SHARED (this file, git-tracked): groups, titles, saved (Resume Later),
//     archived (Trash), sort order, parent map. Keyed by agent-CLI session ids,
//     which are device-independent, so they are meaningful on every device.
//   - DEVICE-LOCAL (workspaceState, never synced): `claudeSessions` = the set of
//     open tabs / window layout (cwd, viewColumn, order). This is per-machine
//     state; keeping it in the synced file made every device rewrite the file
//     on each tab change, and those merge conflicts corrupted the shared
//     metadata (lost groups/titles, blank-id entries). See deviceLocal* below.
//
// The file is written with deterministic (sorted-key) serialization so an
// identical logical state is byte-identical across devices (minimizing git
// diffs / 3-way-merge noise), and sanitized on every write to heal merge damage.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const state = require('../state');

const SESSION_STORE_DIR = '.claude-launcher';
const SESSION_STORE_FILE = 'sessions.json';

function getSessionStorePath() {
  const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (!wsFolder) return null;
  return path.join(wsFolder, SESSION_STORE_DIR, SESSION_STORE_FILE);
}

function sessionStoreGet(key, defaultValue) {
  const filePath = getSessionStorePath();
  if (!filePath || !fs.existsSync(filePath)) return defaultValue;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return data[key] !== undefined ? data[key] : defaultValue;
  } catch (_) {
    return defaultValue;
  }
}

// Recursively clone `value` with object keys sorted, so JSON.stringify yields
// byte-identical output for an identical logical state regardless of insertion
// order. Eliminates spurious git diffs / 3-way-merge noise on the synced file.
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeysDeep(value[k]);
    return out;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(sortKeysDeep(value), null, 2);
}

// Heal structures that a git line-merge can corrupt. After conflict
// resolutions we observed blank-string ids inside groups and a "": N entry in
// the sort-order map. Runtime already tolerates junk; cleaning on every write
// heals the file progressively instead of letting corruption accrete.
//   - *SessionGroups:   drop falsy/blank ids and de-dupe within each group
//   - *SessionSortOrder / *SessionParent: drop the blank-key ("") entry
//   - claudeSavedSessions / claudeArchivedSessions: drop entries with no
//     sessionId and de-dupe by sessionId (keep first)
function sanitizeStore(data) {
  if (!data || typeof data !== 'object') return data;
  for (const key of Object.keys(data)) {
    const val = data[key];
    if (/SessionGroups$/.test(key) && val && typeof val === 'object' && !Array.isArray(val)) {
      for (const g of Object.keys(val)) {
        if (!Array.isArray(val[g])) continue;
        const seen = new Set();
        val[g] = val[g].filter((id) => {
          if (typeof id !== 'string' || id.length === 0 || seen.has(id)) return false;
          seen.add(id);
          return true;
        });
      }
    } else if ((/SessionSortOrder$/.test(key) || /SessionParent$/.test(key)) &&
               val && typeof val === 'object' && !Array.isArray(val)) {
      if ('' in val) delete val[''];
    }
  }
  for (const key of ['claudeSavedSessions', 'claudeArchivedSessions']) {
    if (!Array.isArray(data[key])) continue;
    const seen = new Set();
    data[key] = data[key].filter((s) => {
      const id = s && s.sessionId;
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }
  return data;
}

// Shared atomic writer: sanitize + deterministic serialize, write to
// .tmp.<pid>.<ts>, fsync, then rename over the target. Prevents partial-file
// corruption / cross-window race when multiple windows (or the same window
// racing with a previous flush) update the store.
function writeStore(filePath, data) {
  const json = stableStringify(sanitizeStore(data));
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  let fd;
  try {
    fd = fs.openSync(tmpPath, 'w');
    fs.writeSync(fd, json, 0, 'utf8');
    try { fs.fsyncSync(fd); } catch (_) {}
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
    throw e;
  }
}

function sessionStoreUpdate(key, value) {
  const filePath = getSessionStorePath();
  if (!filePath) return;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let data = {};
  if (fs.existsSync(filePath)) {
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) {}
  }
  data[key] = value;
  writeStore(filePath, data);
}

// Remove a top-level key from the store (atomic). Used to evict the now
// device-local 'claudeSessions' from the synced file during migration.
function sessionStoreDelete(key) {
  const filePath = getSessionStorePath();
  if (!filePath || !fs.existsSync(filePath)) return;
  let data = {};
  try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return; }
  if (!(key in data)) return;
  delete data[key];
  writeStore(filePath, data);
}

// --- Device-local state (per-machine, per-workspace) via workspaceState ------
// Open-tab / window state must NOT sync across devices. workspaceState keeps it
// off the filesystem entirely (never git / OneDrive) and VS Code scopes it per
// workspace + per machine — exactly the semantics for "tabs open on THIS
// device". Standard vscode API, so it works on every VS Code-compatible IDE.
function deviceLocalGet(key, defaultValue) {
  try {
    const ws = state.context && state.context.workspaceState;
    if (!ws) return defaultValue;
    const v = ws.get(key);
    return v === undefined ? defaultValue : v;
  } catch (_) {
    return defaultValue;
  }
}

function deviceLocalSet(key, value) {
  try {
    const ws = state.context && state.context.workspaceState;
    if (ws) return ws.update(key, value);
  } catch (_) {}
}

// One-time migrations, safe to call on every activate().
function migrateFromWorkspaceState(context) {
  const filePath = getSessionStorePath();
  if (!filePath) return;
  let existing = {};
  if (fs.existsSync(filePath)) {
    try { existing = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) {}
  }

  // v3.10.5: claudeSessions (open-tab/window state) is device-local. If a
  // legacy file still carries it, seed THIS device's workspaceState once (only
  // when empty, so we never clobber live local tabs) and evict it from the
  // synced file so it stops generating cross-device churn / merge conflicts.
  if (existing.claudeSessions !== undefined) {
    try {
      const ws = context && context.workspaceState;
      if (ws && ws.get('claudeSessions') === undefined) {
        ws.update('claudeSessions', existing.claudeSessions);
      }
    } catch (_) {}
    sessionStoreDelete('claudeSessions');
  }

  // Legacy seed (pre-file era): copy SHARED metadata from old workspaceState
  // into the file once. claudeSessions intentionally excluded — see above.
  if (existing._migrated) return;
  const keys = ['claudeSessionTitles', 'claudeSavedSessions', 'claudeSessionGroups', 'claudeArchivedSessions'];
  let migrated = false;
  for (const key of keys) {
    const val = context.workspaceState.get(key);
    if (val !== undefined && existing[key] === undefined) {
      sessionStoreUpdate(key, val);
      migrated = true;
    }
  }
  if (migrated) {
    sessionStoreUpdate('_migrated', true);
    console.log('[Claude Launcher] Migrated legacy workspaceState metadata to sessions.json');
  }
}

module.exports = {
  getSessionStorePath,
  sessionStoreGet,
  sessionStoreUpdate,
  sessionStoreDelete,
  deviceLocalGet,
  deviceLocalSet,
  migrateFromWorkspaceState,
  // exported for unit tests
  stableStringify,
  sanitizeStore,
};
