// repo sync — Sprint 1: watcher + debounced auto-commit + background push.
//
// Lifecycle:
//   start(context)                  ← activation.js wraps in try/catch
//     ├─ creates a left-aligned status bar item
//     ├─ subscribes to onDidChangeConfiguration so toggling repoSync.* in
//     │  settings hot-reloads the watcher (no Reload Window required)
//     └─ reload() — (re)builds the chokidar watcher when enabled
//
//   chokidar event → scheduleSync() — resets a debounce timer
//   timer fires    → runSync():
//     1. git status --porcelain (bail if clean)
//     2. ensureDeviceName() — prompts on first use, persists to user settings
//     3. git add -A && git commit -m "[<device>] auto-sync: <ts> (<n>)"
//     4. git push — fire-and-forget; failures surface on the status bar
//
//   deactivate     → flushSyncSync() — synchronous best-effort commit; no push
//                    (network is unreliable during VS Code shutdown)
//
// Status bar states: disabled / idle / pending / syncing / error.

const chokidar = require('chokidar');
const vscode = require('vscode');
const os = require('os');
const cp = require('child_process');
const { t } = require('../i18n');

let watcher = null;
let debounceTimer = null;
let configListener = null;
let statusBar = null;
let _state = 'disabled';
let _devicePromptDeclined = false;
let _lastError = null;
let _lastSyncAt = null;
let _pendingChanges = 0;
let _repoPath = null;

// Hard cap on the pending-changes counter. Event storms from CI/automation
// (sed temp files, log rotation, build outputs) used to push this to runaway
// numbers — the visible status bar tooltip stayed at a sane upper bound and
// `runSync` recomputes the real count from `git status --porcelain` anyway,
// so further increments past this cap are pure waste.
const PENDING_CHANGES_CAP = 100000;

// Default ignore patterns applied on top of the user's `extraIgnore` list.
// Covers the worst freeze trigger seen in the wild: matricies of fast-churn
// files (sed temp + run_hourly.bat-style rotated logs) firing thousands of
// add/change/unlink events per minute. `.git` is already excluded by the
// dotfile pattern so we don't double-list it.
const DEFAULT_IGNORED = [
  /(^|[\/\\])\../,                       // dot files (.git, .DS_Store, .swp)
  /[\/\\]node_modules([\/\\]|$)/,        // node_modules anywhere in the tree
  /[\/\\]logs?([\/\\]|$)/,               // log/ or logs/ directories
  /\.log(\.\d+)?$/i,                     // *.log, *.log.1, *.log.2
  /\.tmp$/i,                             // *.tmp
  /[\/\\]sed[A-Za-z0-9]{5,}$/,           // sed*** temp files (sedLOvKxk)
  /\.swp$/i,                             // vim swap files
  /\.swx$/i,
];

function buildIgnoredPatterns() {
  const cfg = getCfg();
  const extra = cfg.get('extraIgnore', []);
  const extraOk = Array.isArray(extra)
    ? extra.filter((s) => typeof s === 'string' && s.trim().length > 0)
    : [];
  return [...DEFAULT_IGNORED, ...extraOk];
}

// Throttled event logger. Event storms used to flood the Extension Host
// console — 100+ lines per second compounded with chokidar's own work to
// push the host into unresponsive territory. Cap visible lines at 10 per
// minute and aggregate the rest into a single summary so debugging real
// repo activity still works without drowning in noise.
let _eventLogCount = 0;
let _eventLogSuppressed = 0;
let _eventLogResetTimer = null;
function logSyncEvent(kind, p) {
  if (_eventLogCount < 10) {
    _eventLogCount++;
    console.log(`[sync] ${kind} ${p}`);
  } else {
    _eventLogSuppressed++;
  }
  if (!_eventLogResetTimer) {
    _eventLogResetTimer = setTimeout(() => {
      if (_eventLogSuppressed > 0) {
        console.log(`[sync] (suppressed ${_eventLogSuppressed} more events in the last minute)`);
      }
      _eventLogCount = 0;
      _eventLogSuppressed = 0;
      _eventLogResetTimer = null;
    }, 60000);
  }
}

const STATE_TEXT = {
  disabled: '$(circle-slash) Repo',
  idle:     '$(check) Repo',
  pending:  '$(history) Repo',
  syncing:  '$(sync~spin) Repo',
  error:    '$(error) Repo',
};

function resolvePath(raw) {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return (raw || '')
    .replace(/\$\{workspaceFolder\}/g, ws || '')
    .replace(/\$\{userHome\}/g, os.homedir())
    .replace(/\$\{env:([A-Z_][A-Z0-9_]*)\}/gi, (_, n) => process.env[n] || '');
}

function getCfg() {
  return vscode.workspace.getConfiguration('claudeCodeLauncher.repoSync');
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function setStatus(state) {
  _state = state;
  if (!statusBar) return;
  statusBar.text = STATE_TEXT[state] || STATE_TEXT.idle;
  const tip = [`Repo Sync — ${state}`];
  if (_repoPath) tip.push(_repoPath);
  if (_pendingChanges) tip.push(`${_pendingChanges} pending change${_pendingChanges === 1 ? '' : 's'}`);
  if (_lastSyncAt) tip.push(`last sync: ${_lastSyncAt}`);
  if (_lastError) tip.push(`last error: ${_lastError}`);
  statusBar.tooltip = tip.join('\n');
  statusBar.backgroundColor = state === 'error'
    ? new vscode.ThemeColor('statusBarItem.errorBackground')
    : state === 'pending'
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
}

async function ensureDeviceName(force = false) {
  const cfg = getCfg();
  const name = (cfg.get('deviceName') || '').trim();
  if (name) return name;
  if (!force && _devicePromptDeclined) return null;

  const input = await vscode.window.showInputBox({
    title: 'Repo Sync — device name',
    prompt: t('syncDeviceNamePrompt'),
    placeHolder: 'e.g. Mac',
    ignoreFocusOut: true,
    validateInput: (v) => (v && v.trim()) ? null : 'Required',
  });
  if (!input || !input.trim()) {
    _devicePromptDeclined = true;
    vscode.window.showWarningMessage(
      '[sync] device name not set — auto-commit paused. Run "Repo Sync: Set Device Name" or edit claudeCodeLauncher.repoSync.deviceName.'
    );
    return null;
  }
  await cfg.update('deviceName', input.trim(), vscode.ConfigurationTarget.Global);
  _devicePromptDeclined = false;
  return input.trim();
}

function execGit(args) {
  return new Promise((resolve, reject) => {
    cp.execFile('git', ['-C', _repoPath, ...args], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      resolve({ stdout, stderr });
    });
  });
}

async function runSync() {
  if (_state === 'syncing') return;
  if (!_repoPath) return;

  let changed;
  try {
    const { stdout } = await execGit(['status', '--porcelain']);
    changed = stdout.split('\n').filter((l) => l.length).length;
  } catch (e) {
    _lastError = e.message.split('\n')[0];
    setStatus('error');
    return;
  }
  if (changed === 0) {
    _pendingChanges = 0;
    _lastError = null;
    _lastSyncAt = nowStamp();
    setStatus('idle');
    return;
  }
  _pendingChanges = changed;

  const device = await ensureDeviceName();
  if (!device) { setStatus('pending'); return; }

  setStatus('syncing');
  try {
    await execGit(['add', '-A']);
    await execGit(['commit', '-m', `[${device}] auto-sync: ${nowStamp()} (${changed} change${changed === 1 ? '' : 's'})`]);
  } catch (e) {
    _lastError = (e.stderr || e.message || '').split('\n')[0];
    setStatus('error');
    return;
  }

  execGit(['push']).then(() => {
    _lastError = null;
    _lastSyncAt = nowStamp();
    _pendingChanges = 0;
    setStatus('idle');
  }).catch((e) => {
    _lastError = (e.stderr || e.message || '').split('\n')[0];
    _lastSyncAt = nowStamp(); // commit succeeded even if push didn't
    setStatus('error');
    vscode.window.showWarningMessage(`[sync] push failed: ${_lastError}`);
  });
}

function scheduleSync() {
  const cfg = getCfg();
  if (!cfg.get('autoCommit', false)) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  if (_pendingChanges < PENDING_CHANGES_CAP) _pendingChanges += 1;
  setStatus('pending');
  const wait = Math.max(10000, cfg.get('debounceMs', 300000));
  debounceTimer = setTimeout(() => { debounceTimer = null; runSync(); }, wait);
}

// Synchronous best-effort commit during deactivate. No push — that needs
// network + async/await which VS Code doesn't reliably grant during shutdown.
function flushSyncSync() {
  if (!_repoPath) return;
  const cfg = getCfg();
  if (!cfg.get('autoCommit', false)) return;
  const device = (cfg.get('deviceName') || '').trim();
  if (!device) return;
  try {
    const status = cp.execFileSync('git', ['-C', _repoPath, 'status', '--porcelain'], {
      encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024,
    });
    if (!status.trim()) return;
    const changed = status.split('\n').filter((l) => l.length).length;
    cp.execFileSync('git', ['-C', _repoPath, 'add', '-A'], { stdio: 'ignore' });
    cp.execFileSync('git', ['-C', _repoPath, 'commit', '-m',
      `[${device}] auto-sync (shutdown): ${nowStamp()} (${changed} change${changed === 1 ? '' : 's'})`,
    ], { stdio: 'ignore' });
  } catch (_) { /* best-effort */ }
}

function buildWatcher(repoPath) {
  const w = chokidar.watch(repoPath, {
    ignored: buildIgnoredPatterns(),
    persistent: true,
    ignoreInitial: true,
    // Coalesce rapid create+delete bursts (sed temp files, log rotation).
    // Files that never stabilize within the window emit no event at all —
    // exactly what we want for transient artifacts of external automation.
    awaitWriteFinish: {
      stabilityThreshold: 1000,
      pollInterval: 100,
    },
  });
  w.on('add',    (p) => { logSyncEvent('add', p);    scheduleSync(); })
   .on('change', (p) => { logSyncEvent('change', p); scheduleSync(); })
   .on('unlink', (p) => { logSyncEvent('unlink', p); scheduleSync(); });
  return w;
}

function tearDown() {
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (watcher) { watcher.close(); watcher = null; }
}

function reload() {
  tearDown();
  const cfg = getCfg();
  if (!cfg.get('enabled', false)) {
    _repoPath = null;
    setStatus('disabled');
    return;
  }
  let repoPath = resolvePath(cfg.get('path', ''));
  if (!repoPath) {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) {
      console.log('[sync] enabled=true but no path and no workspace folder — disabled.');
      _repoPath = null;
      setStatus('disabled');
      return;
    }
    repoPath = ws;
  }
  _repoPath = repoPath;
  watcher = buildWatcher(repoPath);
  setStatus('idle');
  console.log(`[sync] watching ${repoPath} (autoCommit=${cfg.get('autoCommit', false)})`);
}

function start(context) {
  if (!statusBar) {
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = 'claudeCodeLauncher.repoSync.openSettings';
    statusBar.show();
    context.subscriptions.push(statusBar);
  }
  if (!configListener) {
    configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeCodeLauncher.repoSync')) reload();
    });
    context.subscriptions.push(configListener);
  }
  context.subscriptions.push({ dispose: tearDown });
  reload();
}

function setDeviceName() {
  return ensureDeviceName(true);
}

module.exports = { start, flushSyncSync, setDeviceName };
