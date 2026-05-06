// @module lib/sessionJsonl — read Claude Code session jsonl files
//
// Claude Code stores each conversation as a line-delimited JSON file under
// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl. The cwd is rewritten
// by replacing [/\\:' ] with '-' (verified empirically for paths containing
// spaces, apostrophes, and Windows drive letters — `C:\Users\foo` becomes
// `C--Users-foo`, with both ':' and '\' folded to '-').
//
// Shared between the sidebar tree (label fallback) and the reader panel so
// both speak the same JSONL dialect.

const path = require('path');
const os = require('os');
const fs = require('fs');

function getSessionJsonlPath(sessionId, cwd) {
  if (!sessionId || !cwd) return null;
  // v3.4.7: include ':' in the strip set. Without it, Windows cwds like
  // 'C:\\Users\\foo\\proj' encoded to 'C:-Users-foo-proj' (colon kept), which
  // never matched Claude Code's actual 'C--Users-foo-proj' folder — so the
  // reader watcher tailed a non-existent path and the split-pane stayed at
  // "Waiting for session output…" forever. macOS paths lack ':', so this
  // regression only ever bit Windows users.
  const encoded = String(cwd).replace(/[\/\\:' ]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
}

function _readChunk(filePath, bytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf-8', 0, n);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function _splitJsonLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

// Latest `ai-title` line wins — Claude Code rewrites the title as a session grows.
function extractAiTitle(filePath) {
  try {
    const lines = _splitJsonLines(fs.readFileSync(filePath, 'utf-8'));
    let title = null;
    for (const d of lines) {
      if (d.type === 'ai-title' && typeof d.aiTitle === 'string' && d.aiTitle.trim()) {
        title = d.aiTitle.trim();
      }
    }
    return title;
  } catch { return null; }
}

// First non-meta user message, single-line, XML-stripped — used as a tree label
// fallback when no savedTitle / aiTitle exists. Reads only the first 32KB.
function extractFirstUserMessage(filePath) {
  try {
    const lines = _splitJsonLines(_readChunk(filePath, 32768));
    for (const d of lines) {
      if (d.type !== 'user' || d.isMeta) continue;
      const msg = d.message;
      if (!msg || msg.role !== 'user') continue;
      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const c of msg.content) {
          if (c.type === 'text' && c.text) { text = c.text; break; }
        }
      }
      text = text.replace(/<[^>]+>/g, '').trim().split('\n')[0].trim();
      if (text) return text;
    }
  } catch {}
  return null;
}

// Reader payload — user + assistant turns in chronological order.
//   - assistant: only text blocks (drops thinking + tool_use)
//   - user:      only string content + non-meta + non-sidechain
//   - filters:   sidechain, isMeta, system-tag-prefixed strings
const SYS_TAG_RE = /^\s*<(?:command-[a-z-]+|local-command-[a-z-]+|system-reminder|user-prompt-submit-hook)\b/i;

function extractMessages(filePath) {
  const out = [];
  try {
    const lines = _splitJsonLines(fs.readFileSync(filePath, 'utf-8'));
    for (const d of lines) {
      if (d.isSidechain) continue;
      const ts = d.timestamp || null;
      if (d.type === 'assistant') {
        const content = d.message && d.message.content;
        if (!Array.isArray(content)) continue;
        const parts = [];
        for (const blk of content) {
          if (blk && blk.type === 'text' && typeof blk.text === 'string' && blk.text.trim()) {
            parts.push(blk.text);
          }
        }
        if (parts.length === 0) continue;
        out.push({ role: 'assistant', text: parts.join('\n\n'), timestamp: ts });
      } else if (d.type === 'user' && !d.isMeta) {
        const msg = d.message;
        if (!msg || msg.role !== 'user') continue;
        if (typeof msg.content !== 'string') continue;
        const t = msg.content;
        if (SYS_TAG_RE.test(t)) continue;
        if (!t.trim()) continue;
        out.push({ role: 'user', text: t, timestamp: ts });
      }
    }
  } catch {}
  return out;
}

module.exports = {
  getSessionJsonlPath,
  extractAiTitle,
  extractFirstUserMessage,
  extractMessages,
};
