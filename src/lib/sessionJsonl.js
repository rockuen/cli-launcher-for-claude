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

// Parsed-lines cache. The split-pane reader and the standalone reader both
// poll the same jsonl file, and each render used to call extractAiTitle +
// extractMessages back-to-back — two whole-file reads + parses per render
// tick for a single visible session. With 5 concurrent sessions that turned
// into 10 reads/parses per render burst, on a file that grows to several MB
// over a long session. Caching by {mtime, size} lets repeated reads of the
// same on-disk snapshot share a single parse. The entry is invalidated
// automatically the next time the file changes.
const _lineCache = new Map();
const _LINE_CACHE_MAX = 20; // ~max active sessions across both readers + the tree provider

// v3.5.6: don't cache parsed lines for very large jsonls. Tree refresh touches
// every session file in the project; on vaults with multiple 20-50 MB sessions
// (scm-pdca pattern observed in iloom-workspace: 7 files totalling 130 MB+),
// caching parsed lines used to accumulate 500+ MB of resident memory because
// the LRU happened to land on those big files. Large files still get fully
// read + parsed (callers see no behavior change), they just don't persist in
// the cache — so the next call re-parses from disk. Sized to comfortably fit
// the average jsonl (≈ 1.3 MB in the wild) while excluding extreme outliers.
const MAX_CACHEABLE_BYTES = 2 * 1024 * 1024; // 2 MB

function _readLinesCached(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return null; }
  const cached = _lineCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    cached.lastUsed = Date.now();
    return cached.lines;
  }
  let lines;
  try {
    lines = _splitJsonLines(fs.readFileSync(filePath, 'utf-8'));
  } catch { return null; }
  // v3.5.6: skip cache insertion for oversized files. Callers still receive
  // the parsed result, but the next call will re-parse from disk rather than
  // pinning a multi-MB array in memory across tree refreshes.
  if (stat.size > MAX_CACHEABLE_BYTES) return lines;
  if (_lineCache.size >= _LINE_CACHE_MAX) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, v] of _lineCache) {
      if (v.lastUsed < oldestTime) { oldestTime = v.lastUsed; oldestKey = k; }
    }
    if (oldestKey) _lineCache.delete(oldestKey);
  }
  _lineCache.set(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    lines,
    lastUsed: Date.now(),
  });
  return lines;
}

// Test-only: clear the line cache so unit tests can observe fresh reads.
function _clearLineCache() { _lineCache.clear(); }

// Latest `ai-title` line wins — Claude Code rewrites the title as a session grows.
function extractAiTitle(filePath) {
  const lines = _readLinesCached(filePath);
  if (!lines) return null;
  let title = null;
  for (const d of lines) {
    if (d.type === 'ai-title' && typeof d.aiTitle === 'string' && d.aiTitle.trim()) {
      title = d.aiTitle.trim();
    }
  }
  return title;
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
  const lines = _readLinesCached(filePath);
  if (!lines) return out;
  try {
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

// User + assistant turn count, matching extractMessages()'s filter so the
// number on the metadata row equals the rendered reader transcript length.
function extractMessageCount(filePath) {
  let n = 0;
  const lines = _readLinesCached(filePath);
  if (!lines) return n;
  try {
    for (const d of lines) {
      if (d.isSidechain) continue;
      if (d.type === 'assistant') {
        const c = d.message && d.message.content;
        if (Array.isArray(c) && c.some(blk => blk && blk.type === 'text' && typeof blk.text === 'string' && blk.text.trim())) {
          n++;
        }
      } else if (d.type === 'user' && !d.isMeta) {
        const msg = d.message;
        if (!msg || msg.role !== 'user') continue;
        if (typeof msg.content !== 'string') continue;
        if (SYS_TAG_RE.test(msg.content)) continue;
        if (!msg.content.trim()) continue;
        n++;
      }
    }
  } catch {}
  return n;
}

module.exports = {
  getSessionJsonlPath,
  extractAiTitle,
  extractFirstUserMessage,
  extractMessages,
  extractMessageCount,
  _clearLineCache,
};
