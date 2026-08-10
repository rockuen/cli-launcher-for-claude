// @module panel/readerView — read-only markdown viewer for the active session.
//
// Reads ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl directly (no PTY
// stripping — assistant text blocks are already clean markdown). One shared
// panel: subsequent calls re-render in place rather than opening new tabs.
//
// Theme: per-user choice (dark default), persisted to ExtensionContext
// globalState. Toggle button in the panel flips the choice and posts back
// to the extension so the next open keeps the same theme.
//
// Save: serialises current user/assistant turns to a single markdown file
// via showSaveDialog. The default folder is the workspace root, and the
// default filename embeds session id + timestamp.

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const chokidar = require('chokidar');
const { writePtyChunked } = require('../pty/write');
const { writeSubmitInput } = require('../pty/submitInput');
const {
  getSessionJsonlPath,
  extractAiTitle,
  extractMessages,
} = require('../lib/sessionJsonl');
const {
  escapeHtml,
  formatStamp,
  buildMeta,
  renderBlocks,
  resolveReaderNames,
} = require('../lib/readerRender');
const { listAgents } = require('../agents/registry');
const { t } = require('../i18n');

const THEME_KEY = 'claudeCodeLauncher.readerTheme';
const DEFAULT_THEME = 'dark';
const LIVE_DEBOUNCE_MS = 200;

// Resolve { user, assistant } reader display names for an agent (global user
// name + per-agent AI name; see readerRender.resolveReaderNames).
function _readerNamesFor(agent) {
  return resolveReaderNames(
    vscode.workspace.getConfiguration('claudeCodeLauncher').get('readerNames', {}),
    agent,
    (listAgents().find((a) => a.id === agent) || {}).label
  );
}

let activePanel = null;
let _context = null;
let currentEntry = null;
let currentMessages = [];
let currentAiTitle = null;
let currentFilePath = null;
let liveWatcher = null;
let liveDebounceTimer = null;

function getTheme() {
  if (!_context) return DEFAULT_THEME;
  const t = _context.globalState.get(THEME_KEY, DEFAULT_THEME);
  return (t === 'light' || t === 'dark') ? t : DEFAULT_THEME;
}

function setTheme(theme) {
  if (!_context) return;
  if (theme !== 'dark' && theme !== 'light') return;
  _context.globalState.update(THEME_KEY, theme);
}

// Live watch: chokidar tails the active session jsonl. Claude Code flushes
// each turn as a single batch (verified empirically — no chunk-level streaming),
// so a single change → debounce → re-extract → postMessage pattern is enough.
function startLiveWatch(filePath) {
  stopLiveWatch();
  currentFilePath = filePath;
  try {
    // macOS fsevents misses single-file watches under hidden paths
    // (~/.claude/projects/...), so we poll. v3.5.5: 200 → 1000 ms. Claude
    // Code batch-flushes the jsonl at turn-end (not chunk-by-chunk), so
    // polling faster than that only adds stat() noise. With sessionJsonl's
    // mtime/size cache the post-change re-extract is one parse, not two.
    liveWatcher = chokidar.watch(filePath, {
      persistent: true,
      ignoreInitial: true,
      usePolling: true,
      interval: 1000,
    });
    liveWatcher.on('change', (p) => { console.log('[reader] change ' + p); scheduleLiveRender(); });
    liveWatcher.on('add',    (p) => { console.log('[reader] add ' + p);    scheduleLiveRender(); });
    liveWatcher.on('ready',  () => console.log('[reader] watcher ready'));
    liveWatcher.on('error',  (e) => console.error('[reader] watcher error:', e && e.message));
    console.log('[reader] live watch ' + filePath);
  } catch (e) {
    console.error('[reader] failed to start live watch:', e.message);
    liveWatcher = null;
  }
}

function stopLiveWatch() {
  if (liveDebounceTimer) { clearTimeout(liveDebounceTimer); liveDebounceTimer = null; }
  if (liveWatcher) {
    try { liveWatcher.close(); } catch (_) {}
    liveWatcher = null;
  }
  currentFilePath = null;
}

function scheduleLiveRender() {
  if (liveDebounceTimer) clearTimeout(liveDebounceTimer);
  liveDebounceTimer = setTimeout(renderLive, LIVE_DEBOUNCE_MS);
}

function renderLive() {
  liveDebounceTimer = null;
  if (!activePanel || !currentFilePath || !currentEntry) {
    console.log('[reader] renderLive skipped panel=' + !!activePanel + ' path=' + !!currentFilePath + ' entry=' + !!currentEntry);
    return;
  }
  let messages, aiTitle;
  try {
    aiTitle = extractAiTitle(currentFilePath, currentEntry.agent);
    messages = extractMessages(currentFilePath, currentEntry.agent);
  } catch (e) {
    console.error('[reader] re-read failed:', e.message);
    return;
  }
  currentMessages = messages;
  currentAiTitle = aiTitle;
  const lastRole = messages.length > 0 ? messages[messages.length - 1].role : null;
  // v3.6.6: cap render count (see readerRender.js + createPanel.js).
  const readerCap = vscode.workspace
    .getConfiguration('claudeCodeLauncher')
    .get('readerMessageCap', 200);
  try {
    activePanel.webview.postMessage({
      type: 'messages-updated',
      meta: buildMeta(currentEntry, aiTitle, messages),
      blocksHtml: renderBlocks(messages, {
        cap: readerCap,
        names: _readerNamesFor(currentEntry.agent),
        agent: currentEntry.agent,
        copyLabel: t('readerCopyBlock'),
      }),
      lastRole,
    });
    console.log('[reader] posted messages-updated count=' + messages.length + ' lastRole=' + lastRole);
  } catch (e) {
    console.error('[reader] postMessage failed:', e.message);
  }
}

// Phase 2: textarea → PTY stdin. Two transport modes by payload size:
//   - >threshold    → temp file, submit "@<path>" so the agent reads the attachment
//   - regular input → the same agent-aware submit path as the split reader
// PTY-dead path posts 'reader-input-failed' so the webview can disable the box.
function handleReaderInput(text) {
  if (!text || !text.trim()) return;
  if (!currentEntry || !currentEntry.pty || currentEntry._disposed) {
    if (activePanel) activePanel.webview.postMessage({ type: 'reader-input-failed', reason: 'session ended' });
    return;
  }
  const cfg = vscode.workspace.getConfiguration('claudeCodeLauncher');
  const threshold = cfg.get('pasteToFileThreshold', 2000);
  let submitText = text;
  if (text.length > threshold) {
    try {
      const tmpDir = path.join(os.tmpdir(), 'claude-launcher-paste');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      const fname = 'reader-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.txt';
      const fullPath = path.join(tmpDir, fname);
      fs.writeFileSync(fullPath, text, 'utf8');
      submitText = '@' + fullPath.replace(/\\/g, '/');
      console.log('[reader] large paste → ' + fullPath);
    } catch (e) {
      if (activePanel) activePanel.webview.postMessage({ type: 'reader-input-failed', reason: 'paste-to-file failed: ' + e.message });
      return;
    }
  }
  try {
    writeSubmitInput(currentEntry, submitText, writePtyChunked);
    if (activePanel) activePanel.webview.postMessage({ type: 'typing-start' });
    console.log('[reader] sent ' + text.length + ' chars to PTY ' + currentEntry.sessionId);
  } catch (e) {
    if (activePanel) activePanel.webview.postMessage({ type: 'reader-input-failed', reason: 'PTY write failed: ' + e.message });
  }
}

function show(entry, context) {
  if (context) _context = context;

  if (!entry || !entry.sessionId || (entry.agent !== 'kiro' && !entry.cwd)) {
    vscode.window.showInformationMessage('Reader: this tab has no session yet.');
    return;
  }
  const filePath = getSessionJsonlPath(entry.sessionId, entry.cwd, entry.agent);
  if (!filePath || !fs.existsSync(filePath)) {
    vscode.window.showInformationMessage(
      'Reader: no session file yet (try once the agent has produced output).'
    );
    return;
  }
  let messages = [];
  let aiTitle = null;
  try {
    aiTitle = extractAiTitle(filePath, entry.agent);
    messages = extractMessages(filePath, entry.agent);
  } catch (e) {
    vscode.window.showErrorMessage('Reader: failed to read session — ' + e.message);
    return;
  }

  currentEntry = entry;
  currentMessages = messages;
  currentAiTitle = aiTitle;

  const stat = fs.statSync(filePath);
  const titleSuffix = aiTitle || formatStamp(stat.mtimeMs);
  const title = `Reader — ${titleSuffix}`;
  const theme = getTheme();
  const html = renderHtml({ title, entry, aiTitle, messages, theme });

  if (activePanel) {
    activePanel.title = title;
    activePanel.webview.html = html;
    activePanel.reveal(undefined, false);
    startLiveWatch(filePath);
    return;
  }

  activePanel = vscode.window.createWebviewPanel(
    'claudeCodeLauncher.reader',
    title,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    { enableScripts: true, retainContextWhenHidden: true }
  );
  activePanel.webview.html = html;
  activePanel.webview.onDidReceiveMessage((msg) => {
    if (!msg) return;
    if (msg.type === 'set-theme') setTheme(msg.theme);
    else if (msg.type === 'save-conversation') saveAsMarkdown();
    else if (msg.type === 'reader-input') handleReaderInput(msg.text || '');
    // v3.20.8: webview clipboard fallback (see copyTextToClipboard in the
    // panel client / the code-block copy handler below).
    else if (msg.type === 'copy-text') {
      if (typeof msg.text === 'string' && msg.text) vscode.env.clipboard.writeText(msg.text);
    }
  });
  activePanel.onDidDispose(() => {
    stopLiveWatch();
    activePanel = null;
    currentEntry = null;
    currentMessages = [];
    currentAiTitle = null;
  });
  startLiveWatch(filePath);
}

function fileSafeStamp(ms) {
  return formatStamp(ms).replace(/[: ]/g, '-');
}

function sanitizeFilename(s) {
  return String(s)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

async function saveAsMarkdown() {
  const entry = currentEntry;
  const messages = currentMessages;
  const aiTitle = currentAiTitle;
  if (!entry || !entry.sessionId) {
    vscode.window.showWarningMessage('Reader: nothing to save.');
    return;
  }

  const stamp = fileSafeStamp(Date.now());
  const titlePart = aiTitle ? sanitizeFilename(aiTitle) : entry.sessionId.slice(0, 8);
  const defaultName = `reader-${stamp}-${titlePart}.md`;

  const wsFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  const defaultUri = wsFolder
    ? vscode.Uri.joinPath(wsFolder.uri, defaultName)
    : vscode.Uri.file(path.join(os.homedir(), defaultName));

  let target;
  try {
    target = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { Markdown: ['md'], 'All Files': ['*'] },
    });
  } catch (e) {
    vscode.window.showErrorMessage('Reader: save dialog failed — ' + e.message);
    return;
  }
  if (!target) return;

  const text = serializeMarkdown(entry, aiTitle, messages);
  try {
    await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf-8'));
    const baseName = path.basename(target.fsPath);
    const open = 'Open';
    const choice = await vscode.window.showInformationMessage(
      `Reader: saved ${baseName}`, open
    );
    if (choice === open) {
      try { await vscode.commands.executeCommand('vscode.open', target); } catch (_) {}
    }
  } catch (e) {
    vscode.window.showErrorMessage('Reader: save failed — ' + e.message);
  }
}

function serializeMarkdown(entry, aiTitle, messages) {
  const lines = [];
  const heading = aiTitle || `Reader — ${entry.sessionId.slice(0, 8)}`;
  lines.push(`# ${heading}`);
  lines.push('');
  lines.push(`- Session: \`${entry.sessionId}\``);
  if (entry.cwd) lines.push(`- cwd: \`${entry.cwd}\``);
  lines.push(`- Exported: ${formatStamp(Date.now())}`);
  lines.push(`- Messages: ${messages.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const m of messages) {
    const ts = m.timestamp ? formatStamp(new Date(m.timestamp).getTime()) : '';
    lines.push(`## ${m.role}${ts ? ` — ${ts}` : ''}`);
    lines.push('');
    lines.push(m.text || '');
    lines.push('');
  }
  return lines.join('\n');
}

function renderHtml({ title, entry, aiTitle, messages, theme }) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;

  const meta = buildMeta(entry, aiTitle, messages);
  // v3.6.6: cap initial render too (live updates go through renderLive
  // above with the same cap).
  const readerCap = vscode.workspace
    .getConfiguration('claudeCodeLauncher')
    .get('readerMessageCap', 200);
  const blocks = renderBlocks(messages, {
    cap: readerCap,
    names: _readerNamesFor(entry.agent),
    agent: entry.agent,
    copyLabel: t('readerCopyBlock'),
  });

  const toggleIcon = theme === 'dark' ? '☀' : '🌙';
  const toggleTitle = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark light; }

  body.theme-dark {
    --bg: #1e1e1e; --fg: #ececec; --fg-strong: #ffffff; --fg-muted: #9a9a9a;
    --ts: #777; --border: #333; --user: #4fc1ff; --assistant: #D97757;
    --code-bg: #2a2a2a; --code-fg: #f5d59a; --pre-bg: #161616; --pre-border: #2a2a2a;
    --quote-border: #444; --quote-fg: #b8b8b8;
  }
  body.theme-light {
    --bg: #ffffff; --fg: #1f1f1f; --fg-strong: #000000; --fg-muted: #555;
    --ts: #888; --border: #ddd; --user: #0066cc; --assistant: #C96442;
    --code-bg: #f3f3f3; --code-fg: #c1671c; --pre-bg: #f8f8f8; --pre-border: #e1e1e1;
    --quote-border: #bbb; --quote-fg: #555;
  }

  body {
    background: var(--bg); color: var(--fg);
    font-family: -apple-system, "Segoe UI", "Pretendard", "Apple SD Gothic Neo", sans-serif;
    line-height: 1.65; margin: 0; padding: 24px 32px 96px; max-width: 980px;
  }
  .reader-meta {
    font-size: 11px; color: var(--fg-muted);
    border-bottom: 1px solid var(--border);
    padding-bottom: 8px; margin-bottom: 24px; word-break: break-all;
  }
  .reader-empty { color: var(--fg-muted); font-style: italic; padding: 40px 0; text-align: center; }
  .reader-welcome { display: flex; flex-direction: column; align-items: center; min-height: 45vh; padding: 12px 0 28px; text-align: center; }
  .reader-welcome-brand { font-size: 15px; font-weight: 600; letter-spacing: 0.3px; color: var(--fg); opacity: 0.9; }
  .reader-welcome-brand .rw-spark { color: #D97757; margin-right: 3px; }
  .reader-welcome-hero { margin-top: auto; display: flex; flex-direction: column; align-items: center; gap: 16px; padding-bottom: 7%; }
  .rw-robot { width: 56px; height: 56px; opacity: 0.95; color: var(--accent, #D97757); }
  .rw-msg { color: var(--fg-muted); font-size: 13px; line-height: 1.7; max-width: 300px; }

  .reader-actions {
    position: fixed; top: 14px; right: 18px; z-index: 10;
    display: flex; gap: 6px;
  }
  .reader-action {
    background: var(--bg); border: 1px solid var(--border); color: var(--fg);
    cursor: pointer; padding: 4px 10px; border-radius: 4px;
    font-size: 14px; line-height: 1; opacity: 0.65; transition: opacity 0.15s;
    font-family: inherit;
  }
  .reader-action:hover { opacity: 1; }

  .reader-live-dot {
    font-size: 9px; color: #4caf50; opacity: 0.4;
    padding: 0 4px; transition: opacity 0.25s, transform 0.25s;
    user-select: none; line-height: 1; cursor: default;
    display: inline-flex; align-items: center;
  }
  .reader-live-dot.flash { opacity: 1; transform: scale(1.4); }
  .reader-live-dot.typing {
    animation: reader-typing-pulse 1.1s ease-in-out infinite;
  }
  @keyframes reader-typing-pulse {
    0%, 100% { opacity: 0.4; transform: scale(1); color: #4caf50; }
    50%      { opacity: 1; transform: scale(1.4); color: #ffaa3b; }
  }

  .reader-input-bar {
    position: fixed; bottom: 0; left: 0; right: 0;
    background: var(--bg); border-top: 1px solid var(--border);
    padding: 10px 32px; display: flex; gap: 8px;
    z-index: 10; box-sizing: border-box;
  }
  .reader-input {
    flex: 1; min-height: 38px; max-height: 200px;
    padding: 8px 10px; resize: none; box-sizing: border-box;
    background: var(--code-bg); color: var(--fg);
    border: 1px solid var(--border); border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, "D2Coding", Consolas, monospace;
    font-size: 13px; line-height: 1.4; outline: none;
  }
  .reader-input:focus { border-color: var(--user); }
  .reader-input:disabled { opacity: 0.5; cursor: not-allowed; }
  .reader-send {
    background: var(--user); color: var(--bg); border: none;
    padding: 0 18px; border-radius: 4px; cursor: pointer;
    font-size: 13px; font-weight: 600; min-height: 38px;
    font-family: inherit;
  }
  .reader-send:hover { opacity: 0.9; }
  .reader-send:disabled { opacity: 0.4; cursor: not-allowed; }
  .reader-input-error {
    position: fixed; bottom: 64px; left: 32px; right: 32px;
    background: var(--code-bg); color: #ff6b6b; border: 1px solid #ff6b6b;
    border-radius: 4px; padding: 8px 12px; font-size: 12px;
    z-index: 11; display: none; box-sizing: border-box;
  }
  .reader-input-error.show { display: block; }

  .msg { margin-bottom: 28px; }
  .msg-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; font-size: 11px; }
  .msg-head .role { font-weight: 600; letter-spacing: 0.5px; }
  .msg-user .role { color: var(--user); }
  .msg-assistant .role { color: var(--assistant); }
  .msg-head .ts { color: var(--ts); font-family: ui-monospace, SFMono-Regular, "D2Coding", Consolas, monospace; }

  .msg-body {
    padding-left: 14px; border-left: 2px solid var(--border); color: var(--fg);
  }
  .msg-user .msg-body { border-left-color: color-mix(in srgb, var(--user) 33%, transparent); }
  .msg-assistant .msg-body { border-left-color: color-mix(in srgb, var(--assistant) 33%, transparent); }
  .msg-body > :first-child { margin-top: 0; }
  .msg-body > :last-child { margin-bottom: 0; }
  .msg-body p { margin: 0.5em 0; }
  .msg-body strong { color: var(--fg-strong); }
  .msg-body code {
    background: var(--code-bg); color: var(--code-fg);
    padding: 1px 5px; border-radius: 3px;
    font-family: ui-monospace, SFMono-Regular, "D2Coding", Consolas, monospace; font-size: 0.92em;
  }
  .msg-body pre {
    background: var(--pre-bg); border: 1px solid var(--pre-border);
    border-radius: 6px; padding: 12px; overflow-x: auto;
  }
  .reader-code-block { position: relative; margin: 0.8em 0; }
  .reader-code-block pre { margin: 0; padding-top: 36px; }
  .reader-code-copy {
    position: absolute; top: 7px; right: 7px; z-index: 1;
    display: inline-flex; align-items: center; justify-content: center;
    width: 27px; height: 25px; padding: 0;
    border: 1px solid var(--pre-border); border-radius: 4px;
    background: var(--code-bg); color: var(--ts);
    cursor: pointer; opacity: 0.78;
  }
  .reader-code-copy:hover, .reader-code-copy:focus-visible { opacity: 1; color: var(--fg); }
  .reader-code-copy:focus-visible { outline: 1px solid var(--assistant); outline-offset: 1px; }
  .reader-code-copy svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.4; }
  .reader-code-copy.copied { color: #4caf50; border-color: #4caf50; opacity: 1; }
  .reader-code-copy.copied svg { display: none; }
  .reader-code-copy.copied::after { content: '\\2713'; font-size: 14px; font-weight: 700; }
  .msg-body pre code { background: transparent; color: var(--fg); padding: 0; font-size: 0.88em; }
  .msg-body table { border-collapse: collapse; margin: 0.8em 0; font-size: 0.95em; }
  .msg-body th, .msg-body td { border: 1px solid var(--border); padding: 4px 10px; }
  .msg-body th { background: var(--code-bg); }
  .msg-body blockquote {
    margin: 0.5em 0; padding-left: 12px;
    border-left: 3px solid var(--quote-border); color: var(--quote-fg);
  }
  .msg-body a { color: var(--user); }
  .msg-body hr { border: 0; border-top: 1px solid var(--border); margin: 1em 0; }
</style>
</head>
<body class="theme-${theme}">
<div class="reader-actions">
  <span class="reader-live-dot" id="live-dot" title="Watching session for new messages">●</span>
  <button class="reader-action" id="save-btn" title="Save as Markdown" aria-label="Save">💾</button>
  <button class="reader-action" id="theme-toggle" title="${toggleTitle}" aria-label="Toggle theme">${toggleIcon}</button>
</div>
<div class="reader-meta" id="reader-meta">${escapeHtml(meta)}</div>
<div id="reader-blocks">${blocks}</div>
<div class="reader-input-error" id="reader-input-error"></div>
<div class="reader-input-bar">
  <textarea class="reader-input" id="reader-input" placeholder="Send a message — Enter to send, Shift+Enter for newline" rows="1"></textarea>
  <button class="reader-send" id="reader-send">Send</button>
</div>
<script nonce="${nonce}">
  (function() {
    const vscode = acquireVsCodeApi();
    const themeBtn = document.getElementById('theme-toggle');
    if (themeBtn) {
      themeBtn.addEventListener('click', function() {
        const isDark = document.body.classList.contains('theme-dark');
        const next = isDark ? 'light' : 'dark';
        document.body.classList.remove('theme-dark', 'theme-light');
        document.body.classList.add('theme-' + next);
        themeBtn.textContent = next === 'dark' ? '☀' : '🌙';
        themeBtn.title = next === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
        vscode.postMessage({ type: 'set-theme', theme: next });
      });
    }
    const saveBtn = document.getElementById('save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'save-conversation' });
      });
    }

    const liveDot = document.getElementById('live-dot');
    const metaEl = document.getElementById('reader-meta');
    const blocksEl = document.getElementById('reader-blocks');
    const inputEl = document.getElementById('reader-input');
    const sendBtn = document.getElementById('reader-send');
    const errorEl = document.getElementById('reader-input-error');
    const copyLabel = ${JSON.stringify(t('readerCopyBlock'))};
    const copiedLabel = ${JSON.stringify(t('copied'))};
    const copyFailedLabel = ${JSON.stringify(t('readerCopyFailed'))};
    let flashTimer = null;
    let errorTimer = null;
    function flashLive() {
      if (!liveDot) return;
      liveDot.classList.add('flash');
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(function() { liveDot.classList.remove('flash'); flashTimer = null; }, 500);
    }
    function showError(text) {
      if (!errorEl) return;
      errorEl.textContent = '✗ ' + text;
      errorEl.classList.add('show');
      if (errorTimer) clearTimeout(errorTimer);
      errorTimer = setTimeout(function() { errorEl.classList.remove('show'); errorTimer = null; }, 4000);
    }
    function autoGrow() {
      if (!inputEl) return;
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(200, inputEl.scrollHeight) + 'px';
    }
    function send() {
      if (!inputEl) return;
      const text = inputEl.value;
      if (!text.trim()) return;
      vscode.postMessage({ type: 'reader-input', text: text });
      inputEl.value = '';
      autoGrow();
    }
    if (inputEl) {
      inputEl.addEventListener('input', autoGrow);
      inputEl.addEventListener('keydown', function(e) {
        // IME composition: do not send while user is composing Hangul/CJK
        if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing) {
          e.preventDefault();
          send();
        }
      });
    }
    if (sendBtn) sendBtn.addEventListener('click', send);

    if (blocksEl) {
      // Delegated listener remains active when live updates replace blocksHtml.
      blocksEl.addEventListener('click', async function(e) {
        const button = e.target && e.target.closest && e.target.closest('.reader-code-copy');
        if (!button || !blocksEl.contains(button)) return;
        e.preventDefault();
        e.stopPropagation();
        const block = button.closest('.reader-code-block');
        const code = block && block.querySelector('code');
        if (!code) return;
        const text = (code.textContent || '').replace(/\\n$/, '');
        if (!text.trim()) {
          button.title = copyFailedLabel;
          button.setAttribute('aria-label', copyFailedLabel);
          return;
        }
        // navigator.clipboard rejects when the webview is not the focused
        // document; the extension host clipboard has no such restriction, so
        // fall back to it instead of reporting a copy that never happened.
        let ok = true;
        try {
          await navigator.clipboard.writeText(text);
        } catch (_) {
          ok = false;
          try {
            vscode.postMessage({ type: 'copy-text', text: text });
            ok = true;
          } catch (_e) {}
        }
        if (ok) {
          button.classList.add('copied');
          button.title = copiedLabel;
          button.setAttribute('aria-label', copiedLabel);
          setTimeout(function() {
            if (!button.isConnected) return;
            button.classList.remove('copied');
            button.title = copyLabel;
            button.setAttribute('aria-label', copyLabel);
          }, 1600);
        } else {
          button.title = copyFailedLabel;
          button.setAttribute('aria-label', copyFailedLabel);
        }
      });
    }

    window.addEventListener('message', function(e) {
      const m = e.data;
      console.log('[reader webview] msg', m && m.type);
      if (!m) return;
      if (m.type === 'messages-updated') {
        const wasNearBottom = (window.innerHeight + window.scrollY) >= (document.body.scrollHeight - 80);
        if (typeof m.meta === 'string' && metaEl) metaEl.textContent = m.meta;
        if (typeof m.blocksHtml === 'string' && blocksEl) blocksEl.innerHTML = m.blocksHtml;
        if (wasNearBottom) window.scrollTo(0, document.body.scrollHeight);
        // Only release typing on assistant arrival — a user-only flush (the
        // message we just sent landing in jsonl) should keep pulsing so the
        // reader stays in "Claude is working" state until the reply lands.
        if (m.lastRole === 'assistant' && liveDot) liveDot.classList.remove('typing');
        flashLive();
      } else if (m.type === 'typing-start') {
        if (liveDot) liveDot.classList.add('typing');
      } else if (m.type === 'reader-input-failed') {
        const reason = m.reason || 'send failed';
        showError(reason);
        if (reason === 'session ended') {
          if (inputEl) inputEl.disabled = true;
          if (sendBtn) sendBtn.disabled = true;
        }
      }
    });
  })();
</script>
</body></html>`;
}

module.exports = { show };
