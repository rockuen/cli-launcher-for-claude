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
const fs = require('fs');
const crypto = require('crypto');
const chokidar = require('chokidar');
const state = require('../state');
const { t, getTranslations, getLocale } = require('../i18n');
const { saveSessions } = require('../store/sessionManager');
const { resolveClaudeCli, resolveKiroCli, resolveAntigravityCli, resolveCodexCli, resolveGrokCli, resolveGjcCli, resolveChiefCli } = require('../pty/resolveCli');
const { killPtyProcess } = require('../pty/kill');
const { createContextParser } = require('../pty/contextParser');
const { createBackend } = require('../pty/backend');
const { getWebviewContent } = require('./webviewContent');
const { showDesktopNotification } = require('../handlers/desktopNotification');
const { setTabIcon, setStatusBar, updateStatusBar, setIdleIcon, refreshActiveSessionModel } = require('./statusIndicator');
const { routeWebviewMessage } = require('./messageRouter');
const { getSessionJsonlPath, extractAiTitle, extractMessages, listKiroSessions, listCodexSessions, findCodexSessionPath, listGrokSessions, findGrokSessionPath, listGjcSessions, findGjcSessionPath } = require('../lib/sessionJsonl');
const { prepareProjectSessionEnvironment, getKiroSessionsDir, getCodexPaths, getGrokPaths, getGjcPaths } = require('../lib/projectSessions');
const { buildMeta, renderBlocks, renderWelcome, resolveReaderNames } = require('../lib/readerRender');
const { listAgents } = require('../agents/registry');
const { resolveExtraSlashes } = require('../lib/slashRegistry');
const { resolveSessionAgent } = require('../lib/resolveSessionAgent');
const { detectShellRunning } = require('../lib/shellRunningDetect');
const { sendPtyChunkPaced } = require('../lib/ptyChunk');
const { detectPromptAffordance } = require('../lib/promptAffordance');
const { claudeEffortArgs } = require('../lib/claudeEffort');
const { claudeChannelsArgs } = require('../lib/claudeChannels');

const IDLE_DELAY_MS = 3000;

// NOTE (selector removal): the inline y/n prompt-bar and numbered choice-bar
// — plus their byte-stream detectors (detectBinaryPrompt / detectChoicePrompt)
// and the looksLikePrompt fast-path — were removed. They screen-scraped raw
// ANSI to rebuild menus as clickable buttons and mis-fired on plain text. An
// interactive prompt now only fires a desktop NOTIFICATION, detected
// idle-gated via lib/promptAffordance.js (see the idle timer in flushPending).

// Kiro fresh-session id ownership. A new `kiro-cli chat` accepts no session
// id, and the id kiro picks isn't known until it writes the transcript. Each
// fresh kiro panel snapshots the session ids that already existed for its cwd,
// then claims the first NEW id that appears and pins it (entry.sessionId), so
// its reader reads that exact transcript instead of cwd-latest. This module-
// level set stops two fresh panels in the same cwd from claiming one id.
const _claimedKiroIds = new Set();

// Codex fresh-session id ownership — same pattern as kiro. A new `codex` TUI
// accepts no session id; the id codex assigns (the rollout filename's trailing
// UUID) isn't known until it writes the rollout. Each fresh codex panel
// snapshots the ids that already existed for its cwd, then claims the first NEW
// rollout that appears and pins it (entry.sessionId), so its reader reads that
// exact rollout. This set stops two fresh panels in one cwd claiming one id.
const _claimedCodexIds = new Set();

// Grok fresh-session id ownership — same pattern as codex. Grok writes
// sessions under ~/.grok/sessions/<encoded-cwd>/<session-id>/updates.jsonl and
// the id is not known until the CLI creates that directory.
const _claimedGrokIds = new Set();

// gjc fresh-session id ownership — same pattern as codex/grok. A new `gjc`
// names its transcript `<agentDir>/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl`
// only after it starts, so the launcher's placeholder id never matches on disk
// until the panel discovers + pins the new file stem.
const _claimedGjcIds = new Set();

// Split-layout reader watcher: tail the active session's jsonl and broadcast
// rendered blocks to the webview so the in-panel reader stays in sync with
// the TUI. Same polling shape as readerView's startLiveWatch — macOS fsevents
// misses single-file watches under hidden ~/.claude/projects/, polling avoids
// that. Watcher attaches even if the jsonl doesn't exist yet (Claude Code
// creates it on first turn) — chokidar polls and fires `add` when it appears.
function startReaderWatch(entry, panel) {
  if (!entry || !entry.sessionId) return null;
  // Phase 0: agy conversations are SQLite/protobuf, not jsonl — no reader yet.
  if (entry.agent === 'antigravity') return null;
  if (entry.agent !== 'kiro' && !entry.cwd) return null;

  // For kiro: kiro assigns its own session ids — for a fresh session our
  // entry.sessionId is a random placeholder UUID that never matches the file
  // on disk. We watch the whole sessions directory and, on each render tick,
  // resolve THIS panel's own transcript (never cwd-latest — that bled sibling
  // sessions sharing the cwd into the reader; see _claimedKiroIds). For
  // claude: path is fixed for the session lifetime; resolve once.
  if (entry.agent === 'kiro' && entry.isKiroResume && entry.sessionId) {
    // Tree-resume already carries the real id — own it immediately.
    entry._kiroPinned = true;
    _claimedKiroIds.add(entry.sessionId);
  }
  // Session ids that already existed for this cwd BEFORE this fresh panel
  // spawned, so discovery never claims a pre-existing session. Snapshot once.
  const kiroPreIds = (entry.agent === 'kiro' && !entry._kiroPinned)
    ? (entry._kiroPreIds || new Set(listKiroSessions(entry.cwd).map(s => s.sessionId)))
    : null;
  const resolveKiroPath = () => {
    if (!entry._kiroPinned) {
      // The first NEW (post-spawn), unclaimed session for this cwd is ours.
      const fresh = listKiroSessions(entry.cwd)
        .find(s => !kiroPreIds.has(s.sessionId) && !_claimedKiroIds.has(s.sessionId));
      if (!fresh) return null; // kiro hasn't written its transcript yet
      entry.sessionId = fresh.sessionId; // promote placeholder → real id
      entry.isKiroResume = true;         // restartPty now resumes via --resume-id
      entry._kiroPinned = true;
      _claimedKiroIds.add(fresh.sessionId);
      try { saveSessions(); } catch (_) {}
      try { state.refreshSessionTrees(); } catch (_) {}
      console.log('[panel-reader] kiro session pinned:', fresh.sessionId);
    }
    return getSessionJsonlPath(entry.sessionId, entry.cwd, 'kiro');
  };

  // Codex id discovery mirrors kiro. Pin immediately when entry.sessionId is
  // already a REAL rollout id — either a Tree-resume (isCodexResume) OR a
  // restored session (resume --last, NO flag, but its saved sessionId is a real
  // rollout on disk). Without the findCodexSessionPath check a restored session
  // fell into discovery mode and (a) never showed its own reader — its id is
  // already in codexPreIds, so it can't match itself as "new" — and (b)
  // hijacked the NEXT fresh session's rollout as its own. Fresh panels carry a
  // placeholder UUID that findCodexSessionPath can't resolve, so they correctly
  // stay in discovery mode. Mark isCodexResume so restart/save use `resume <id>`.
  if (entry.agent === 'codex' && !entry._codexPinned && entry.sessionId
      && (entry.isCodexResume || findCodexSessionPath(entry.sessionId, null, entry.cwd))) {
    entry._codexPinned = true;
    entry.isCodexResume = true;
    _claimedCodexIds.add(entry.sessionId);
  }
  const codexPreIds = (entry.agent === 'codex' && !entry._codexPinned)
    ? (entry._codexPreIds || new Set(listCodexSessions(entry.cwd).map(s => s.sessionId)))
    : null;
  const resolveCodexPath = () => {
    if (!entry._codexPinned) {
      // The first NEW (post-spawn), unclaimed rollout for this cwd is ours.
      const fresh = listCodexSessions(entry.cwd)
        .find(s => !codexPreIds.has(s.sessionId) && !_claimedCodexIds.has(s.sessionId));
      if (!fresh) return null; // codex hasn't written its rollout yet
      entry.sessionId = fresh.sessionId; // promote placeholder → real id
      entry.isCodexResume = true;        // restartPty now resumes via `resume <id>`
      entry._codexPinned = true;
      _claimedCodexIds.add(fresh.sessionId);
      try { saveSessions(); } catch (_) {}
      try { state.refreshSessionTrees(); } catch (_) {}
      console.log('[panel-reader] codex session pinned:', fresh.sessionId);
    }
    return getSessionJsonlPath(entry.sessionId, entry.cwd, 'codex');
  };

  // Grok id discovery mirrors codex. Tree-resume/restored sessions already
  // carry the real session id; fresh panels carry a placeholder until Grok
  // creates ~/.grok/sessions/<cwd>/<real-id>/updates.jsonl.
  if (entry.agent === 'grok' && !entry._grokPinned && entry.sessionId
      && (entry.isGrokResume || findGrokSessionPath(entry.sessionId, null, entry.cwd))) {
    entry._grokPinned = true;
    entry.isGrokResume = true;
    _claimedGrokIds.add(entry.sessionId);
  }
  const grokPreIds = (entry.agent === 'grok' && !entry._grokPinned)
    ? (entry._grokPreIds || new Set(listGrokSessions(entry.cwd).map(s => s.sessionId)))
    : null;
  const resolveGrokPath = () => {
    if (!entry._grokPinned) {
      const fresh = listGrokSessions(entry.cwd)
        .find(s => !grokPreIds.has(s.sessionId) && !_claimedGrokIds.has(s.sessionId));
      if (!fresh) return null;
      entry.sessionId = fresh.sessionId;
      entry.isGrokResume = true;
      entry._grokPinned = true;
      _claimedGrokIds.add(fresh.sessionId);
      try { saveSessions(); } catch (_) {}
      try { state.refreshSessionTrees(); } catch (_) {}
      console.log('[panel-reader] grok session pinned:', fresh.sessionId);
    }
    return getSessionJsonlPath(entry.sessionId, entry.cwd, 'grok');
  };

  // gjc id discovery mirrors codex/grok. Tree-resume/restored sessions already
  // carry the real file stem; fresh panels carry a placeholder until gjc writes
  // <agentDir>/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl for this cwd.
  if (entry.agent === 'gjc' && !entry._gjcPinned && entry.sessionId
      && (entry.isGjcResume || findGjcSessionPath(entry.sessionId, null, entry.cwd))) {
    entry._gjcPinned = true;
    entry.isGjcResume = true;
    _claimedGjcIds.add(entry.sessionId);
  }
  const gjcPreIds = (entry.agent === 'gjc' && !entry._gjcPinned)
    ? (entry._gjcPreIds || new Set(listGjcSessions(entry.cwd).map(s => s.sessionId)))
    : null;
  const resolveGjcPath = () => {
    if (!entry._gjcPinned) {
      const fresh = listGjcSessions(entry.cwd)
        .find(s => !gjcPreIds.has(s.sessionId) && !_claimedGjcIds.has(s.sessionId));
      if (!fresh) return null; // gjc hasn't written its transcript yet
      entry.sessionId = fresh.sessionId; // promote placeholder → real stem
      entry.isGjcResume = true;          // restartPty now resumes via -r <path>
      entry._gjcPinned = true;
      _claimedGjcIds.add(fresh.sessionId);
      try { saveSessions(); } catch (_) {}
      try { state.refreshSessionTrees(); } catch (_) {}
      console.log('[panel-reader] gjc session pinned:', fresh.sessionId);
    }
    return getSessionJsonlPath(entry.sessionId, entry.cwd, 'gjc');
  };

  const watchTarget = entry.agent === 'kiro'
    ? getKiroSessionsDir(entry.cwd)
    : entry.agent === 'codex'
      // Fresh codex: watch the whole rollout tree to catch the new file appear.
      // Pinned/resume codex: the exact rollout path (cheaper poll, deep tree).
      ? (entry._codexPinned
          ? getSessionJsonlPath(entry.sessionId, entry.cwd, 'codex')
          : getCodexPaths(entry.cwd).sessionsDir)
      : entry.agent === 'grok'
        ? (entry._grokPinned
            ? getSessionJsonlPath(entry.sessionId, entry.cwd, 'grok')
            : getGrokPaths(entry.cwd).sessionsDir)
      : entry.agent === 'gjc'
        // Fresh gjc: watch the whole sessions tree to catch the new file appear.
        // Pinned/resume gjc: the exact jsonl path (cheaper poll).
        ? (entry._gjcPinned
            ? getSessionJsonlPath(entry.sessionId, entry.cwd, 'gjc')
            : getGjcPaths(entry.cwd).sessionsDir)
      : getSessionJsonlPath(entry.sessionId, entry.cwd, entry.agent);
  if (!watchTarget) return null;

  // Dynamic path resolution: kiro / codex / grok / gjc re-evaluate on every
  // render to discover + pin a fresh session id; claude keeps the fixed path
  // (avoids repeated stat/scan on the common hot path).
  const resolvePath = entry.agent === 'kiro' ? resolveKiroPath
    : entry.agent === 'codex' ? resolveCodexPath
    : entry.agent === 'grok' ? resolveGrokPath
    : entry.agent === 'gjc' ? resolveGjcPath
    : () => watchTarget;

  let debounceTimer = null;
  let discoveryTimer = null;
  // v3.5.7: defer renders on hidden panels. renderBlocks() on a multi-MB
  // jsonl produces a multi-MB HTML payload; sending that to a Chromium-
  // throttled webview every poll is one of the biggest contributors to the
  // background-task freeze pattern. Mark pending instead and catch up when
  // the panel becomes active again (handled by panel.onDidChangeViewState).
  let pendingRender = false;
  const render = () => {
    debounceTimer = null;
    if (entry._disposed) return;
    const jsonlPath = resolvePath();
    if ((entry.agent === 'kiro' && entry._kiroPinned) || (entry.agent === 'codex' && entry._codexPinned) || (entry.agent === 'grok' && entry._grokPinned) || (entry.agent === 'gjc' && entry._gjcPinned)) {
      if (discoveryTimer) { clearInterval(discoveryTimer); discoveryTimer = null; }
    }
    if (!jsonlPath || !fs.existsSync(jsonlPath)) return;
    if (!panel.active) { pendingRender = true; return; }
    let messages, aiTitle;
    try {
      aiTitle = extractAiTitle(jsonlPath, entry.agent);
      messages = extractMessages(jsonlPath, entry.agent);
    } catch (e) {
      console.error('[panel-reader] read failed:', e.message);
      return;
    }
    const lastRole = messages.length > 0 ? messages[messages.length - 1].role : null;
    // v3.6.6: cap render to the most recent N messages so long sessions
    // don't grow reader-area DOM unboundedly. Re-read per render so a
    // settings.json edit takes effect without a panel reload.
    const cfg = vscode.workspace.getConfiguration('claudeCodeLauncher');
    const readerCap = cfg.get('readerMessageCap', 200);
    // Per-reader display names re-read each render so a settings edit applies
    // without a panel reload (same pattern as readerCap).
    const readerNames = resolveReaderNames(
      cfg.get('readerNames', {}), entry.agent,
      (listAgents().find((a) => a.id === entry.agent) || {}).label
    );
    try {
      panel.webview.postMessage({
        type: 'reader-update',
        meta: buildMeta(entry, aiTitle, messages),
        blocksHtml: renderBlocks(messages, { cap: readerCap, names: readerNames }),
        lastRole,
      });
    } catch (_) {}
    pendingRender = false;
  };
  // Expose a catch-up trigger so the panel's onDidChangeViewState handler can
  // force a render after the user re-focuses a tab whose reader was paused.
  entry._readerCatchUp = () => { if (pendingRender) render(); };
  const schedule = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(render, 200);
  };

  let watcher = null;
  try {
    watcher = chokidar.watch(watchTarget, {
      persistent: true,
      ignoreInitial: false,
      usePolling: true,
      // v3.5.5: 250 → 1000 ms. Claude Code batch-flushes the jsonl at turn-end
      // rather than streaming chunk-by-chunk (verified empirically: 5 turn
      // flushes, +35/+39/+15/+40/+7 line jumps, zero mid-stream increments),
      // so a 250 ms poll spends most of its budget on unchanged stat() calls.
      // 1 s keeps the reader's "live" feel while cutting OS work per active
      // session 4×. With sessionJsonl's mtime/size cache the file is read at
      // most once per turn even when multiple readers poll the same file.
      interval: 1000,
    });
    watcher.on('add', () => schedule());
    watcher.on('change', () => schedule());
    watcher.on('error', (e) => console.error('[panel-reader] watcher error:', e && e.message));
    console.log('[panel-reader] watching ' + watchTarget);
    if ((entry.agent === 'kiro' && !entry._kiroPinned) || (entry.agent === 'codex' && !entry._codexPinned) || (entry.agent === 'grok' && !entry._grokPinned) || (entry.agent === 'gjc' && !entry._gjcPinned)) {
      discoveryTimer = setInterval(schedule, 1000);
      schedule();
    }
  } catch (e) {
    console.error('[panel-reader] failed to start watch:', e.message);
    return null;
  }

  return () => {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (discoveryTimer) { clearInterval(discoveryTimer); discoveryTimer = null; }
    if (watcher) { try { watcher.close(); } catch (_) {} }
    // Release this panel's kiro id so a later session can reuse it.
    if (entry.agent === 'kiro' && entry._kiroPinned && entry.sessionId) {
      _claimedKiroIds.delete(entry.sessionId);
    }
    // Same for codex.
    if (entry.agent === 'codex' && entry._codexPinned && entry.sessionId) {
      _claimedCodexIds.delete(entry.sessionId);
    }
    if (entry.agent === 'grok' && entry._grokPinned && entry.sessionId) {
      _claimedGrokIds.delete(entry.sessionId);
    }
    if (entry.agent === 'gjc' && entry._gjcPinned && entry.sessionId) {
      _claimedGjcIds.delete(entry.sessionId);
    }
  };
}

function createPanel(context, extensionPath, session, opts) {
  // Validate node-pty loads up front so the friendly nodePtyFail message shows
  // early, before any panel setup. The actual spawn goes through createBackend()
  // (pty/backend.js), which requires node-pty itself (module cache makes this free).
  try {
    require('node-pty');
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
  // Agent resolution: opts.agent (forced) wins; an existing session keeps its
  // OWN agent (never the configured default — see lib/resolveSessionAgent); only
  // a brand-new session falls back to the configured default agent / 'claude'.
  const agent = resolveSessionAgent({
    optsAgent: opts && opts.agent,
    session,
    configuredDefaultAgent: vscode.workspace.getConfiguration('claudeCodeLauncher').get('agent'),
  });
  const agentLabel = (listAgents().find(a => a.id === agent) || {}).label || 'Claude Code';
  const tabTitle = session?.title || (state.tabCounter === 1 ? agentLabel : `${agentLabel} (${state.tabCounter})`);

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

  panel._agent = agent;
  setTabIcon(panel, 'running', extensionPath);
  setStatusBar('running');

  const config = vscode.workspace.getConfiguration('claudeCodeLauncher');
  const fontSize = config.get('defaultFontSize', 11);
  const readerFontSize = config.get('readerFontSize', 12);
  const fontFamily = config.get('defaultFontFamily', '"D2Coding", "D2Coding ligature", Consolas, monospace');
  const defaultTheme = config.get('defaultTheme', 'default');
  const soundEnabled = config.get('soundEnabled', true);
  const particlesEnabled = config.get('particlesEnabled', true);
  const autoEffortMax = config.get('autoEffortMax', false);
  const bypassPermissions = config.get('claude.bypassPermissions', false);
  const repoSyncEnabled = config.get('repoSync.enabled', false);
  const repoSyncPath = config.get('repoSync.path', '');
  // antigravity has no reader yet (transcripts are protobuf-in-SQLite), so the
  // split layout would just show an empty/welcome reader pane — force it off so
  // agy tabs open as a plain terminal. The per-tab 👁 toggle can still flip it.
  //
  // Per-agent reader default: 'splitLayoutDefaultAgents' (list of agents that
  // open with the reader pane). When non-empty it is authoritative — reader on
  // only for listed agents. Empty falls back to the legacy global boolean so
  // existing setups keep working. antigravity is always off (no reader).
  const splitDefaultAgents = config.get('splitLayoutDefaultAgents', []);
  const splitLayoutDefault = agent === 'antigravity'
    ? false
    : (Array.isArray(splitDefaultAgents) && splitDefaultAgents.length > 0
        ? splitDefaultAgents.includes(agent)
        : config.get('splitLayoutDefault', false));
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
  const slashRegistryOpts = {
    includeBuiltinExtras: config.get('slashRegistry.includeBuiltinExtras', true),
    includePkm: config.get('slashRegistry.includePkm', true),
    includeOmc: config.get('slashRegistry.includeOmc', true),
  };
  const extraSlashes = resolveExtraSlashes(getLocale(), slashRegistryOpts, T);
  const terminalMinRows = Math.max(3, Math.min(30, Number(config.get('terminalMinRows', 8)) || 8));
  // Split layout: reader area / terminal ratio is per-user, persisted across
  // reloads. Clamp to [0.15, 0.95] so neither pane ever collapses to zero
  // (xterm fit needs at least a few rows, reader needs at least a header's
  // worth of height). Raised to 0.95 to support very narrow terminal (useful
  // for Grok reader view and long reading sessions). Default 0.85 = reader
  // takes most of the space. Grok forces at least 0.90 on first open.
  const splitRatioRaw = context.globalState.get('claudeCodeLauncher.splitRatio', 0.85);
  let splitRatio = Math.max(0.15, Math.min(0.95, Number(splitRatioRaw) || 0.85));
  // Grok panels start with a narrower terminal (higher reader ratio) because
  // the full-screen TUI + reader makes the live terminal area feel too large by default.
  if (agent === 'grok') {
    splitRatio = Math.max(splitRatio, 0.90);
  }
  // settings carries splitRatio so the in-panel settings modal slider can
  // read its initial value and re-sync when the user reopens the modal
  // after a drag/keyboard adjustment.
  const settings = { fontFamily, defaultTheme, soundEnabled, particlesEnabled, autoEffortMax, repoSyncEnabled, repoSyncPath, splitLayoutDefault, readerFontSize, terminalMinRows, fileAssociations, pasteToFileThreshold, pasteTableAsMarkdown, defaultBackend, multiplexerLifecycle, splitRatio };
  panel.webview.html = getWebviewContent(xtermCssUri, xtermJsUri, fitAddonUri, webLinksAddonUri, searchAddonUri, isDark, fontSize, tabTitle, initialMemo, customButtons, T, settings, customSlashCommands, splitRatio, renderWelcome(), splitLayoutDefault, extraSlashes, agent);

  // Spawn CLI — agent-aware (PoC: 'claude' default, 'kiro' opt-in via settings)
  // opts.agent takes priority so handoff can force the opposite backend.
  // (agent is already resolved above for tabTitle — reused here)
  const cwd = session?.cwd || vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || os.homedir();
  const sessionId = session?.sessionId || crypto.randomUUID();
  // Fresh Kiro/Codex/Grok sessions assign their real ids only after the CLI starts.
  // Snapshot existing ids BEFORE spawn so a very fast first write cannot be
  // mistaken for a pre-existing session and leave the reader unpinned forever.
  const kiroPreSessionIds = (agent === 'kiro' && !session?.isKiroResume)
    ? new Set(listKiroSessions(cwd).map(s => s.sessionId))
    : null;
  const codexPreSessionIds = (agent === 'codex' && !session?.isCodexResume && !findCodexSessionPath(session?.sessionId, null, cwd))
    ? new Set(listCodexSessions(cwd).map(s => s.sessionId))
    : null;
  const grokPreSessionIds = (agent === 'grok' && !session?.isGrokResume && !findGrokSessionPath(session?.sessionId, null, cwd))
    ? new Set(listGrokSessions(cwd).map(s => s.sessionId))
    : null;
  const gjcPreSessionIds = (agent === 'gjc' && !session?.isGjcResume && !findGjcSessionPath(session?.sessionId, null, cwd))
    ? new Set(listGjcSessions(cwd).map(s => s.sessionId))
    : null;

  let shell, args, extraEnv = {};
  if (agent === 'kiro') {
    const resolvedKiro = resolveKiroCli();
    if (!resolvedKiro) {
      const install = 'Install Kiro CLI';
      vscode.window.showErrorMessage(
        'Kiro CLI (kiro-cli) not found. Please install it first.',
        install
      ).then(choice => {
        if (choice === install) {
          vscode.env.openExternal(vscode.Uri.parse('https://kiro.dev/docs/cli/installation/'));
        }
      });
      panel.dispose();
      return;
    }
    shell = resolvedKiro.shell;
    // kiro-cli chat args, by precedence:
    //   - isKiroResume (Tree resume; sessionId is the REAL kiro id on disk) →
    //     ['chat', '--resume-id', <id>] for an exact directory-scoped resume.
    //   - sessionId without isKiroResume (auto-restore; our random UUID never
    //     matches kiro's id) → ['chat', '--resume'] (kiro resumes cwd-latest).
    //   - neither → ['chat'] (fresh session).
    // Note: --effort/autoEffortMax is Claude-only — never passed to kiro.
    const kiroArgs = session?.isKiroResume
      ? ['chat', '--resume-id', session.sessionId]
      : (session?.sessionId ? ['chat', '--resume'] : ['chat']);
    // --trust-all-tools (opt-in via claudeCodeLauncher.kiro.trustAllTools): let
    // Kiro use any tool without per-call confirmation. Appended after the chat
    // subcommand/resume flags (flag order is not significant to kiro-cli).
    if (vscode.workspace.getConfiguration('claudeCodeLauncher').get('kiro.trustAllTools', false)) {
      kiroArgs.push('--trust-all-tools');
    }
    args = [...resolvedKiro.args, ...kiroArgs];
  } else if (agent === 'antigravity') {
    const resolvedAgy = resolveAntigravityCli();
    if (!resolvedAgy) {
      const install = 'Install Antigravity CLI';
      vscode.window.showErrorMessage(
        'Antigravity CLI (agy) not found. Please install it first.',
        install
      ).then(choice => {
        if (choice === install) {
          vscode.env.openExternal(vscode.Uri.parse('https://antigravity.google/docs/cli-getting-started'));
        }
      });
      panel.dispose();
      return;
    }
    shell = resolvedAgy.shell;
    // agy args by precedence (agy assigns its own conversation id, like kiro):
    //   - isAntigravityResume (Tree resume; sessionId is a REAL agy conversation
    //     id on disk) → ['--conversation', <id>] for an exact resume.
    //   - sessionId without the flag (auto-restore; our random UUID is never an
    //     agy id) → ['--continue'] (resume the most recent conversation).
    //   - neither → [] (fresh session).
    const agyArgs = session?.isAntigravityResume
      ? ['--conversation', session.sessionId]
      : (session?.sessionId ? ['--continue'] : []);
    // --dangerously-skip-permissions (opt-in via antigravity.trustAllTools):
    // auto-approve all tool permission requests without prompting.
    if (config.get('antigravity.trustAllTools', false)) {
      agyArgs.push('--dangerously-skip-permissions');
    }
    args = [...resolvedAgy.args, ...agyArgs];
  } else if (agent === 'codex') {
    const resolvedCodex = resolveCodexCli();
    if (!resolvedCodex) {
      const install = 'Install Codex CLI';
      vscode.window.showErrorMessage(
        'Codex CLI (codex) not found. Please install it first.',
        install
      ).then(choice => {
        if (choice === install) {
          vscode.env.openExternal(vscode.Uri.parse('https://developers.openai.com/codex/cli'));
        }
      });
      panel.dispose();
      return;
    }
    shell = resolvedCodex.shell;
    extraEnv = resolvedCodex.env || {};
    // codex args by precedence (codex assigns its own session ids — the
    // rollout filename's trailing UUID — like kiro/agy):
    //   - isCodexResume (Tree resume; sessionId is a REAL rollout UUID on
    //     disk) → ['resume', <id>] for an exact resume.
    //   - sessionId without the flag (auto-restore; our random UUID is never
    //     a codex id) → ['resume', '--last'] (most recent session, no picker).
    //   - neither → [] (fresh TUI session).
    // Resume the EXACT session when sessionId is a real rollout on disk — a
    // Tree-resume (isCodexResume) or a restored session whose saved id resolves.
    // `resume --last` is only a fallback for a not-yet-pinned placeholder id, so
    // the spawned codex matches what the reader pins to (no session/reader skew).
    const codexArgs = (session?.isCodexResume || (session?.sessionId && findCodexSessionPath(session.sessionId, null, cwd)))
      ? ['resume', session.sessionId]
      : (session?.sessionId ? ['resume', '--last'] : []);
    // --dangerously-bypass-approvals-and-sandbox (opt-in via codex.trustAllTools):
    // skip ALL confirmation prompts + run commands without sandboxing. This is
    // codex's equivalent of kiro --trust-all-tools / agy --dangerously-skip-
    // permissions. Accepted as a global flag after the `resume` subcommand too
    // (verified in `codex resume --help`), so a single push covers fresh +
    // resume. EXTREMELY DANGEROUS — off by default.
    if (config.get('codex.trustAllTools', false)) {
      codexArgs.push('--dangerously-bypass-approvals-and-sandbox');
    }
    args = [...resolvedCodex.args, ...codexArgs];
  } else if (agent === 'grok') {
    const resolvedGrok = resolveGrokCli();
    if (!resolvedGrok) {
      const install = 'Install Grok CLI';
      vscode.window.showErrorMessage(
        'Grok CLI (grok) not found. Please install xAI Grok CLI first.',
        install
      ).then(choice => {
        if (choice === install) {
          vscode.env.openExternal(vscode.Uri.parse('https://docs.x.ai'));
        }
      });
      panel.dispose();
      return;
    }
    shell = resolvedGrok.shell;
    // grok args by precedence:
    //   - isGrokResume or saved real id → ['--resume', <id>] exact resume.
    //   - placeholder id from auto-restore → ['--resume'] cwd-latest fallback.
    //   - no session id → [] fresh TUI session.
    const grokArgs = (session?.isGrokResume || (session?.sessionId && findGrokSessionPath(session.sessionId, null, cwd)))
      ? ['--resume', session.sessionId]
      : (session?.sessionId ? ['--resume'] : []);
    // --always-approve (opt-in via grok.trustAllTools): approve tool calls
    // without prompting. Off by default, same risk posture as other agents.
    if (config.get('grok.trustAllTools', false)) {
      grokArgs.push('--always-approve');
    }
    args = [...resolvedGrok.args, ...grokArgs];
  } else if (agent === 'gjc') {
    const resolvedGjc = resolveGjcCli();
    if (!resolvedGjc) {
      const install = 'Install Gajae Code (gjc)';
      vscode.window.showErrorMessage(
        'Gajae Code CLI (gjc) not found. Install with: bun add -g gajae-code (requires Bun ≥ 1.3.14).',
        install
      ).then(choice => {
        if (choice === install) {
          vscode.env.openExternal(vscode.Uri.parse('https://gaebal-gajae.dev'));
        }
      });
      panel.dispose();
      return;
    }
    shell = resolvedGjc.shell;
    // gjc assigns its own session ids (the file stem `<ts>_<uuid>`), like
    // kiro/codex/grok:
    //   - isGjcResume (Tree resume) OR a saved id that resolves to a jsonl on
    //     disk → resume that EXACT session by PATH (`gjc -r <path>`; gjc opens a
    //     path directly, bypassing id-resolution + the cross-project fork
    //     prompt the bare-id path triggers).
    //   - sessionId without a resolvable path (placeholder from auto-restore) →
    //     `gjc -c` (continue the cwd's most recent session).
    //   - neither → [] (fresh TUI session).
    const gjcResumePath = (session?.isGjcResume || (session?.sessionId && findGjcSessionPath(session.sessionId, null, cwd)))
      ? findGjcSessionPath(session.sessionId, null, cwd)
      : null;
    const gjcArgs = gjcResumePath ? ['-r', gjcResumePath]
      : (session?.sessionId ? ['-c'] : []);
    // Model + thinking (effort) come from gjc-specific settings only on a FRESH
    // session — a resume/continue restores the session's own model, so forcing
    // --model would override the user's in-session choice. gjc is multi-model:
    // the fuzzy --model string (e.g. "opus", "gpt-5.2-codex", "gemini-3-pro",
    // "grok-code-fast-1") routes to whichever OAuth subscription is logged in.
    // --thinking is gjc's effort knob (ultra|high|medium|low); Claude's
    // --effort/autoEffortMax is NEVER passed to gjc.
    if (!session?.sessionId) {
      const gjcModel = (config.get('gjc.model', '') || '').trim();
      if (gjcModel) gjcArgs.push('--model', gjcModel);
      const gjcThinking = (config.get('gjc.thinking', '') || '').trim();
      if (gjcThinking) gjcArgs.push('--thinking', gjcThinking);
    }
    args = [...resolvedGjc.args, ...gjcArgs];
  } else if (agent === 'chief') {
    const resolvedChief = resolveChiefCli();
    if (!resolvedChief) {
      vscode.window.showErrorMessage(
        'Chief launcher wrapper is missing from this extension install. Reinstall CLI Launcher for Claude.'
      );
      panel.dispose();
      return;
    }
    shell = resolvedChief.shell;
    extraEnv = resolvedChief.env || {};
    // chief-repl is launcher-owned like Claude Code: fresh sessions receive
    // --session-id <launcher-id>, and resumes receive --resume <same id>.
    const chiefArgs = session?.sessionId
      ? ['--resume', session.sessionId]
      : ['--session-id', sessionId];
    args = [...resolvedChief.args, ...chiefArgs, '--cwd', cwd];
  } else {
    // agent === 'claude' (default) — original logic, byte-for-byte preserved
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
    shell = resolved.shell;
    const claudeArgs = session?.sessionId
      ? ['--resume', session.sessionId]
      : ['--session-id', sessionId];
    args = [...resolved.args, ...claudeArgs, ...claudeEffortArgs(config), ...claudeChannelsArgs(config), ...(bypassPermissions ? ['--dangerously-skip-permissions'] : [])];
  }

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
  console.log('[Claude Launcher] resolved shell:', shell, '| agent:', agent, '| args:', args);
  const sessionEnv = { ...prepareProjectSessionEnvironment(agent, cwd, process.env), ...extraEnv };

  let ptyProcess;
  try {
    ptyProcess = createBackend({
      kind: 'pty',
      spawnBin,
      spawnArgs,
      cwd: cwd,
      cols: 120,
      rows: 30,
      muxSessionName,
      env: sessionEnv,
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
    // v3.6.4: tabId on the entry object so messageRouter + diagnostics can
    // route per-panel without a closure dependency. v3.6.2/v3.6.3 read
    // entry.tabId which was undefined, collapsing every panel's stats into
    // a single "panel undefined" bucket in the diagnostics dump.
    tabId: tabId,
    pty: ptyProcess,
    title: tabTitle,
    memo: session?.memo || '',
    cwd: cwd,
    sessionId: sessionId,
    agent: agent,
    // v: kiro Tree-resume flag. When true, sessionId is the real kiro id on
    // disk, so restartPty resumes via --resume-id instead of cwd-latest.
    isKiroResume: !!(session && session.isKiroResume),
    // antigravity Tree-resume flag. When true, sessionId is a real agy
    // conversation id, so createPanel/restartPty resume via `--conversation
    // <id>` instead of `--continue` (cwd-latest).
    isAntigravityResume: !!(session && session.isAntigravityResume),
    // codex Tree-resume flag. When true, sessionId is a real codex rollout
    // UUID, so createPanel/restartPty resume via `resume <id>` instead of
    // `resume --last` — and the reader can resolve the exact rollout jsonl.
    isCodexResume: !!(session && session.isCodexResume),
    // grok Tree-resume flag. When true, sessionId is a real grok session id,
    // so createPanel/restartPty resume via `--resume <id>` instead of cwd-latest.
    isGrokResume: !!(session && session.isGrokResume),
    // gjc Tree-resume flag. When true, sessionId is a real gjc file stem, so
    // createPanel/restartPty resume via `gjc -r <path>` and the reader resolves
    // the exact jsonl.
    isGjcResume: !!(session && session.isGjcResume),
    // chief-repl uses launcher-owned ids, so every saved Chief tab can resume
    // the exact transcript/chat with --resume <sessionId>.
    isChiefResume: !!(session && session.isChiefResume),
    _kiroPreIds: kiroPreSessionIds,
    _codexPreIds: codexPreSessionIds,
    _grokPreIds: grokPreSessionIds,
    _gjcPreIds: gjcPreSessionIds,
    state: 'running',
    idleTimer: null,
    backend: backend,
    muxSessionName: muxSessionName
  };
  state.panels.set(tabId, entry);
  // Defensive: a throw in saveSessions / startReaderWatch must NOT abort panel
  // setup — the PTY data/exit handlers are wired up further down, so an
  // exception here would leave the terminal spawned but with no output piped to
  // the webview ("cursor blinking, nothing renders"). Log + continue instead.
  try { saveSessions(); } catch (e) {
    console.error('[Claude Launcher] saveSessions failed (non-fatal):', (e && e.stack) || e);
  }

  try {
    entry._stopReaderWatch = startReaderWatch(entry, panel);
  } catch (e) {
    console.error('[Claude Launcher] startReaderWatch failed (non-fatal):', (e && e.stack) || e);
    entry._stopReaderWatch = null;
  }

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
  // v3.5.7: track buffered bytes for inactive-panel gating. Chromium throttles
  // hidden webview tabs (rAF 1Hz, setTimeout slowdown), so postMessage payloads
  // queue up faster than the webview can consume them. After hours of background
  // long-running tasks across multiple sessions, the queue accumulates into
  // hundreds of MB, eventually OOM'ing the extension host or the whole window.
  // We hold the data extension-side instead, with a hard cap so our own buffer
  // can't OOM us either. On visibility return we batch-flush through the PTY
  // chunk pacer so the catch-up doesn't re-trigger the v3.5.5 freeze condition.
  let bufferedBytes = 0;
  const OUTPUT_BUFFER_CAP = 1024 * 1024; // 1 MB — long background tasks past this drop earliest chunks
  const initialPty = ptyProcess;

  // v3.6.4: small-chunk coalescing on the active path. Diagnostics dumps
  // showed 92% of PTY chunks ≤64B during Ink redraw storms (cursor blink,
  // spinner, SelectInput partial redraws) — every one fired a separate
  // postMessage + xterm.write, saturating the webview's main thread and
  // driving the single-panel freezes the user reported. We collect tiny
  // chunks across a 32ms window and ship them as one payload; the window
  // is two 60fps frames so input latency stays imperceptible (well below
  // the 100ms perception threshold, and Windows ConPTY itself contributes
  // ~20–30ms baseline latency). Large chunks (≥ SMALL_CHUNK) flush
  // immediately so big transitions (table dumps, session resume) still
  // pace through sendPtyChunkPaced. Inactive panels still go through
  // outputBuffer above — coalescing only applies once the webview is
  // back to receiving traffic live.
  //
  // v3.6.8: window widened 8 → 32ms. v3.6.7 diagnostics dumps showed
  // panel 3's inter-arrival histogram with the 9–32ms bucket holding
  // ~80% of chunks (e.g. 4643/8974 in one 10-min window). With the old
  // 8ms window almost every one of those chunks landed alone, so
  // coalescing did nothing for the dominant cadence — Ink redraws,
  // spinner ticks, and cursor blinks all sit in 9–32ms. 32ms captures
  // them, dropping flush invocations on a busy panel from ~10–15/sec to
  // ~1/sec (a ~14× reduction) and giving the ext-host main thread real
  // headroom during OS-level contention windows (e.g. concurrent
  // Playwright / OneDrive sync activity from sister automations).
  const { SMALL_CHUNK } = require('../lib/ptyChunk');
  const COALESCE_WINDOW_MS = 32;
  let pendingPayload = '';
  let pendingFlushTimer = null;

  // v3.6.5: parsing also coalesces on the same window. Previously
  // contextParser / detectShellRunning / detectBinaryPrompt / looksLikePrompt
  // ran on every raw PTY chunk, which during Ink redraw storms (cursor
  // blink, spinner partial redraws) translated to 125+ parser invocations
  // per second × 4 parsers × per-call string allocation. The cumulative
  // string heap pressure produced an hour-scale ext-host RSS spike pattern
  // (200MB → 1GB → GC pause → 200MB) — diagnostics dumps showed the spike
  // dumps' setInterval landing 7–60s late, which is direct evidence of a
  // main-thread block. The same parser calls on a coalesced payload give
  // identical results (contextParser is incremental via its 300-char
  // rolling buffer; the other three become MORE accurate because their
  // tail-window regex no longer split across chunk boundaries). With the
  // v3.6.8 32ms window the parser invocation rate drops further to
  // ≤30/sec/panel (was ≤8/sec at the 8ms window — but the 8ms window
  // hardly captured the dominant 9–32ms cadence so most chunks still
  // triggered their own parser run; 32ms makes the coalescing actually
  // bite).
  function flushPending() {
    if (pendingFlushTimer) { clearTimeout(pendingFlushTimer); pendingFlushTimer = null; }
    if (!pendingPayload || entry._disposed) { pendingPayload = ''; return; }
    const payload = pendingPayload;
    pendingPayload = '';

    // ---- parsing (moved out of onData per v3.6.5) ----
    const usage = contextParser.feed(payload, entry);
    if (usage) {
      try { panel.webview.postMessage({ type: 'context-usage', ...usage }); } catch (_) {}
    }

    // v3.5.2: track Claude Code's "N shells still running" hint so the tab
    // dot can paint blue when only a background shell is keeping the
    // session warm. Stays a tab-icon-only signal — entry.state and the
    // status bar are unchanged.
    const bgShells = detectShellRunning(payload);
    if (bgShells != null) {
      entry._bgShells = bgShells;
      entry._bgShellsAt = Date.now();
    }

    // Maintain a small rolling tail of recent output so the idle-gated
    // prompt-affordance check (below, in the idle timer) can see Claude's
    // current interactive footer. Raw bytes — detectPromptAffordance strips
    // ANSI itself. Capped to ~the latest screen, not the whole history.
    entry._recentTail = ((entry._recentTail || '') + payload).slice(-6000);

    // Running/idle state machine + idle-gated prompt notification. The old
    // looksLikePrompt fast-path (matched raw bytes mid-stream, false-positive
    // prone) was removed with the inline selectors. The "Claude is waiting for
    // you" signal now comes from detectPromptAffordance run only when output
    // has SETTLED (in the idle timer below).

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
      if (entry._disposed || !entry.pty || entry.state === 'done' || entry.state === 'error') return;

      // Idle-gated interactive-prompt notification. Output has settled; if the
      // screen shows a prompt waiting on the user (a /model-style menu, a
      // trust/permission prompt, or y/n), escalate to needs-attention +
      // desktop notification REGARDLESS of how long Claude ran — these often
      // appear in <3s, below the running threshold, which is exactly why they
      // never used to notify. Deduped on the affordance marker so menu
      // navigation redraws don't re-fire. Works on background tabs too: this
      // runs ext-side, where output is parsed even when the panel is hidden.
      const affordance = detectPromptAffordance(entry._recentTail || '');
      if (affordance) {
        const sig = affordance.kind + '|' + affordance.marker;
        const isNewPrompt = entry._promptSig !== sig;
        entry._promptSig = sig;
        // Always (re)assert needs-attention while an unanswered prompt is on
        // screen — idempotent. A menu-navigation redraw can briefly flip the
        // tab back to 'running' (the running-delay timer re-arms in this state);
        // re-asserting here corrects that instead of leaving the attention lost.
        if (entry.state !== 'needs-attention') {
          entry.state = 'needs-attention';
          setTabIcon(panel, 'done', extensionPath);
          try { panel.webview.postMessage({ type: 'state', state: 'needs-attention' }); } catch (_) {}
          updateStatusBar();
          state.refreshSessionTrees();
        }
        // Desktop notification only for a genuinely NEW prompt (dedup on the
        // marker) so navigation redraws don't spam. Fires on background tabs too.
        if (isNewPrompt) {
          showDesktopNotification(entry.title);
          if (!panel.active) {
            try { panel.webview.postMessage({ type: 'notify' }); } catch (_) {}
            startTitleBlink();
          }
          // Reader/split view: auto-grow the bottom terminal pane so the menu is
          // visible and answerable without dragging the splitter. The webview
          // no-ops when split is off or the terminal is already large, and
          // restores the user's ratio when the prompt clears (below).
          try { panel.webview.postMessage({ type: 'prompt-terminal-expand' }); } catch (_) {}
        }
        return;
      }
      if (entry._promptSig) {
        // A prompt just cleared (answered / dismissed) → restore the terminal
        // pane to the user's ratio (no-op if it was never auto-expanded).
        try { panel.webview.postMessage({ type: 'prompt-terminal-restore' }); } catch (_) {}
      }
      entry._promptSig = null; // no prompt on screen → let the next one re-notify

      // Brief outputs (< 3s, never reached 'running') stay as-is
      if (entry.state !== 'running') return;
      const runningDuration = Date.now() - entry.runningStartedAt;
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
        setIdleIcon(panel, entry, extensionPath);
        try { panel.webview.postMessage({ type: 'state', state: 'waiting' }); } catch (_) {}
      }
      updateStatusBar();
      state.refreshSessionTrees();
    }, IDLE_DELAY_MS);

    // postMessage only when active. Inactive panels' chunks are mirrored
    // into `outputBuffer` (see onData below) and shipped on visibility
    // return through onDidChangeViewState; the parsing above already ran
    // so contextParser stays current and prompt detection still fires
    // even when the user is on another tab.
    if (webviewReady && panel.active) {
      sendPtyChunkPaced(panel, payload, entry);
    }
  }

  entry._ptyDataSub = ptyProcess.onData(data => {
    if (entry._disposed || entry.pty !== initialPty) return; // disposed/stale handler guard
    dataCount++;
    if (dataCount <= 3) console.log('[Claude Launcher] PTY data #' + dataCount + ' (' + data.length + ' bytes):', data.substring(0, 100));
    // v3.6.2: opt-in diagnostics. Null-check beats optional chaining for a
    // hot path called per PTY chunk; the branch predicts well when the
    // toggle is off (the common case).
    if (state.diagnostics) state.diagnostics.recordChunk(entry.tabId, data.length);

    // v3.5.7: inactive panels still buffer chunks so Chromium-throttled
    // webviews don't accumulate IPC payloads. The cap drops oldest entries;
    // xterm scrollback is authoritative for visual continuity post-flush.
    if (!webviewReady || !panel.active) {
      outputBuffer.push(data);
      bufferedBytes += data.length;
      while (bufferedBytes > OUTPUT_BUFFER_CAP && outputBuffer.length > 1) {
        const removed = outputBuffer.shift();
        bufferedBytes -= removed.length;
      }
    }

    // v3.6.5: parsing + postMessage both coalesce on an 8ms window. The
    // onData hot path now does only: stale-guard, diagnostics counter,
    // outputBuffer push (inactive), pending-payload append. flushPending
    // runs parsing once per window (active and inactive alike — parsing
    // stays current in the background so needs-attention notifications
    // still fire on hidden tabs) and only the postMessage path branches
    // on panel.active.
    pendingPayload += data;
    if (pendingPayload.length >= SMALL_CHUNK) {
      flushPending();
    } else if (!pendingFlushTimer) {
      pendingFlushTimer = setTimeout(flushPending, COALESCE_WINDOW_MS);
    }
  });

  // Tab focus → clears needs-attention; saves viewColumn on move; flushes
  // any PTY output buffered while the panel was inactive (v3.5.7).
  let lastViewColumn = panel.viewColumn;
  panel.onDidChangeViewState(e => {
    if (entry._disposed) return;
    // v3.14: track the focused panel so the usage status bar can show THIS
    // session's model. Recompute on every focus gain (cheap; reads the
    // transcript tail) so switching tabs updates the bottom bar.
    if (e.webviewPanel.active) {
      state.activeTabId = tabId;
      try { refreshActiveSessionModel(); } catch (_) {}
    }
    if (e.webviewPanel.active && entry.state === 'needs-attention') {
      entry.state = 'waiting';
      setIdleIcon(panel, entry, extensionPath);
      try { panel.webview.postMessage({ type: 'state', state: 'waiting' }); } catch (_) {}
      updateStatusBar();
      // Re-arm the prompt notification: if the user glances at this tab (which
      // clears needs-attention) then leaves while the SAME prompt is still
      // unanswered, dropping the dedup sig lets the idle check notify again.
      entry._promptSig = null;
    }
    // v3.5.7: visibility return → flush buffered PTY output through the pacer
    // so the webview catches up smoothly instead of being hit with one huge
    // postMessage burst (which is what re-introduced the v3.5.5 freeze on
    // initial buffer drains during webview ready).
    if (e.webviewPanel.active && webviewReady && outputBuffer.length > 0) {
      const drained = outputBuffer.splice(0, outputBuffer.length);
      bufferedBytes = 0;
      for (const chunk of drained) {
        sendPtyChunkPaced(panel, chunk, entry);
      }
      // v3.5.7: reader is paused on hidden panels too; trigger a catch-up
      // render so the in-pane transcript reflects all the turns that fired
      // while the user was looking at another tab.
      if (typeof entry._readerCatchUp === 'function') {
        try { entry._readerCatchUp(); } catch (_) {}
      }
    }
    if (panel.viewColumn !== lastViewColumn) {
      lastViewColumn = panel.viewColumn;
      saveSessions();
    }
  }, undefined, context.subscriptions);

  // v3.5.7: PTY heartbeat. Some patterns (OS sleep/wake, ConPTY pipe broken,
  // child process zombied without emitting exit) leave the launcher's entry
  // stuck in 'running' state forever — user types, but the dead child never
  // reads it; PTY data never comes back. The classic symptom user reported:
  // "closing the tab and resuming the session unblocks it." We probe the
  // child pid with `kill(pid, 0)` (no signal sent, just an aliveness check)
  // every 5 minutes. If the pid is gone, we transition to a stuck UI state
  // and prefix the tab title with ⚠ so the user knows to restart instead of
  // waiting indefinitely. Slow cadence is deliberate — the goal is recovery
  // hint after long idle, not real-time process supervision.
  const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
  entry._heartbeat = setInterval(() => {
    if (entry._disposed || entry.pty !== initialPty) return;
    const pid = ptyProcess && ptyProcess.pid;
    if (!pid) return;
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (e) {
      alive = e && e.code === 'EPERM'; // EPERM means the process exists but we can't signal — still alive
    }
    if (!alive && entry.state !== 'done' && entry.state !== 'error' && entry.state !== 'stuck') {
      entry.state = 'stuck';
      try { panel.title = '⚠ ' + entry.title; } catch (_) {}
      try { panel.webview.postMessage({ type: 'state', state: 'stuck' }); } catch (_) {}
      setTabIcon(panel, 'error', extensionPath);
      updateStatusBar();
      state.refreshSessionTrees();
      console.warn('[Claude Launcher] heartbeat: PTY child', pid, 'is gone but onExit never fired — marking stuck');
    }
  }, HEARTBEAT_INTERVAL_MS);

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
    entry._recentTail = '';  // drop the rolling output tail so a stale prompt
    entry._promptSig = null; // footer can't trigger a notification after exit
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
          sendPtyChunkPaced(panel, chunk, entry);
        }
        outputBuffer.length = 0;
      },
    });
  }, undefined, context.subscriptions);

  // Panel closed
  panel.onDidDispose(() => {
    entry._disposed = true;
    // Detach the PTY data listener BEFORE the kill below: killing a ConPTY
    // flushes its remaining buffered output, and on a disposed panel the
    // `panel.active` getter in onData throws on every late chunk.
    if (entry._ptyDataSub) {
      try { entry._ptyDataSub.dispose(); } catch (_) {}
      entry._ptyDataSub = null;
    }
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (runningDelayTimer) { clearTimeout(runningDelayTimer); runningDelayTimer = null; }
    // v3.6.4: drop any coalesced bytes that never got flushed.
    if (pendingFlushTimer) { clearTimeout(pendingFlushTimer); pendingFlushTimer = null; }
    pendingPayload = '';
    if (entry._bgShellsTimer) { clearTimeout(entry._bgShellsTimer); entry._bgShellsTimer = null; }
    if (entry._heartbeat) { clearInterval(entry._heartbeat); entry._heartbeat = null; }
    entry._readerCatchUp = null;
    if (typeof entry._stopReaderWatch === 'function') {
      try { entry._stopReaderWatch(); } catch (_) {}
      entry._stopReaderWatch = null;
    }
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
    // v3.14: if the closed tab was the focused one, drop the active-model
    // pointer so the usage status bar stops showing a stale session model.
    if (state.activeTabId === tabId) {
      state.activeTabId = null;
      try { refreshActiveSessionModel(); } catch (_) {}
    }
    // v3.6.2: drop this tab's diagnostics counters so closed-and-reopened
    // tabs don't leak entries in the rolling-stats map.
    if (state.diagnostics) state.diagnostics.removePanel(tabId);
    if (!state.isDeactivating) {
      saveSessions();
    }
    updateStatusBar();
  }, undefined, context.subscriptions);
}

module.exports = { createPanel };
