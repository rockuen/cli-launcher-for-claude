// @module panel/readerView — read-only markdown viewer for the active session.
//
// Reads ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl directly (no PTY
// stripping — the assistant text blocks are already clean markdown). One
// shared panel: subsequent calls re-render in place rather than opening
// new tabs.

const vscode = require('vscode');
const fs = require('fs');
const marked = require('marked');
const {
  getSessionJsonlPath,
  extractAiTitle,
  extractMessages,
} = require('../lib/sessionJsonl');

let activePanel = null;

function show(entry) {
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
  const html = renderHtml({ title, entry, aiTitle, messages });

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
    { enableScripts: false, retainContextWhenHidden: true }
  );
  activePanel.webview.html = html;
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

function renderHtml({ title, entry, aiTitle, messages }) {
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

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark light; }
  body { background: #1e1e1e; color: #d4d4d4; font-family: -apple-system, "Segoe UI", "Pretendard", "Apple SD Gothic Neo", sans-serif; line-height: 1.65; margin: 0; padding: 24px 32px; max-width: 980px; }
  .reader-meta { font-size: 11px; color: #888; border-bottom: 1px solid #333; padding-bottom: 8px; margin-bottom: 24px; word-break: break-all; }
  .reader-empty { color: #888; font-style: italic; padding: 40px 0; text-align: center; }
  .msg { margin-bottom: 28px; }
  .msg-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; font-size: 11px; }
  .msg-head .role { text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px; }
  .msg-user .role { color: #4fc1ff; }
  .msg-assistant .role { color: #c5a3ff; }
  .msg-head .ts { color: #666; font-family: ui-monospace, SFMono-Regular, "D2Coding", Consolas, monospace; }
  .msg-body { padding-left: 14px; border-left: 2px solid #333; }
  .msg-user .msg-body { border-left-color: #4fc1ff55; }
  .msg-assistant .msg-body { border-left-color: #c5a3ff55; }
  .msg-body > :first-child { margin-top: 0; }
  .msg-body > :last-child { margin-bottom: 0; }
  .msg-body p { margin: 0.5em 0; }
  .msg-body code { background: #2a2a2a; padding: 1px 5px; border-radius: 3px; font-family: ui-monospace, SFMono-Regular, "D2Coding", Consolas, monospace; font-size: 0.92em; }
  .msg-body pre { background: #161616; border: 1px solid #2a2a2a; border-radius: 6px; padding: 12px; overflow-x: auto; }
  .msg-body pre code { background: transparent; padding: 0; font-size: 0.88em; }
  .msg-body table { border-collapse: collapse; margin: 0.8em 0; font-size: 0.95em; }
  .msg-body th, .msg-body td { border: 1px solid #333; padding: 4px 10px; }
  .msg-body th { background: #2a2a2a; }
  .msg-body blockquote { margin: 0.5em 0; padding-left: 12px; border-left: 3px solid #444; color: #aaa; }
  .msg-body a { color: #4fc1ff; }
  .msg-body hr { border: 0; border-top: 1px solid #333; margin: 1em 0; }
  @media (prefers-color-scheme: light) {
    body { background: #ffffff; color: #1f1f1f; }
    .reader-meta { color: #555; border-color: #ddd; }
    .msg-user .role { color: #0066cc; }
    .msg-assistant .role { color: #6b46c1; }
    .msg-body { border-left-color: #ddd; }
    .msg-user .msg-body { border-left-color: #0066cc55; }
    .msg-assistant .msg-body { border-left-color: #6b46c155; }
    .msg-body code { background: #f3f3f3; }
    .msg-body pre { background: #f8f8f8; border-color: #e1e1e1; }
    .msg-body th { background: #f3f3f3; }
    .msg-body th, .msg-body td { border-color: #ddd; }
    .msg-body blockquote { border-color: #bbb; color: #555; }
    .msg-body a { color: #0066cc; }
    .msg-body hr { border-top-color: #ddd; }
  }
</style>
</head>
<body>
<div class="reader-meta">${escapeHtml(meta)}</div>
${blocks}
</body></html>`;
}

module.exports = { show };
