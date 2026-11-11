// @module handlers/openFolder — opens a folder (or reveals a file) in the OS
// file manager. Path reading lives in lib/pathSelection: the selection is
// cleaned up (wrapped rows, quotes, particles, file:// and Git Bash shapes)
// and the first reading that exists wins.

const vscode = require('vscode');
const { t } = require('../i18n');
const { expandBraces } = require('../util/braceExpand');
const { resolveSelection, fallbackQuery, findUnderCwd, openFolderCommand, previewText } = require('../lib/pathSelection');

// Open `target` in Explorer / Finder / the desktop's file manager. reveal=true
// opens the containing folder with the file selected.
function openInFileManager(target, reveal) {
  const { spawn } = require('child_process');
  try {
    const cmd = openFolderCommand(target, { reveal: !!reveal });
    const child = spawn(cmd.command, cmd.args, cmd.options);
    child.on('error', (err) => {
      vscode.window.showWarningMessage(t('invalidFolderPath') + target + ' (' + (err && err.message ? err.message : String(err)) + ')');
    });
    child.unref();
  } catch (e) {
    vscode.window.showWarningMessage(t('invalidFolderPath') + target + ' (' + (e && e.message ? e.message : String(e)) + ')');
  }
}

function handleOpenFolder(filePath, entry) {
  const raw = String(filePath || '').trim();
  if (!raw) {
    vscode.window.showWarningMessage(t('invalidFolderPath') + filePath);
    return;
  }

  // Phase 11: shell-style brace expansion (mirrors handleOpenFile).
  const _expansions = expandBraces(raw);
  if (_expansions.length > 1) {
    for (const _exp of _expansions) handleOpenFolder(_exp, entry);
    return;
  }

  const cwd = entry && entry.cwd;
  let hit = resolveSelection(raw, cwd);

  // v2.6.2: partial paths like "slack-manifests/01-demand-forecast.yaml"
  // still find their folder when cwd isn't a direct ancestor (basename walk
  // under cwd, full-suffix match preferred).
  if (!hit) {
    const found = findUnderCwd(cwd, fallbackQuery(raw).path, { dirs: true });
    if (found) hit = found;
  }
  // Last resorts: a name selected a few characters short, then a folder
  // named by one row (a folder path with prose after it).
  if (!hit) hit = resolveSelection(raw, cwd, { completeShort: true });
  if (!hit) hit = resolveSelection(raw, cwd, { partialDirs: true });

  if (!hit) {
    vscode.window.showWarningMessage(t('invalidFolderPath') + previewText(raw));
    return;
  }

  openInFileManager(hit.path, !hit.isDir);
}

module.exports = { handleOpenFolder, openInFileManager };
