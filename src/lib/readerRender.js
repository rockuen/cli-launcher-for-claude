// @module lib/readerRender — shared markdown rendering for reader views.
//
// Phase 3 split-layout extracted these helpers out of readerView so the
// cli-launcher panel can render the same chat blocks alongside its xterm.
// readerView and createPanel both import from here so a single source
// renders messages identically regardless of which panel hosts them.

const marked = require('marked');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatStamp(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function buildMeta(entry, aiTitle, messages) {
  const parts = [
    aiTitle || '(untitled)',
    entry.sessionId ? entry.sessionId.slice(0, 8) : '',
    `${messages.length} message${messages.length === 1 ? '' : 's'}`,
  ].filter(Boolean);
  if (entry.cwd) parts.push(`cwd: ${entry.cwd}`);
  return parts.join(' · ');
}

function renderBlocks(messages) {
  if (!messages || messages.length === 0) {
    return '<div class="reader-empty">No user/assistant messages yet.</div>';
  }
  return messages.map((m) => {
    const ts = m.timestamp ? formatStamp(new Date(m.timestamp).getTime()) : '';
    // user input preserves single newlines as <br> (GFM-comment style) so
    // multi-line typed messages read the way they were typed; assistant text
    // stays in standard markdown — single \n inside a paragraph collapses,
    // double \n breaks paragraphs as authored.
    const body = marked.parse(m.text || '', { breaks: m.role === 'user', gfm: true });
    return `<div class="msg msg-${m.role}">
  <div class="msg-head"><span class="role">${m.role}</span><span class="ts">${escapeHtml(ts)}</span></div>
  <div class="msg-body">${body}</div>
</div>`;
  }).join('\n');
}

module.exports = { escapeHtml, formatStamp, buildMeta, renderBlocks };
