// @module panel/readerView — read-only markdown viewer for the active session.
//
// Reads ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl directly (no PTY
// stripping — assistant text blocks are already clean markdown). One shared
// panel: subsequent calls re-render in place rather than opening new tabs.
//
// Theme: per-user choice (dark default), persisted to ExtensionContext
// globalState. Toggle button in the panel flips the choice and posts back
// to the extension so the next open keeps the same theme.

const vscode = require('vscode');
const fs = require('fs');
const crypto = require('crypto');
const marked = require('marked');
const {
  getSessionJsonlPath,
  extractAiTitle,
  extractMessages,
} = require('../lib/sessionJsonl');

const THEME_KEY = 'claudeCodeLauncher.readerTheme';
const DEFAULT_THEME = 'dark';

let activePanel = null;
let _context = null;

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

function show(entry, context) {
  if (context) _context = context;

  if (!entry || !entry.sessionId || !entry.cwd) {
    vscode.window.showInformationMessage('Reader: this tab has no session yet.');
    return;
  }
  const filePath = getSessionJsonlPath(entry.sessionId, entry.cwd);
  if (!filePath || !fs.existsSync(filePath)) {
    vscode.window.showInformationMessage(
      'Reader: no session file yet (try once Claude has produced output).'
    );
    return;
  }
  let messages = [];
  let aiTitle = null;
  try {
    aiTitle = extractAiTitle(filePath);
    messages = extractMessages(filePath);
  } catch (e) {
    vscode.window.showErrorMessage('Reader: failed to read session — ' + e.message);
    return;
  }

  const stat = fs.statSync(filePath);
  const titleSuffix = aiTitle || formatStamp(stat.mtimeMs);
  const title = `Reader — ${titleSuffix}`;
  const theme = getTheme();
  const html = renderHtml({ title, entry, aiTitle, messages, theme });

  if (activePanel) {
    activePanel.title = title;
    activePanel.webview.html = html;
    activePanel.reveal(undefined, false);
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
    if (msg && msg.type === 'set-theme') setTheme(msg.theme);
  });
  activePanel.onDidDispose(() => { activePanel = null; });
}

function formatStamp(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderHtml({ title, entry, aiTitle, messages, theme }) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;

  const metaParts = [
    aiTitle || '(untitled)',
    entry.sessionId.slice(0, 8),
    `${messages.length} message${messages.length === 1 ? '' : 's'}`,
  ];
  if (entry.cwd) metaParts.push(`cwd: ${entry.cwd}`);
  const meta = metaParts.join(' · ');

  const blocks = messages.length === 0
    ? '<div class="reader-empty">No user/assistant messages yet.</div>'
    : messages.map((m) => {
        const ts = m.timestamp ? formatStamp(new Date(m.timestamp).getTime()) : '';
        const body = marked.parse(m.text || '', { breaks: false, gfm: true });
        return `<div class="msg msg-${m.role}">
  <div class="msg-head"><span class="role">${m.role}</span><span class="ts">${escapeHtml(ts)}</span></div>
  <div class="msg-body">${body}</div>
</div>`;
      }).join('\n');

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
    --ts: #777; --border: #333; --user: #4fc1ff; --assistant: #c5a3ff;
    --code-bg: #2a2a2a; --code-fg: #f5d59a; --pre-bg: #161616; --pre-border: #2a2a2a;
    --quote-border: #444; --quote-fg: #b8b8b8;
  }
  body.theme-light {
    --bg: #ffffff; --fg: #1f1f1f; --fg-strong: #000000; --fg-muted: #555;
    --ts: #888; --border: #ddd; --user: #0066cc; --assistant: #6b46c1;
    --code-bg: #f3f3f3; --code-fg: #c1671c; --pre-bg: #f8f8f8; --pre-border: #e1e1e1;
    --quote-border: #bbb; --quote-fg: #555;
  }

  body {
    background: var(--bg); color: var(--fg);
    font-family: -apple-system, "Segoe UI", "Pretendard", "Apple SD Gothic Neo", sans-serif;
    line-height: 1.65; margin: 0; padding: 24px 32px; max-width: 980px;
  }
  .reader-meta {
    font-size: 11px; color: var(--fg-muted);
    border-bottom: 1px solid var(--border);
    padding-bottom: 8px; margin-bottom: 24px; word-break: break-all;
  }
  .reader-empty { color: var(--fg-muted); font-style: italic; padding: 40px 0; text-align: center; }

  .theme-toggle {
    position: fixed; top: 14px; right: 18px; z-index: 10;
    background: var(--bg); border: 1px solid var(--border); color: var(--fg);
    cursor: pointer; padding: 4px 10px; border-radius: 4px;
    font-size: 14px; line-height: 1; opacity: 0.65; transition: opacity 0.15s;
    font-family: inherit;
  }
  .theme-toggle:hover { opacity: 1; }

  .msg { margin-bottom: 28px; }
  .msg-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; font-size: 11px; }
  .msg-head .role { text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px; }
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
<button class="theme-toggle" id="theme-toggle" title="${toggleTitle}" aria-label="Toggle theme">${toggleIcon}</button>
<div class="reader-meta">${escapeHtml(meta)}</div>
${blocks}
<script nonce="${nonce}">
  (function() {
    const vscode = acquireVsCodeApi();
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    btn.addEventListener('click', function() {
      const isDark = document.body.classList.contains('theme-dark');
      const next = isDark ? 'light' : 'dark';
      document.body.classList.remove('theme-dark', 'theme-light');
      document.body.classList.add('theme-' + next);
      btn.textContent = next === 'dark' ? '☀' : '🌙';
      btn.title = next === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
      vscode.postMessage({ type: 'set-theme', theme: next });
    });
  })();
</script>
</body></html>`;
}

module.exports = { show };
