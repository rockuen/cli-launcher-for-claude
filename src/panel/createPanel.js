// @module panel/createPanel — orchestrates a new Claude Code tab.
// Webview options (`enableScripts: true`, `retainContextWhenHidden: true`) are intentional;
// see CHANGELOG entries for v2.0.0 (state retention) and v2.4.0 (security hardening).
//
// Lifecycle events handled directly here (NOT via messageRouter):
//   onDidChangeViewState — focus → clears needs-attention; viewColumn save on move
//   onDidDispose         — panels Map cleanup + session save (unless deactivating)
//
// Stale handler guard pattern (`entry.pty !== initialPty`) is preserved on every
// async PTY callback so a restart can't have an old chunk corrupt new entry state.

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const state = require('../state');
const { t, getTranslations } = require('../i18n');
const { saveSessions } = require('../store/sessionManager');
const { resolveClaudeCli } = require('../pty/resolveCli');
const { killPtyProcess } = require('../pty/kill');
const { createContextParser } = require('../pty/contextParser');
const { getWebviewContent } = require('./webviewContent');
const { showDesktopNotification } = require('../handlers/desktopNotification');
const { setTabIcon, setStatusBar, updateStatusBar } = require('./statusIndicator');
const { routeWebviewMessage } = require('./messageRouter');

const IDLE_DELAY_MS = 3000;

// v2.6.6: interactive prompt patterns. When the PTY emits any of these,
// escalate the entry to needs-attention immediately instead of waiting
// out the 7-second running threshold. False positives are bounded by
// keeping the patterns specific to user-prompting language.
const INTERACTIVE_PROMPT_PATTERNS = [
  /Do you want to/i,
  /\[Y\/n\]/,
  /\[y\/N\]/,
  /\(y\/n\)/i,
  /\(yes\/no\)/i,
  /Press Enter to continue/i,
  /Press \[?Esc\]? to/i,
];
function looksLikePrompt(data) {
  for (let i = 0; i < INTERACTIVE_PROMPT_PATTERNS.length; i++) {
    if (INTERACTIVE_PROMPT_PATTERNS[i].test(data)) return true;
  }
  return false;
}

function createPanel(context, extensionPath, session, opts) {
  let pty;
  try {
    pty = require('node-pty');
  } catch (e) {
    vscode.window.showErrorMessage(t('nodePtyFail') + e.message);
    return;
  }

  // Phase 8: backend selection. 'webview' = direct claude pty (v2.6.6 default),
  // 'multiplexer' = wrap claude inside a tmux/psmux session so the same webview
  // hosts an attached multiplexer client. Falls back to webview silently if
  // the multiplexer binary is missing.
  let backend = (opts && opts.backend) || 'webview';
  // node-pty (WindowsPtyAgent) does NOT search PATH — it does fs.existsSync()
  // on whatever path string we hand it, so a bare name like "psmux" throws
  // "File not found:" even when child_process.execFileSync resolves it fine.
  // Resolve to an absolute path here so spawn never sees a bare name.
  let muxBinResolved = null;
  if (backend === 'multiplexer') {
    const muxBin = process.platform === 'win32' ? 'psmux' : 'tmux';
    try {
      require('child_process').execFileSync(muxBin, ['-V'], { timeout: 600, stdio: 'ignore' });
      const whichBin = process.platform === 'win32' ? 'where' : 'which';
      const whichOut = require('child_process')
        .execFileSync(whichBin, [muxBin], { encoding: 'utf8', timeout: 600 });
      muxBinResolved = whichOut.split(/\r?\n/)[0].trim() || null;
    } catch (_) {
      vscode.window.showInformationMessage(
        `CLI Launcher: ${muxBin} not detected — opening with the default webview backend.`
      );
      backend = 'webview';
    }
  }

  state.tabCounter++;
  const tabId = state.tabCounter;
  const tabTitle = session?.title || (state.tabCounter === 1 ? 'Claude Code' : `Claude Code (${state.tabCounter})`);

  const panel = vscode.window.createWebviewPanel(
    'claudeCode',
    tabTitle,
    { viewColumn: session?.viewColumn || vscode.ViewColumn.One, preserveFocus: !!session },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(extensionPath, 'node_modules')),
        vscode.Uri.file(path.join(extensionPath, 'icons'))
      ]
    }
  );

  setTabIcon(panel, 'running', extensionPath);
  setStatusBar('running');

  const config = vscode.workspace.getConfiguration('claudeCodeLauncher');
  const fontSize = config.get('defaultFontSize', 11);
  const fontFamily = config.get('defaultFontFamily', '"D2Coding", "D2Coding ligature", Consolas, monospace');
  const defaultTheme = config.get('defaultTheme', 'default');
  const soundEnabled = config.get('soundEnabled', true);
  const particlesEnabled = config.get('particlesEnabled', true);
  const autoEffortMax = config.get('autoEffortMax', false);
  const pasteToFileThreshold = config.get('pasteToFileThreshold', 2000);
  const pasteTableAsMarkdown = config.get('pasteTableAsMarkdown', true);
  const defaultBackend = config.get('terminal.defaultBackend', 'webview');
  const multiplexerLifecycle = config.get('terminal.multiplexerLifecycle', 'kill-on-close');

  const xtermCssUri = panel.webview.asWebviewUri(
    vscode.Uri.file(path.join(extensionPath, 'node_modules', 'xterm', 'css', 'xterm.css'))
  );
  const xtermJsUri = panel.webview.asWebviewUri(
    vscode.Uri.file(path.join(extensionPath, 'node_modules', 'xterm', 'lib', 'xterm.js'))
  );
  const fitAddonUri = panel.webview.asWebviewUri(
    vscode.Uri.file(path.join(extensionPath, 'node_modules', 'xterm-addon-fit', 'lib', 'xterm-addon-fit.js'))
  );
  const webLinksAddonUri = panel.webview.asWebviewUri(
    vscode.Uri.file(path.join(extensionPath, 'node_modules', 'xterm-addon-web-links', 'lib', 'xterm-addon-web-links.js'))
  );
  const searchAddonUri = panel.webview.asWebviewUri(
    vscode.Uri.file(path.join(extensionPath, 'node_modules', 'xterm-addon-search', 'lib', 'xterm-addon-search.js'))
  );

  const isDark = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
    || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast;

  const initialMemo = session?.memo || '';
  const customButtons = config.get('customButtons', []);
  const customSlashCommands = config.get('customSlashCommands', []);
  const fileAssociations = config.get('fileAssociations', {});
  const T = getTranslations();
  const settings = { fontFamily, defaultTheme, soundEnabled, particlesEnabled, autoEffortMax, fileAssociations, pasteToFileThreshold, pasteTableAsMarkdown, defaultBackend, multiplexerLifecycle };
  panel.webview.html = getWebviewContent(xtermCssUri, xtermJsUri, fitAddonUri, webLinksAddonUri, searchAddonUri, isDark, fontSize, tabTitle, initialMemo, customButtons, T, settings, customSlashCommands);

  // Spawn claude CLI
  const cwd = session?.cwd || vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || os.homedir();
  const sessionId = session?.sessionId || crypto.randomUUID();
  const resolved = resolveClaudeCli();
  if (!resolved) {
    const install = 'Install Claude Code';
    vscode.window.showErrorMessage(
      'Claude Code CLI not found. Please install it first: npm install -g @anthropic-ai/claude-code',
      install
    ).then(choice => {
      if (choice === install) {
        vscode.env.openExternal(vscode.Uri.parse('https://docs.anthropic.com/en/docs/claude-code/overview'));
      }
    });
    panel.dispose();
    return;
  }

  const shell = resolved.shell;
  const claudeArgs = session?.sessionId
    ? ['--resume', session.sessionId]
    : ['--session-id', sessionId];
  const args = [...resolved.args, ...claudeArgs];

  // Multiplexer wrap: keep the webview UI, but spawn an attached tmux/psmux
  // client so the in-tab terminal IS the multiplexer session. Quotes
  // whitespace-bearing tokens before joining into the single shell-command
  // argument that `<mux> new-session` expects.
  let spawnBin = shell;
  let spawnArgs = args;
  let muxSessionName = null;
  if (backend === 'multiplexer') {
    const muxBin = process.platform === 'win32' ? 'psmux' : 'tmux';
    muxSessionName = `cli-launcher-${sessionId.slice(0, 8)}`;
    const quote = (s) => (/[\s"']/.test(s) ? "'" + s.replace(/'/g, "'\\''") + "'" : s);
    const claudeCmdString = [shell, ...args].map(quote).join(' ');
    // Always hand node-pty an absolute path (see detect block above for why).
    spawnBin = muxBinResolved || muxBin;
    spawnArgs = ['new-session', '-A', '-s', muxSessionName, claudeCmdString];
  }

  console.log('[Claude Launcher] Spawning:', spawnBin, spawnArgs.join(' '), '| cwd:', cwd, '| backend:', backend);
  console.log('[Claude Launcher] resolved shell:', shell, '| args prefix:', resolved.args);

  let ptyProcess;
  try {
    ptyProcess = pty.spawn(spawnBin, spawnArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: cwd,
      env: { ...process.env, FORCE_COLOR: '1' }
    });
    console.log('[Claude Launcher] PTY spawned OK, pid:', ptyProcess.pid);
  } catch (e) {
    console.error('[Claude Launcher] PTY spawn FAILED:', e.message, e.stack);
    if (e.message && e.message.includes('posix_spawnp')) {
      const fix = 'Run npm rebuild';
      vscode.window.showErrorMessage(
        t('startFail') + 'node-pty native module incompatible. Run: cd ' + extensionPath + ' && npm rebuild node-pty',
        fix
      ).then(choice => {
        if (choice === fix) {
          const terminal = vscode.window.createTerminal('Fix node-pty');
          terminal.sendText('cd "' + extensionPath + '" && npm rebuild node-pty');
          terminal.show();
        }
      });
    } else {
      vscode.window.showErrorMessage(t('startFail') + e.message);
    }
    panel.dispose();
    return;
  }

  const entry = {
    panel,
    pty: ptyProcess,
    title: tabTitle,
    memo: session?.memo || '',
    cwd: cwd,
    sessionId: sessionId,
    state: 'running',
    idleTimer: null,
    backend: backend,
    muxSessionName: muxSessionName
  };
  state.panels.set(tabId, entry);
  saveSessions();

  // v2.6.6: title blink while needs-attention AND tab not focused.
  // Self-stops via state polling, so external state changes don't need
  // explicit stopBlink() calls. Restored on focus or state transition.
  let blinkInterval = null;
  let blinkOn = false;
  function startTitleBlink() {
    if (blinkInterval) return;
    blinkInterval = setInterval(() => {
      if (entry._disposed || entry.state !== 'needs-attention' || panel.active) {
        stopTitleBlink();
        return;
      }
      blinkOn = !blinkOn;
      try { panel.title = (blinkOn ? '\u26A0 ' : '') + entry.title; } catch (_) {}
    }, 800);
  }
  function stopTitleBlink() {
    if (blinkInterval) { clearInterval(blinkInterval); blinkInterval = null; }
    blinkOn = false;
    try { panel.title = entry.title; } catch (_) {}
  }
  entry._stopBlink = stopTitleBlink;

  // PTY → Webview + activity detection
  let runningDelayTimer = null;
  let dataCount = 0;
  const contextParser = createContextParser();
  let webviewReady = false;
  const outputBuffer = [];
  const initialPty = ptyProcess;

  ptyProcess.onData(data => {
    if (entry.pty !== initialPty) return; // stale handler guard
    dataCount++;
    if (dataCount <= 3) console.log('[Claude Launcher] PTY data #' + dataCount + ' (' + data.length + ' bytes):', data.substring(0, 100));
    if (!webviewReady) {
      outputBuffer.push(data);
    } else {
      try {
        panel.webview.postMessage({ type: 'output', data: data });
      } catch (_) {}
    }

    const usage = contextParser.feed(data, entry);
    if (usage) {
      try { panel.webview.postMessage({ type: 'context-usage', ...usage }); } catch (_) {}
    }

    // v2.6.6: interactive prompt fast-path. Skip the 7-second running
    // threshold when we recognize a "Do you want / [Y/n] / Press Enter"
    // style prompt — the user needs to act NOW, not after the timer.
    if (entry.state !== 'needs-attention' && entry.state !== 'done' && entry.state !== 'error' && looksLikePrompt(data)) {
      if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
      if (runningDelayTimer) { clearTimeout(runningDelayTimer); runningDelayTimer = null; }
      entry.state = 'needs-attention';
      setTabIcon(panel, 'done', extensionPath);
      try { panel.webview.postMessage({ type: 'state', state: 'needs-attention' }); } catch (_) {}
      showDesktopNotification(entry.title);
      if (!panel.active) {
        try { panel.webview.postMessage({ type: 'notify' }); } catch (_) {}
        startTitleBlink();
      }
      updateStatusBar();
      if (state.sessionTreeProvider) state.sessionTreeProvider.refresh();
      return;
    }

    // Only transition to 'running' if output persists for 3s+
    if (entry.state !== 'running' && entry.state !== 'done' && entry.state !== 'error') {
      if (!runningDelayTimer) {
        runningDelayTimer = setTimeout(() => {
          if (entry._disposed) { runningDelayTimer = null; return; }
          if (entry.state !== 'running' && entry.state !== 'done' && entry.state !== 'error') {
            entry.state = 'running';
            entry.runningStartedAt = Date.now();
            setTabIcon(panel, 'running', extensionPath);
            try { panel.webview.postMessage({ type: 'state', state: 'running' }); } catch (_) {}
            updateStatusBar();
          }
          runningDelayTimer = null;
        }, IDLE_DELAY_MS);
      }
    }

    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (runningDelayTimer) { clearTimeout(runningDelayTimer); runningDelayTimer = null; }
      if (!entry.pty || entry.state === 'done' || entry.state === 'error') return;

      // Brief outputs (< 3s, never reached 'running') stay as-is
      if (entry.state !== 'running') return;

      const runningDuration = Date.now() - entry.runningStartedAt;

      if (entry._disposed) return;
      if (runningDuration >= 7000) {
        entry.state = 'needs-attention';
        setTabIcon(panel, 'done', extensionPath);
        try { panel.webview.postMessage({ type: 'state', state: 'needs-attention' }); } catch (_) {}
        showDesktopNotification(entry.title);
        if (!panel.active) {
          try { panel.webview.postMessage({ type: 'notify' }); } catch (_) {}
          startTitleBlink();
        }
      } else {
        entry.state = 'waiting';
        setTabIcon(panel, 'idle', extensionPath);
        try { panel.webview.postMessage({ type: 'state', state: 'waiting' }); } catch (_) {}
      }
      updateStatusBar();
      if (state.sessionTreeProvider) state.sessionTreeProvider.refresh();
    }, IDLE_DELAY_MS);
  });

  // Tab focus → clears needs-attention; saves viewColumn on move
  let lastViewColumn = panel.viewColumn;
  panel.onDidChangeViewState(e => {
    if (entry._disposed) return;
    if (e.webviewPanel.active && entry.state === 'needs-attention') {
      entry.state = 'waiting';
      setTabIcon(panel, 'idle', extensionPath);
      try { panel.webview.postMessage({ type: 'state', state: 'waiting' }); } catch (_) {}
      updateStatusBar();
    }
    if (panel.viewColumn !== lastViewColumn) {
      lastViewColumn = panel.viewColumn;
      saveSessions();
    }
  }, undefined, context.subscriptions);

  // PTY exit
  ptyProcess.onExit(({ exitCode }) => {
    if (entry.pty !== initialPty) return; // stale handler guard
    console.log('[Claude Launcher] PTY exited, code:', exitCode, '| dataCount:', dataCount);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    const isSuccess = exitCode === 0 || exitCode === null || exitCode === undefined;

    if (isSuccess) {
      entry.state = 'done';
    } else {
      entry.state = 'error';
    }

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
      try { panel.webview.postMessage({ type: 'process-exited', exitCode: exitCode, canResume: !!entry.sessionId }); } catch (_) {}
    }
  });

  // Webview → Extension (delegated to messageRouter)
  panel.webview.onDidReceiveMessage(msg => {
    routeWebviewMessage(msg, {
      entry, panel, context, extensionPath,
      createPanel,
      onWebviewReady: () => {
        webviewReady = true;
        console.log('[Claude Launcher] Webview ready, flushing', outputBuffer.length, 'buffered chunks');
        for (const chunk of outputBuffer) {
          try { panel.webview.postMessage({ type: 'output', data: chunk }); } catch (_) {}
        }
        outputBuffer.length = 0;
      },
    });
  }, undefined, context.subscriptions);

  // Panel closed
  panel.onDidDispose(() => {
    entry._disposed = true;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (runningDelayTimer) { clearTimeout(runningDelayTimer); runningDelayTimer = null; }
    stopTitleBlink();
    killPtyProcess(entry.pty);
    // Phase 12: optional multiplexer session cleanup. Killing the pty above
    // only detaches the tmux/psmux client — the server-side session keeps
    // claude alive in the background. The 'kill-on-close' lifecycle kills
    // it explicitly so the user does not accumulate zombie sessions.
    if (entry.backend === 'multiplexer' && entry.muxSessionName) {
      const lifecycle = vscode.workspace
        .getConfiguration('claudeCodeLauncher')
        .get('terminal.multiplexerLifecycle', 'kill-on-close');
      if (lifecycle === 'kill-on-close') {
        const muxBin = process.platform === 'win32' ? 'psmux' : 'tmux';
        try {
          require('child_process').execFile(
            muxBin,
            ['kill-session', '-t', entry.muxSessionName],
            { timeout: 1500 },
            () => {}
          );
        } catch (_) { /* best-effort */ }
      }
    }
    state.panels.delete(tabId);
    if (!state.isDeactivating) {
      saveSessions();
    }
    updateStatusBar();
  }, undefined, context.subscriptions);
}

module.exports = { createPanel };
