// @module panel/restartPty — restart Claude CLI in same panel keeping cols/rows/sessionId.
// Reuses createContextParser; safer than spawning a fresh parser per chunk.

const vscode = require('vscode');
const state = require('../state');
const { t } = require('../i18n');
const { resolveClaudeCli, resolveKiroCli, resolveAntigravityCli, resolveCodexCli, resolveGrokCli } = require('../pty/resolveCli');
const { findCodexSessionPath, findGrokSessionPath } = require('../lib/sessionJsonl');
const { prepareProjectSessionEnvironment } = require('../lib/projectSessions');
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

  // Restart with the PANEL's agent, not the global default. Reading the
  // claudeCodeLauncher.agent setting here (the original code) respawned a
  // kiro/antigravity tab as whatever the global default was — e.g. a kiro tab
  // restarted while the default is claude ran `claude --resume <kiro-id>`.
  // entry.agent is set by createPanel for every panel; the setting remains a
  // fallback for entries restored from a pre-agent-field session store.
  const agent = entry.agent
    || vscode.workspace.getConfiguration('claudeCodeLauncher').get('agent')
    || 'claude';
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
    // --trust-all-tools (opt-in): let Kiro use any tool without per-call
    // confirmation. Flag order after the chat subcommand is not significant.
    if (vscode.workspace.getConfiguration('claudeCodeLauncher').get('kiro.trustAllTools', false)) {
      kiroArgs.push('--trust-all-tools');
    }
    args = [...resolvedKiro.args, ...kiroArgs];
  } else if (agent === 'antigravity') {
    const resolvedAgy = resolveAntigravityCli();
    if (!resolvedAgy) {
      entry._restarting = false;
      vscode.window.showErrorMessage('Antigravity CLI (agy) not found.');
      return;
    }
    shell = resolvedAgy.shell;
    // agy resume args, same precedence as createPanel: Tree-resume (real agy id)
    // → --conversation <id>; known sessionId (auto-restore) → --continue;
    // neither → [] (fresh session).
    const agyArgs = entry.isAntigravityResume
      ? ['--conversation', entry.sessionId]
      : (entry.sessionId ? ['--continue'] : []);
    if (vscode.workspace.getConfiguration('claudeCodeLauncher').get('antigravity.trustAllTools', false)) {
      agyArgs.push('--dangerously-skip-permissions');
    }
    args = [...resolvedAgy.args, ...agyArgs];
  } else if (agent === 'codex') {
    const resolvedCodex = resolveCodexCli();
    if (!resolvedCodex) {
      entry._restarting = false;
      vscode.window.showErrorMessage('Codex CLI (codex) not found.');
      return;
    }
    shell = resolvedCodex.shell;
    // codex resume args, same precedence as createPanel: Tree-resume (real
    // rollout UUID) → resume <id>; known sessionId (auto-restore) → resume
    // --last; neither → [] (fresh TUI session).
    const codexArgs = (entry.isCodexResume || (entry.sessionId && findCodexSessionPath(entry.sessionId, null, entry.cwd)))
      ? ['resume', entry.sessionId]
      : (entry.sessionId ? ['resume', '--last'] : []);
    // --dangerously-bypass-approvals-and-sandbox (opt-in via codex.trustAllTools),
    // same as createPanel: skip all approval prompts + sandbox. Global flag, so
    // it works after the resume subcommand too.
    if (vscode.workspace.getConfiguration('claudeCodeLauncher').get('codex.trustAllTools', false)) {
      codexArgs.push('--dangerously-bypass-approvals-and-sandbox');
    }
    args = [...resolvedCodex.args, ...codexArgs];
  } else if (agent === 'grok') {
    const resolvedGrok = resolveGrokCli();
    if (!resolvedGrok) {
      entry._restarting = false;
      vscode.window.showErrorMessage('Grok CLI (grok) not found.');
      return;
    }
    shell = resolvedGrok.shell;
    // grok resume args, same precedence as createPanel: exact real id →
    // --resume <id>; known placeholder id → --resume (cwd-latest); neither →
    // fresh TUI session.
    const grokArgs = (entry.isGrokResume || (entry.sessionId && findGrokSessionPath(entry.sessionId, null, entry.cwd)))
      ? ['--resume', entry.sessionId]
      : (entry.sessionId ? ['--resume'] : []);
    if (vscode.workspace.getConfiguration('claudeCodeLauncher').get('grok.trustAllTools', false)) {
      grokArgs.push('--always-approve');
    }
    args = [...resolvedGrok.args, ...grokArgs];
  } else {
    // agent === 'claude' (default) — original logic preserved
    const resolved = resolveClaudeCli();
    if (!resolved) {
      entry._restarting = false;
      vscode.window.showErrorMessage('Claude Code CLI not found.');
      return;
    }
    shell = resolved.shell;
    const claudeCfg = vscode.workspace.getConfiguration('claudeCodeLauncher');
    const autoEffortMax = claudeCfg.get('autoEffortMax', false);
    const bypassPermissions = claudeCfg.get('claude.bypassPermissions', false);
    args = [...resolved.args, ...(entry.sessionId ? ['--resume', entry.sessionId] : []), ...(autoEffortMax ? ['--effort', 'max'] : []), ...(bypassPermissions ? ['--dangerously-skip-permissions'] : [])];
  }

  // Kill old PTY before spawning new one to prevent orphaned processes.
  // Detach its data listener first — the kill flushes ConPTY's buffered
  // output, which would otherwise land in the old onData handler.
  if (entry._ptyDataSub) {
    try { entry._ptyDataSub.dispose(); } catch (_) {}
    entry._ptyDataSub = null;
  }
  if (entry.pty) {
    killPtyProcess(entry.pty);
    entry.pty = null;
  }
  entry._recentTail = '';   // fresh run — don't let the prior session's prompt
  entry._promptSig = null;  // footer satisfy the idle prompt-affordance check
  if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
  entry._disposed = false;

  try {
    const sessionEnv = prepareProjectSessionEnvironment(agent, entry.cwd, process.env);
    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: entry._lastCols || 120,
      rows: entry._lastRows || 30,
      cwd: entry.cwd,
      env: { ...sessionEnv, FORCE_COLOR: '1', COLORFGBG: '15;0' }
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
    entry._ptyDataSub = ptyProcess.onData(data => {
      if (entry._disposed || entry.pty !== thisPty) return; // disposed/stale handler guard
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
