// @module panel/restartPty — restart Claude CLI in same panel keeping cols/rows/sessionId.
// Reuses createContextParser; safer than spawning a fresh parser per chunk.

const vscode = require('vscode');
const state = require('../state');
const { t } = require('../i18n');
const { resolveClaudeCli, resolveKiroCli } = require('../pty/resolveCli');
const { killPtyProcess } = require('../pty/kill');
const { createContextParser } = require('../pty/contextParser');
const { saveSessions } = require('../store/sessionManager');
const { setTabIcon, updateStatusBar, setIdleIcon } = require('./statusIndicator');
const { detectShellRunning } = require('../lib/shellRunningDetect');
const { sendPtyChunkPaced } = require('../lib/ptyChunk');

const IDLE_DELAY_MS = 3000;

function restartPty(entry, panel, context, extensionPath) {
  if (entry._restarting) return;
  entry._restarting = true;

  let pty;
  try {
    pty = require('node-pty');
  } catch (e) {
    entry._restarting = false;
    vscode.window.showErrorMessage(t('nodePtyFail') + e.message);
    return;
  }

  const agent = vscode.workspace.getConfiguration('claudeCodeLauncher').get('agent') || 'claude';
  let shell, args;
  if (agent === 'kiro') {
    const resolvedKiro = resolveKiroCli();
    if (!resolvedKiro) {
      entry._restarting = false;
      vscode.window.showErrorMessage('Kiro CLI (kiro-cli) not found.');
      return;
    }
    shell = resolvedKiro.shell;
    // kiro resume args, same precedence as createPanel: a Tree-resumed panel
    // (entry.isKiroResume, real kiro id) restarts via --resume-id; otherwise
    // --resume (cwd-latest) for a known sessionId, or a fresh ['chat'].
    const kiroArgs = entry.isKiroResume
      ? ['chat', '--resume-id', entry.sessionId]
      : (entry.sessionId ? ['chat', '--resume'] : ['chat']);
    args = [...resolvedKiro.args, ...kiroArgs];
  } else {
    // agent === 'claude' (default) — original logic preserved
    const resolved = resolveClaudeCli();
    if (!resolved) {
      entry._restarting = false;
      vscode.window.showErrorMessage('Claude Code CLI not found.');
      return;
    }
    shell = resolved.shell;
    const autoEffortMax = vscode.workspace.getConfiguration('claudeCodeLauncher').get('autoEffortMax', false);
    args = [...resolved.args, ...(entry.sessionId ? ['--resume', entry.sessionId] : []), ...(autoEffortMax ? ['--effort', 'max'] : [])];
  }

  // Kill old PTY before spawning new one to prevent orphaned processes
  if (entry.pty) {
    killPtyProcess(entry.pty);
    entry.pty = null;
  }
  entry._recentTail = '';   // fresh run — don't let the prior session's prompt
  entry._promptSig = null;  // footer satisfy the idle prompt-affordance check
  if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
  entry._disposed = false;

  try {
    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: entry._lastCols || 120,
      rows: entry._lastRows || 30,
      cwd: entry.cwd,
      env: { ...process.env, FORCE_COLOR: '1' }
    });

    entry.pty = ptyProcess;
    entry.state = 'running';
    setTabIcon(panel, 'running', extensionPath);
    panel.title = entry.title;
    try { panel.webview.postMessage({ type: 'state', state: 'running' }); } catch (_) {}
    saveSessions();
    updateStatusBar();
    entry._restarting = false;

    // Re-attach PTY events with fresh parser instance
    const thisPty = ptyProcess;
    const contextParser = createContextParser();
    ptyProcess.onData(data => {
      if (entry.pty !== thisPty) return; // stale handler guard
      sendPtyChunkPaced(panel, data, entry);

      const usage = contextParser.feed(data, entry);
      if (usage) {
        try { panel.webview.postMessage({ type: 'context-usage', ...usage }); } catch (_) {}
      }

      // v3.5.2: mirror createPanel — record background-shell hint for blue dot.
      const bgShells = detectShellRunning(data);
      if (bgShells != null) {
        entry._bgShells = bgShells;
        entry._bgShellsAt = Date.now();
      }

      if (entry.state !== 'running' && entry.state !== 'done' && entry.state !== 'error') {
        entry.state = 'running';
        setTabIcon(panel, 'running', extensionPath);
        try { panel.webview.postMessage({ type: 'state', state: 'running' }); } catch (_) {}
        updateStatusBar();
      }

      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.idleTimer = setTimeout(() => {
        if (entry._disposed) return;
        if (!entry.pty || entry.state === 'done' || entry.state === 'error') return;
        if (panel.active) {
          entry.state = 'waiting';
          setIdleIcon(panel, entry, extensionPath);
          try { panel.webview.postMessage({ type: 'state', state: 'waiting' }); } catch (_) {}
        } else {
          entry.state = 'needs-attention';
          setTabIcon(panel, 'done', extensionPath);
          try { panel.webview.postMessage({ type: 'state', state: 'needs-attention' }); } catch (_) {}
          try { panel.webview.postMessage({ type: 'notify' }); } catch (_) {}
        }
        updateStatusBar();
        state.refreshSessionTrees();
      }, IDLE_DELAY_MS);
    });

    ptyProcess.onExit(({ exitCode }) => {
      if (entry.pty !== thisPty) return; // stale handler guard
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      const isSuccess = exitCode === 0 || exitCode === null || exitCode === undefined;
      entry.state = isSuccess ? 'done' : 'error';
      entry.pty = null;
      saveSessions();
      updateStatusBar();

      if (!entry._disposed) {
        if (isSuccess) {
          setTabIcon(panel, 'done', extensionPath);
          panel.title = entry.title + t('suffixDone');
          try { panel.webview.postMessage({ type: 'state', state: 'done' }); } catch (_) {}
        } else {
          setTabIcon(panel, 'error', extensionPath);
          panel.title = entry.title + t('suffixError').replace('{0}', exitCode);
          try { panel.webview.postMessage({ type: 'state', state: 'error' }); } catch (_) {}
        }
        try { panel.webview.postMessage({ type: 'process-exited', exitCode, canResume: !!entry.sessionId }); } catch (_) {}
      }
    });

  } catch (e) {
    entry._restarting = false;
    vscode.window.showErrorMessage(t('restartFail') + e.message);
  }
}

module.exports = { restartPty };
