// @module handlers/openFile — opens a file via OS default app or IDE editor.
// Handles partial-path recovery (cwd/ancestors/home/roots) and
// honors fileAssociations setting (obsidian/excel/browser/system/editor/
// notewise/auto). `.md` on 'auto' opens NoteWise when installed, otherwise the
// IDE's default editor — see lib/openMethod.
//
// Windows quirk: vscode.env.openExternal silently fails for file:// URIs in
// some Electron hosts (Antigravity). We use `cmd /c start` with verbatim args
// so cmd sees the quoted path intact.
//
// v3.9: when cwd-relative resolution and the cwd basename walk both miss, we
// fall back to the OS file index (Everything es.exe / Spotlight mdfind /
// locate) via lib/fileLocator so a bare filename the agent printed — e.g.
// "_merged_erp_inbound.csv" written somewhere outside the session cwd — still
// opens. One exact hit opens directly; several show a QuickPick.

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { t } = require('../i18n');
const { expandBraces } = require('../util/braceExpand');
const fileLocator = require('../lib/fileLocator');
const { resolveOpenMethod, migrateFrozenFileAssociations, NOTEWISE_EXTENSION_ID, NOTEWISE_VIEW_TYPE } = require('../lib/openMethod');
// Path reading (wrapped rows, quotes, particles, file:// / Git Bash shapes,
// :LINE suffixes) is shared with Open Folder — see lib/pathSelection.
const { resolvePathFragment, resolveSelection, fallbackQuery, findUnderCwd, previewText } = require('../lib/pathSelection');
const { openInFileManager } = require('./openFolder');

// v3.9: OS file-index fallback. Returns an absolute file path to open, or null
// (nothing found, locator disabled/unavailable, or the user dismissed the
// picker). basename-only query; when the original fragment carried directory
// parts we narrow multi-hits by suffix so "scripts/foo.py" prefers a hit that
// actually ends in scripts/foo.py.
async function tryLocateOnDisk(raw) {
  let config;
  try { config = vscode.workspace.getConfiguration('claudeCodeLauncher'); }
  catch (_) { return null; }
  const fl = config.get('fileLocator', {}) || {};
  if (fl.enabled === false) return null;

  const normalizedRaw = String(raw || '').replace(/\\/g, '/');
  const basename = path.basename(normalizedRaw);
  if (!basename || /[*?]/.test(basename)) return null; // need a concrete name

  let results;
  try {
    results = await fileLocator.locateFiles(basename, {
      esPath: typeof fl.esPath === 'string' ? fl.esPath : '',
      maxResults: typeof fl.maxResults === 'number' ? fl.maxResults : 20,
    });
  } catch (_) { return null; }
  if (!results || results.length === 0) return null;

  // Narrow by the fragment suffix when the link carried directory parts.
  if (normalizedRaw.includes('/')) {
    const suffix = normalizedRaw.toLowerCase().replace(/^[./]+/, '');
    const narrowed = results.filter(
      (p) => p.replace(/\\/g, '/').toLowerCase().endsWith(suffix)
    );
    if (narrowed.length > 0) results = narrowed;
  }

  if (results.length === 1) return results[0];

  const homeFwd = os.homedir().replace(/\\/g, '/');
  const items = results.map((p) => {
    const fwd = p.replace(/\\/g, '/');
    const description = fwd.toLowerCase().startsWith(homeFwd.toLowerCase())
      ? '~' + fwd.slice(homeFwd.length)
      : fwd;
    return { label: path.basename(p), description, _path: p };
  });
  let picked;
  try {
    picked = await vscode.window.showQuickPick(items, {
      placeHolder: t('locatePickPlaceholder'),
      matchOnDescription: true,
    });
  } catch (_) { return null; }
  return picked ? picked._path : null;
}

async function handleOpenFile(filePath, line, entry) {
  const raw = String(filePath || '').trim();
  if (!raw) {
    vscode.window.showWarningMessage(t('fileNotFound') + filePath);
    return;
  }

  // Phase 11: shell-style brace expansion. Agent output often contains
  // patterns like `worker-{1,2,3}/answer.md`; open each expansion.
  const _expansions = expandBraces(raw);
  if (_expansions.length > 1) {
    for (const _exp of _expansions) await handleOpenFile(_exp, line, entry);
    return;
  }

  const cwd = entry && entry.cwd;
  let absPath = null;
  const hit = resolveSelection(raw, cwd);
  if (hit) {
    // "Open File" on a folder opens the folder instead of "File not found".
    if (hit.isDir) {
      openInFileManager(hit.path, false);
      return;
    }
    absPath = hit.path;
    if (!line && hit.line) line = hit.line;
  } else {
    const query = fallbackQuery(raw);
    if (!line && query.line) line = query.line;
    // Basename search within cwd (legacy behavior for deeply nested project files).
    const found = findUnderCwd(cwd, query.path, { dirs: false });
    if (found) absPath = found.path;
    // v3.9: last resort — query the OS file index (Everything / mdfind / locate)
    // for the bare filename anywhere on disk. See lib/fileLocator. Disabled or
    // unavailable → returns null and we fall through to the not-found message.
    if (!absPath && query.path) {
      const located = await tryLocateOnDisk(query.path);
      if (located) absPath = located;
    }
    // Last resorts: a name selected a few characters short ("…배송지.xls"),
    // then a folder named by one row (a folder path with prose after it).
    if (!absPath) {
      const lastHit = resolveSelection(raw, cwd, { completeShort: true })
        || resolveSelection(raw, cwd, { partialDirs: true });
      if (lastHit && lastHit.isDir) {
        openInFileManager(lastHit.path, false);
        return;
      }
      if (lastHit) {
        absPath = lastHit.path;
        if (!line && lastHit.line) line = lastHit.line;
      }
    }
  }

  if (!absPath || !fs.existsSync(absPath)) {
    vscode.window.showWarningMessage(t('fileNotFound') + previewText(raw));
    return;
  }

  try {
    if (fs.statSync(absPath).isDirectory()) {
      openInFileManager(absPath, false);
      return;
    }
  } catch (_) {}

  absPath = absPath.replace(/\\/g, '/');

  const { spawn } = require('child_process');
  const config = vscode.workspace.getConfiguration('claudeCodeLauncher');
  const fileAssoc = config.get('fileAssociations', {});
  const ext = path.extname(absPath).toLowerCase();
  const method = resolveOpenMethod(ext, fileAssoc, {
    notewiseInstalled: !!vscode.extensions.getExtension(NOTEWISE_EXTENSION_ID),
  });
  const nativePath = absPath.replace(/\//g, path.sep);

  const shellOpen = () => {
    try {
      let child;
      if (process.platform === 'win32') {
        child = spawn('cmd.exe', ['/c', 'start', '""', `"${nativePath}"`], {
          detached: true,
          stdio: 'ignore',
          windowsVerbatimArguments: true
        });
      } else if (process.platform === 'darwin') {
        child = spawn('open', [nativePath], { detached: true, stdio: 'ignore' });
      } else {
        child = spawn('xdg-open', [nativePath], { detached: true, stdio: 'ignore' });
      }
      child.on('error', (err) => {
        vscode.window.showWarningMessage('Open file failed: ' + (err && err.message ? err.message : String(err)));
      });
      child.unref();
    } catch (e) {
      vscode.window.showWarningMessage('Open file failed: ' + (e && e.message ? e.message : String(e)));
    }
  };

  const openNative = (app) => {
    if (process.platform === 'darwin') {
      spawn('open', app ? ['-a', app, nativePath] : [nativePath], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'win32') {
      // Windows app names like 'excel' rarely live in PATH. Defer to file association.
      shellOpen();
    } else {
      spawn(app || 'xdg-open', [nativePath], { detached: true, stdio: 'ignore' }).unref();
    }
  };

  if (method === 'obsidian') {
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath?.replace(/\\/g, '/');
    const vaultRoot = wsFolder ? wsFolder + '/' : '';
    const vaultName = wsFolder ? path.basename(wsFolder) : '';
    let relativePath = absPath;
    if (vaultRoot && absPath.toLowerCase().startsWith(vaultRoot.toLowerCase())) {
      relativePath = absPath.substring(vaultRoot.length);
    }
    const obsidianUri = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(relativePath)}`;
    vscode.env.openExternal(vscode.Uri.parse(obsidianUri));
  } else if (method === 'excel') {
    if (process.platform === 'darwin') {
      openNative('Microsoft Excel');
    } else if (process.platform === 'win32') {
      shellOpen();
    } else {
      spawn('libreoffice', ['--calc', nativePath], { detached: true, stdio: 'ignore' }).unref();
    }
  } else if (method === 'browser' || method === 'system') {
    openNative(null);
  } else if (method === 'editor') {
    const fileUri = vscode.Uri.file(nativePath);
    const options = line ? { selection: new vscode.Range(line - 1, 0, line - 1, 0) } : {};
    vscode.window.showTextDocument(fileUri, options);
  } else if (method === 'notewise') {
    // Open in the NoteWise Markdown Editor custom editor (rockuen.notewise-editor).
    const fileUri = vscode.Uri.file(nativePath);
    vscode.commands.executeCommand('vscode.openWith', fileUri, NOTEWISE_VIEW_TYPE).then(undefined, warnOpenFailed);
  } else if (method === 'default') {
    // The IDE's own default editor for this file type (honors
    // workbench.editorAssociations), unlike 'editor' which forces text.
    const fileUri = vscode.Uri.file(nativePath);
    const options = line ? { selection: new vscode.Range(line - 1, 0, line - 1, 0) } : {};
    vscode.commands.executeCommand('vscode.open', fileUri, options).then(undefined, warnOpenFailed);
  } else if (method !== 'auto') {
    if (process.platform === 'darwin') {
      openNative(method);
    } else if (process.platform === 'win32') {
      shellOpen();
    } else {
      spawn(method, [nativePath], { detached: true, stdio: 'ignore' }).unref();
    }
  } else {
    // auto: OS default for known types, IDE editor for others
    if (/\.(html?|xlsx?|csv|pptx?|docx?|pdf|png|jpe?g|gif|svg|zip|tar|gz)$/i.test(ext)) {
      shellOpen();
    } else {
      const fileUri = vscode.Uri.file(nativePath);
      const options = line ? { selection: new vscode.Range(line - 1, 0, line - 1, 0) } : {};
      vscode.window.showTextDocument(fileUri, options);
    }
  }
}

function warnOpenFailed(e) {
  vscode.window.showWarningMessage('Open file failed: ' + (e && e.message ? e.message : String(e)));
}

// v3.25.0: drop a fileAssociations map the pre-3.25 settings panel froze into
// Global settings, so `.md` follows the new 'auto' default (lib/openMethod).
function migrateFileAssociationsSetting() {
  try {
    const config = vscode.workspace.getConfiguration('claudeCodeLauncher');
    const info = config.inspect('fileAssociations');
    if (!info) return;
    const next = migrateFrozenFileAssociations(info.globalValue, info.defaultValue);
    if (!next) return;
    const value = Object.keys(next).length ? next : undefined;
    config.update('fileAssociations', value, vscode.ConfigurationTarget.Global).then(undefined, () => {});
  } catch (_) {}
}

module.exports = { handleOpenFile, resolvePathFragment, migrateFileAssociationsSetting };
