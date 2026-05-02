// vault sync — Sprint 0 foundation: file watcher only.
// Auto-commit + push land in Sprint 1; this lane just emits change/add/unlink
// events to the Debug Console so we can confirm the watcher pipeline is wired
// up before any git plumbing exists.
//
// Activation contract: activation.js wraps `require('./sync').start(context)`
// in a try/catch so a missing chokidar (or any throw here) never breaks the
// rest of the launcher. start() itself bails early when the feature flag is
// off, so the chokidar require only matters for users who opt in.

const chokidar = require('chokidar');
const vscode = require('vscode');

let watcher = null;

function start(context) {
  const cfg = vscode.workspace.getConfiguration('claudeCodeLauncher.vaultSync');
  if (!cfg.get('enabled', false)) return;

  const vaultPath = cfg.get('path', '');
  if (!vaultPath) {
    console.log('[sync] vaultSync.enabled=true but vaultSync.path is empty — skipping.');
    return;
  }

  watcher = chokidar.watch(vaultPath, {
    ignored: /(^|[\/\\])\../, // .git, .obsidian, etc. — never sync these
    persistent: true,
    ignoreInitial: true,
  });

  watcher
    .on('add',    (p) => console.log(`[sync] add ${p}`))
    .on('change', (p) => console.log(`[sync] change ${p}`))
    .on('unlink', (p) => console.log(`[sync] unlink ${p}`));

  context.subscriptions.push({ dispose: () => watcher && watcher.close() });

  console.log(`[sync] watching ${vaultPath}`);
}

module.exports = { start };
