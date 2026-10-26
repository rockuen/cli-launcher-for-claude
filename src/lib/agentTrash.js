// @module lib/agentTrash — move an agent session into <sessions>/trash/.
//
// Used by the Trash command for Codex / Grok / Gajae (gjc) / Chief /
// Antigravity sessions. The session listings skip `trash/` (AGENT_TRASH_DIR in
// lib/sessionJsonl). Pure fs, no `vscode`.

const fs = require('fs');
const path = require('path');

const AGENT_TRASH_DIR = 'trash';

/**
 * Move a session file or folder into `<sessionsDir>/trash/`. A name that is
 * already there gets a numeric suffix (`x.2.jsonl`, `id.2`): rename would
 * silently replace an earlier trashed file, and fails outright on a folder.
 * @returns {string} the new path
 */
function moveToTrash(src, sessionsDir) {
  const trashDir = path.join(sessionsDir || path.dirname(src), AGENT_TRASH_DIR);
  fs.mkdirSync(trashDir, { recursive: true });
  const isDir = fs.statSync(src).isDirectory();
  const ext = isDir ? '' : path.extname(src);
  const base = path.basename(src, ext);
  let dst = path.join(trashDir, base + ext);
  for (let n = 2; fs.existsSync(dst); n++) dst = path.join(trashDir, `${base}.${n}${ext}`);
  fs.renameSync(src, dst);
  return dst;
}

/**
 * Trash one session: the transcript (file or folder) first, then gjc's
 * `<stem>/` sidecar folder. In that order, a transcript that cannot move (a
 * locked file) leaves the session listed with its tool logs still beside it.
 * @returns {string[]} the new paths
 */
function trashSession(sessionPath, sessionsDir, sidecar) {
  const moved = [];
  if (!sessionPath || !fs.existsSync(sessionPath)) return moved;
  moved.push(moveToTrash(sessionPath, sessionsDir));
  if (sidecar && fs.existsSync(sidecar)) moved.push(moveToTrash(sidecar, sessionsDir));
  return moved;
}

module.exports = { AGENT_TRASH_DIR, moveToTrash, trashSession };
