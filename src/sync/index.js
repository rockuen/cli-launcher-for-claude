// repo sync — Sprint 0 foundation: file watcher only.
// Auto-commit + push land in Sprint 1; this lane just emits change/add/unlink
// events to the Debug Console so we can confirm the watcher pipeline is wired
// up before any git plumbing exists.
//
// Activation contract: activation.js wraps `require('./sync').start(context)`
// in a try/catch so a missing chokidar (or any throw here) never breaks the
// rest of the launcher. start() itself bails early when the feature flag is
// off, so the chokidar require only matters for users who opt in.
//
// Path resolution (multi-device friendly):
//   1. ${workspaceFolder} / ${userHome} / ${env:VAR} substitution in repoSync.path
//   2. If path is empty after substitution, fall back to the first workspace folder
// This lets a single .vscode/settings.json (committed inside the repo) drive
// every device — set path = "${workspaceFolder}" and the watcher attaches to
// whatever device-local absolute path the IDE happens to open the repo at.

const chokidar = require('chokidar');
const vscode = require('vscode');
const os = require('os');

let watcher = null;

function resolvePath(raw) {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return (raw || '')
    .replace(/\$\{workspaceFolder\}/g, ws || '')
    .replace(/\$\{userHome\}/g, os.homedir())
    .replace(/\$\{env:([A-Z_][A-Z0-9_]*)\}/gi, (_, n) => process.env[n] || '');
}

function start(context) {
  const cfg = vscode.workspace.getConfiguration('claudeCodeLauncher.repoSync');
  if (!cfg.get('enabled', false)) return;

  let repoPath = resolvePath(cfg.get('path', ''));

  // Fallback: empty path → first workspace folder.
  if (!repoPath) {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (ws) {
      repoPath = ws;
      console.log(`[sync] repoSync.path empty — using workspace folder: ${repoPath}`);
    } else {
      console.log('[sync] repoSync.enabled=true but no path and no workspace folder — skipping.');
      return;
    }
  }

  watcher = chokidar.watch(repoPath, {
    ignored: /(^|[\/\\])\../, // .git, .obsidian, etc. — never sync these
    persistent: true,
    ignoreInitial: true,
  });

  watcher
    .on('add',    (p) => console.log(`[sync] add ${p}`))
    .on('change', (p) => console.log(`[sync] change ${p}`))
    .on('unlink', (p) => console.log(`[sync] unlink ${p}`));

  context.subscriptions.push({ dispose: () => watcher && watcher.close() });

  console.log(`[sync] watching ${repoPath}`);
}

module.exports = { start };
