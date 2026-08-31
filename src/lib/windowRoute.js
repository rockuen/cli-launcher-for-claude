// @module lib/windowRoute — decide which editor window should serve a resume
// deep link, and keep the hand-off payload that travels between windows.
//
// VS Code delivers a `vscode://…` URI to ONE window (the last focused one) and
// gives an extension no way to message another window. So the routing works
// like this:
//
//   1. The window that receives the URI checks whether the session's cwd lives
//      inside its own workspace folders (`isCwdInWorkspace`).
//   2. If yes it resumes right there.
//   3. If no it drops a pending record in globalStorage and launches the
//      editor CLI on that folder. The CLI focuses an existing window for that
//      folder, or opens a new one — either way a window whose workspace DOES
//      match then picks the pending record up (a running window via fs.watch,
//      a fresh window during activate) and resumes.
//
// Pure functions only — no `vscode` require — so the path matching and the
// staleness rule are unit testable.

const path = require('path');

const PENDING_FILE = 'pending-resume.json';
// A pending record is a hand-off, not a queue: if no window claimed it within
// this window the user's click is long gone and replaying it would surprise.
const PENDING_TTL_MS = 60_000;

// Windows paths are case-insensitive and mix separators; POSIX paths are not.
function normalizePath(p) {
  if (!p || typeof p !== 'string') return '';
  let out = path.normalize(p).replace(/[\\/]+$/, '');
  if (process.platform === 'win32') out = out.replace(/\//g, '\\').toLowerCase();
  return out;
}

/**
 * True when `cwd` is one of `folders` or nested inside one of them.
 * @param {string|null|undefined} cwd
 * @param {string[]} folders workspace folder fsPaths
 */
function isCwdInWorkspace(cwd, folders) {
  const target = normalizePath(cwd);
  if (!target) return false;
  const sep = process.platform === 'win32' ? '\\' : '/';
  for (const f of folders || []) {
    const root = normalizePath(f);
    if (!root) continue;
    if (target === root) return true;
    if (target.startsWith(root + sep)) return true;
  }
  return false;
}

/**
 * Where a window should route a link.
 *  - 'here'      → resume in this window (cwd matches, or the link carries none)
 *  - 'elsewhere' → write a pending record and launch the editor on `cwd`
 * @param {{cwd?:string|null}} link
 * @param {string[]} folders workspace folder fsPaths of the receiving window
 */
function routeForLink(link, folders) {
  const cwd = link && link.cwd;
  if (!cwd) return 'here';
  return isCwdInWorkspace(cwd, folders) ? 'here' : 'elsewhere';
}

function pendingFilePath(globalStorageDir) {
  return path.join(globalStorageDir, PENDING_FILE);
}

/**
 * Should this window act on a pending record it just read?
 * Fresh (within TTL) AND addressed at this window's workspace.
 * @param {{cwd?:string|null, ts?:number}} pending
 * @param {string[]} folders workspace folder fsPaths
 * @param {number} now epoch ms
 * @param {number} [ttlMs]
 */
function shouldClaimPending(pending, folders, now, ttlMs) {
  if (!pending || typeof pending !== 'object') return false;
  const ttl = typeof ttlMs === 'number' ? ttlMs : PENDING_TTL_MS;
  const ts = typeof pending.ts === 'number' ? pending.ts : 0;
  if (!ts || now - ts > ttl) return false;
  // A record with no cwd is not addressed to anyone in particular; the window
  // that received the URI already handled it.
  if (!pending.cwd) return false;
  return isCwdInWorkspace(pending.cwd, folders);
}

module.exports = {
  PENDING_FILE,
  PENDING_TTL_MS,
  normalizePath,
  isCwdInWorkspace,
  routeForLink,
  pendingFilePath,
  shouldClaimPending,
};
