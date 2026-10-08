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
const { getCodexPaths, getKiroSessionsDir, getAntigravityBaseDir, getGrokPaths, getGjcPaths, getChiefPaths } = require('./projectSessions');

// Find the most-recently-updated Kiro session jsonl that matches the given cwd.
// Kiro writes a companion .json metadata file alongside each .jsonl (same dir,
// same base name). The metadata carries { session_id, cwd, created_at,
// updated_at }. We scan all .json files (excluding .jsonl), filter to those
// whose cwd matches, and return the path of the most recently updated one.
// Returns null when the directory doesn't exist or no matching session is found.
function findLatestKiroSessionPath(cwd) {
  const dir = getKiroSessionsDir(cwd);
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.jsonl'));
  } catch { return null; }
  let best = null, bestTime = -1;
  for (const m of files) {
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, m), 'utf-8')); } catch { continue; }
    if (cwd && meta.cwd !== cwd) continue; // exact cwd match
    const t = Date.parse(meta.updated_at || meta.created_at || '') || 0;
    if (t > bestTime) {
      bestTime = t;
      best = meta.session_id || m.replace(/\.json$/, '');
    }
  }
  return best ? path.join(dir, best + '.jsonl') : null;
}

// List all Kiro sessions whose metadata cwd matches the given cwd, newest
// first. Reads the companion .json metadata files under ~/.kiro/sessions/cli/
// (excluding the .jsonl transcripts), filters to the matching cwd, and sorts
// by updated_at DESC. Each entry is { sessionId, title, cwd, updatedAt }.
// Returns [] when the directory doesn't exist or nothing matches. The `_dir`
// arg is test-only injection; production callers pass cwd alone.
function listKiroSessions(cwd, _dir) {
  const dir = _dir || getKiroSessionsDir(cwd);
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.jsonl'));
  } catch { return []; }
  const out = [];
  for (const m of files) {
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, m), 'utf-8')); } catch { continue; }
    if (!_cwdMatch(meta.cwd, cwd)) continue;
    out.push({
      sessionId: meta.session_id || m.replace(/\.json$/, ''),
      title: meta.title || '',
      cwd: meta.cwd,
      updatedAt: meta.updated_at,
    });
  }
  out.sort((a, b) => (Date.parse(b.updatedAt || '') || 0) - (Date.parse(a.updatedAt || '') || 0));
  return out;
}

// Normalise a timestamp to epoch-ms. Agent transcripts mix ISO-8601 strings,
// unix seconds, and unix milliseconds depending on the CLI/build:
//   grok updates.jsonl `timestamp` = unix seconds (1787278815 → 2026-08-21)
//   grok `_meta.agentTimestampMs`  = unix milliseconds
//   antigravity history.jsonl      = any of the three
// Numbers below 1e12 are seconds (epoch-ms for 2001+ is already ≥1e12).
// Returns 0 when unparseable so callers can sort/format defensively.
function _toEpochMs(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number' && isFinite(v)) return v >= 1e12 ? v : v * 1000;
  const n = Number(v);
  if (typeof v !== 'object' && isFinite(n) && String(v).trim() !== '') {
    if (n >= 1e12) return n;
    if (n >= 1e9) return n * 1000; // unix seconds as numeric string
  }
  const p = Date.parse(String(v));
  return Number.isNaN(p) ? 0 : p;
}

function _antigravityTs(v) {
  return _toEpochMs(v);
}

// Windows-safe path equality: agy may store the workspace path with a different
// drive-letter case or slash style than VSCode hands us (e.g. `C:\Projects\x`
// vs `c:/Projects/x`). Fold separators + case before comparing so the cwd
// filter doesn't silently drop every session on a drive-case mismatch.
function _samePath(a, b) {
  const norm = (p) => String(p || '').replace(/[\/\\]+/g, '\\').replace(/\\+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

// Last `n` path segments, lower-cased, separators normalized. Drops a trailing
// slash and empty segments. e.g. ("c:\\Obsidian\\Won's 2nd Brain", 2) →
// ["obsidian", "won's 2nd brain"].
function _tailSegs(p, n) {
  const segs = String(p || '')
    .replace(/[\/\\]+$/, '')
    .split(/[\/\\]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  return segs.slice(-n);
}

// cwd match used by the Kiro / Antigravity session lists. Exact (normalized)
// match for same-OS devices, with a CROSS-OS fallback so a workspace synced
// across platforms shows the same sessions even though the absolute cwd differs
// by OS — e.g. a session created on Windows (`c:\Obsidian\Won's 2nd Brain`) is
// resumable from the same vault on macOS (`/Users/rockuen/obsidian/Won's 2nd
// Brain`) once the session files sync (OneDrive symlink). The fallback compares
// the last TWO segments (parent + leaf, case-insensitive) rather than a bare
// basename, so unrelated workspaces that merely share a leaf name (`/my/project`
// vs `/other/project`) don't collide. Only the per-agent views use this;
// claude's project-dir encoding is unaffected. No filter when cwd is falsy.
function _cwdMatch(metaCwd, cwd) {
  if (!cwd) return true;
  if (!metaCwd) return false;
  if (_samePath(metaCwd, cwd)) return true;
  const a = _tailSegs(metaCwd, 2);
  const b = _tailSegs(cwd, 2);
  if (a.length < 2 || b.length < 2) return false; // need parent+leaf to fall back
  return a[0] === b[0] && a[1] === b[1];
}

// List Antigravity (agy) CLI conversations for a given cwd, newest first.
//
// agy v1.0.5 (verified on a logged-in machine) splits a conversation across two
// places:
//   - ~/.gemini/antigravity-cli/history.jsonl — one JSON object per session
//     carrying { display (title), workspace (cwd), timestamp }. NOTE: the line
//     does NOT contain the conversation id.
//   - ~/.gemini/antigravity-cli/conversations/<id>.db — one SQLite file per
//     conversation; the FILENAME is the id `agy --conversation <id>` resumes.
//
// So the resumable id lives on the .db filename, the human metadata lives in
// history.jsonl, and nothing links the two explicitly. We pair them by recency
// rank (both newest-first): the newest history entry ↔ the newest .db, etc.
// This is correct for the common create-in-order case; resuming a much older
// session bumps its .db mtime and can mis-rank it, which only MISLABELS a row
// (never loses one or resumes a non-existent id). If a future agy build does
// put an explicit id on the history line, it's honored directly (no pairing).
//
// Each entry is { sessionId (the .db id), title, cwd, mtime (epoch-ms) } — the
// shape SessionTreeDataProvider's agent-group builder consumes. Returns [] when
// neither history nor conversations exist (agy never run / not logged in). The
// `_file` / `_convDir` args are test-only injection; production passes cwd alone.
function listAntigravitySessions(cwd, _file, _convDir) {
  const baseDir = getAntigravityBaseDir(cwd);
  const file = _file || path.join(baseDir, 'history.jsonl');
  const convDir = _convDir || path.join(baseDir, 'conversations');

  // history.jsonl metadata (display / workspace / timestamp), in file order.
  const hist = [];
  try {
    const text = fs.readFileSync(file, 'utf-8');
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      let d;
      try { d = JSON.parse(s); } catch { continue; }
      if (!d || typeof d !== 'object') continue;
      hist.push({
        // Honor an explicit id if a future build adds one; else pair via .db.
        id: d.conversationId || d.conversation_id || d.id || null,
        display: d.display || d.title || d.summary || d.name || '',
        workspace: d.workspace || d.cwd || d.workspaceDir || d.workspace_dir || '',
        mtime: _antigravityTs(
          d.timestamp != null ? d.timestamp
            : (d.updatedAt != null ? d.updatedAt : d.updated_at)
        ),
      });
    }
  } catch { /* no history yet */ }

  // conversations/<id>.db — authoritative resumable ids (+ mtime fallback).
  let dbs = [];
  try {
    dbs = fs.readdirSync(convDir)
      .filter((f) => f.endsWith('.db'))
      .map((f) => {
        let mt = 0;
        try { mt = fs.statSync(path.join(convDir, f)).mtimeMs; } catch (_) {}
        return { id: f.slice(0, -3), mtime: mt };
      });
  } catch { /* no conversations dir */ }

  const out = [];
  // Explicit-id entries (future-proof) pair directly.
  const explicit = hist.filter((h) => h.id);
  for (const h of explicit) {
    out.push({ sessionId: h.id, title: h.display, cwd: h.workspace, mtime: h.mtime });
  }
  // Everything else pairs to a .db by recency rank.
  const usedIds = new Set(explicit.map((h) => h.id));
  const implicit = hist.filter((h) => !h.id).sort((a, b) => b.mtime - a.mtime);
  const freeDbs = dbs.filter((d) => !usedIds.has(d.id)).sort((a, b) => b.mtime - a.mtime);
  for (let i = 0; i < implicit.length && i < freeDbs.length; i++) {
    out.push({
      sessionId: freeDbs[i].id,
      title: implicit[i].display,
      cwd: implicit[i].workspace,
      mtime: implicit[i].mtime || freeDbs[i].mtime,
    });
  }

  let result = out.filter((s) => s.sessionId);
  if (cwd) result = result.filter((s) => _cwdMatch(s.cwd, cwd));
  result.sort((a, b) => b.mtime - a.mtime);
  return result;
}

// --- Codex (OpenAI) CLI sessions --------------------------------------------
//
// Codex stores each conversation as a rollout jsonl under date-sharded dirs:
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
// The resumable id (`codex resume <id>`) is the trailing UUID of the FILENAME;
// line 1 of every rollout is a `session_meta` record whose payload carries
// { id, cwd, timestamp, ... } (verified against codex-cli 0.137 on-disk data;
// the format is identical back to the 2026-03 builds). Session titles live
// OUTSIDE the rollout in ~/.codex/session_index.jsonl: { id, thread_name,
// updated_at } — paired by explicit id (unlike agy's rank pairing).
const CODEX_ROLLOUT_RE = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

// session_meta is always line 1, but it embeds base_instructions (observed up
// to ~22 KB) — read a 64 KB head so the first line is never truncated.
const CODEX_META_CHUNK = 65536;

function _codexSessionsDir(cwd) {
  return getCodexPaths(cwd).sessionsDir;
}

// Walk the date-sharded sessions tree (YYYY/MM/DD — the only layout codex
// writes), newest shard first so id lookups touch recent days early. Returns
// absolute rollout paths; [] when the tree doesn't exist (codex never run).
function _walkCodexRollouts(dir) {
  const out = [];
  let years;
  try { years = fs.readdirSync(dir).sort().reverse(); } catch { return out; }
  for (const y of years) {
    let months;
    try { months = fs.readdirSync(path.join(dir, y)).sort().reverse(); } catch { continue; }
    for (const m of months) {
      let days;
      try { days = fs.readdirSync(path.join(dir, y, m)).sort().reverse(); } catch { continue; }
      for (const d of days) {
        let files;
        try { files = fs.readdirSync(path.join(dir, y, m, d)); } catch { continue; }
        for (const f of files) {
          if (CODEX_ROLLOUT_RE.test(f)) out.push(path.join(dir, y, m, d, f));
        }
      }
    }
  }
  return out;
}

// Resolve a codex session id to its rollout jsonl path (or null). The filename
// embeds the id, so this is a directory walk + suffix match — no file reads.
function findCodexSessionPath(sessionId, _dir, cwd) {
  if (!sessionId) return null;
  const dir = _dir || _codexSessionsDir(cwd);
  const needle = String(sessionId).toLowerCase();
  for (const p of _walkCodexRollouts(dir)) {
    const m = p.match(CODEX_ROLLOUT_RE);
    if (m && m[1].toLowerCase() === needle) return p;
  }
  return null;
}

// List codex sessions for a cwd, newest first. For each rollout we read only
// the 64 KB head (session_meta is line 1) to get the recorded cwd, falling
// back to the head's first user_message for the title when session_index has
// no thread_name for the id. Entry shape matches the other agent lists:
// { sessionId, title, cwd, mtime }. The `_dir` / `_indexFile` args are
// test-only injection; production callers pass cwd alone.
// v3.21.4: first user message — the tree label when session_index.jsonl has no
// thread_name for the rollout. Project-scoped storage has no index file at all,
// so this is the ONLY auto-title source there.
//
// Two things were wrong before. The record shape: v3.21.2 taught the Reader
// about current Codex rollouts, where visible turns arrive as
// `event_msg.item_completed` carrying a `UserMessage` item, but this lookup was
// left on the legacy `event_msg.user_message` shape that current Codex never
// emits. And the window: it read a fixed 64 KB head, while `session_meta` alone
// is 18-40 KB and the developer-instruction `response_item` records after it
// push the first user turn past 64 KB in 28% of real rollouts (median 11.6 KB,
// p90 98.6 KB). Between them every un-renamed Codex session fell back to an
// 8-char id in the tree — 34 of 34 measured across both vaults.
//
// The window now widens progressively, and results are memoized: a session's
// FIRST user message never changes, so a hit is cached for the process and a
// miss is rechecked only once the file has grown. Without that,
// listCodexSessions — which runs on every tree refresh and on every reader poll
// while a fresh session is being discovered — would re-read up to 256 KB per
// rollout every time.
// v3.21.4: session_meta { cwd, id } read with a widening window. The record is
// always the rollout's first line, but it is not small — current Codex inlines
// the whole base_instructions prompt there (18-40 KB in the wild, and growing
// with every prompt revision). At a fixed 64 KB read, a session_meta line past
// that budget is truncated, fails JSON.parse, leaves cwd empty, and the session
// is then dropped by the cwd filter — the rollout disappears from the tree
// entirely rather than merely losing its title.
// Returns null when the file could not be read (as opposed to {} for "read,
// no session_meta"), so the cache below never remembers a transient failure.
function _codexSessionMeta(filePath, size) {
  for (const bytes of CODEX_TITLE_WINDOWS) {
    let head;
    try { head = _splitJsonLines(_readChunk(filePath, Math.min(bytes, size))); } catch { return null; }
    for (const d of head) {
      if (d && d.type === 'session_meta' && d.payload) {
        return { cwd: d.payload.cwd || '', id: d.payload.id || '' };
      }
    }
    if (size <= bytes) break;
  }
  return {};
}

// v3.24.1: memoized like the first user message below. session_meta is the
// rollout's first line and is never rewritten, so once found it holds for every
// later size of the file; a miss is retried only once the file has grown. It
// was read fresh on every call before — 64-256 KB per rollout, every tree
// refresh: 0.6 s per refresh for 81 rollouts (1.8 s cold), synchronously on
// the extension host thread.
const _codexMetaCache = new Map(); // path -> { size, meta, found }

function _codexSessionMetaCached(filePath, size) {
  const cached = _codexMetaCache.get(filePath);
  if (cached && (cached.found ? size >= cached.size : size === cached.size)) return cached.meta;
  const meta = _codexSessionMeta(filePath, size);
  if (!meta) return {}; // unreadable right now (locked by a scanner, mid-rename): ask again next time
  _codexMetaCache.set(filePath, { size, meta, found: 'cwd' in meta });
  return meta;
}

const CODEX_TITLE_WINDOWS = [CODEX_META_CHUNK, 256 * 1024];
const _codexTitleCache = new Map(); // path -> { size, title }

function _codexFirstUserMessageAt(filePath, bytes) {
  for (const d of _splitJsonLines(_readChunk(filePath, bytes))) {
    if (!d || d.type !== 'event_msg' || !d.payload) continue;
    let text = '';
    if (d.payload.type === 'item_completed' && d.payload.item
        && d.payload.item.type === 'UserMessage') {
      text = _codexCompletedItemText(d.payload.item);
    } else if (d.payload.type === 'user_message' && typeof d.payload.message === 'string') {
      text = d.payload.message;
    } else {
      continue;
    }
    const line = text.trim().split('\n')[0].trim();
    if (line) return line;
  }
  return '';
}

function _codexFirstUserMessage(filePath, size) {
  const cached = _codexTitleCache.get(filePath);
  // A found title is immutable; an empty one only needs rechecking once the
  // rollout has grown past the window we already scanned.
  if (cached && (cached.title || cached.size === size)) return cached.title;
  let title = '';
  try {
    for (const bytes of CODEX_TITLE_WINDOWS) {
      title = _codexFirstUserMessageAt(filePath, Math.min(bytes, size));
      if (title || size <= bytes) break;
    }
  } catch { return ''; }
  _codexTitleCache.set(filePath, { size, title });
  return title;
}

function listCodexSessions(cwd, _dir, _indexFile) {
  const codexPaths = getCodexPaths(cwd);
  const dir = _dir || codexPaths.sessionsDir;
  const indexFile = _indexFile || codexPaths.indexFile;

  // id → thread_name from session_index.jsonl (last write wins).
  const titles = new Map();
  try {
    const text = fs.readFileSync(indexFile, 'utf-8');
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      let d;
      try { d = JSON.parse(s); } catch { continue; }
      if (d && d.id && typeof d.thread_name === 'string' && d.thread_name.trim()) {
        titles.set(String(d.id).toLowerCase(), d.thread_name.trim());
      }
    }
  } catch { /* no index yet */ }

  const out = [];
  for (const p of _walkCodexRollouts(dir)) {
    const m = p.match(CODEX_ROLLOUT_RE);
    if (!m) continue;
    let stat;
    try { stat = fs.statSync(p); } catch { continue; }
    const meta = _codexSessionMetaCached(p, stat.size);
    const metaCwd = meta.cwd;
    const metaId = meta.id || m[1];
    const firstMsg = _codexFirstUserMessage(p, stat.size);
    out.push({
      sessionId: metaId,
      title: titles.get(String(metaId).toLowerCase()) || firstMsg || '',
      cwd: metaCwd,
      mtime: stat.mtimeMs,
    });
  }

  let result = out;
  if (cwd) result = result.filter((s) => _cwdMatch(s.cwd, cwd));
  result.sort((a, b) => b.mtime - a.mtime);
  return result;
}

// --- Grok (xAI) CLI sessions -------------------------------------------------
//
// Grok stores sessions under:
//   ~/.grok/sessions/<url-encoded-cwd>/<session-id>/
// with summary.json metadata and updates.jsonl ACP updates. GROK_HOME overrides
// the ~/.grok base. Resume is `grok --resume <session-id>`; `grok --resume`
// without an id resumes the most recent session for the current cwd.

function _grokSessionsDir(cwd) {
  return getGrokPaths(cwd).sessionsDir;
}

function _readGrokSummary(sessionDir) {
  try {
    const p = path.join(sessionDir, 'summary.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function _walkGrokSessionDirs(dir) {
  const out = [];
  let groups;
  try { groups = fs.readdirSync(dir); } catch { return out; }
  for (const g of groups) {
    const groupDir = path.join(dir, g);
    let groupStat;
    try { groupStat = fs.statSync(groupDir); } catch { continue; }
    if (!groupStat.isDirectory()) continue;
    let children;
    try { children = fs.readdirSync(groupDir); } catch { continue; }
    for (const id of children) {
      const sessionDir = path.join(groupDir, id);
      let st;
      try { st = fs.statSync(sessionDir); } catch { continue; }
      if (!st.isDirectory()) continue;
      const updatesPath = path.join(sessionDir, 'updates.jsonl');
      const summaryPath = path.join(sessionDir, 'summary.json');
      if (fs.existsSync(updatesPath) || fs.existsSync(summaryPath)) out.push(sessionDir);
    }
  }
  return out;
}

function _grokSummaryInfo(summary) {
  return (summary && typeof summary === 'object' && summary.info && typeof summary.info === 'object')
    ? summary.info
    : (summary && typeof summary === 'object' ? summary : {});
}

function _grokTimestampMs(summary, updatesPath) {
  const info = _grokSummaryInfo(summary);
  const raw = info.updated_at || info.last_active_at || info.created_at
    || summary?.updated_at || summary?.last_active_at || summary?.created_at;
  const parsed = Date.parse(raw || '');
  if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  try { return fs.statSync(updatesPath).mtimeMs; } catch { return 0; }
}

function _grokFirstUserFromUpdates(updatesPath) {
  try {
    const head = _splitJsonLines(_readChunk(updatesPath, 65536));
    const msg = _extractGrokMessages(head).find((m) => m.role === 'user');
    return msg ? msg.text.trim().split('\n')[0].trim() : '';
  } catch {
    return '';
  }
}

function findGrokSessionPath(sessionId, _dir, cwd) {
  if (!sessionId) return null;
  const dir = _dir || _grokSessionsDir(cwd);
  const needle = String(sessionId);
  for (const sessionDir of _walkGrokSessionDirs(dir)) {
    if (path.basename(sessionDir) !== needle) continue;
    if (cwd) {
      const summary = _readGrokSummary(sessionDir);
      const info = _grokSummaryInfo(summary);
      if (!_cwdMatch(info.cwd || info.workingDirectory || info.workspace, cwd)) continue;
    }
    const updatesPath = path.join(sessionDir, 'updates.jsonl');
    return fs.existsSync(updatesPath) ? updatesPath : null;
  }
  return null;
}

// Sibling of updates.jsonl. Grok's events.jsonl is the turn-state authority
// (`turn_started` / `turn_ended` / phase_changed); the TUI keeps redrawing
// after a turn ends so PTY silence is not a reliable "done" signal.
function findGrokEventsPath(sessionId, _dir, cwd) {
  const updates = findGrokSessionPath(sessionId, _dir, cwd);
  if (!updates) return null;
  const events = path.join(path.dirname(updates), 'events.jsonl');
  return fs.existsSync(events) ? events : null;
}

function listGrokSessions(cwd, _dir) {
  const dir = _dir || _grokSessionsDir(cwd);
  const out = [];
  for (const sessionDir of _walkGrokSessionDirs(dir)) {
    const sessionId = path.basename(sessionDir);
    const updatesPath = path.join(sessionDir, 'updates.jsonl');
    const summary = _readGrokSummary(sessionDir);
    const info = _grokSummaryInfo(summary);
    const metaCwd = info.cwd || info.workingDirectory || info.workspace || '';
    if (cwd && !_cwdMatch(metaCwd, cwd)) continue;
    const title = info.generated_title || info.title || info.session_summary
      || summary?.generated_title || summary?.title || summary?.session_summary
      || (fs.existsSync(updatesPath) ? _grokFirstUserFromUpdates(updatesPath) : '');
    out.push({
      sessionId,
      title: title || '',
      cwd: metaCwd,
      mtime: _grokTimestampMs(summary, updatesPath),
    });
  }
  out.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return out;
}

// --- gjc (Gajae Code) CLI sessions ------------------------------------------
//
// gjc stores each conversation as a jsonl under a cwd-encoded directory:
//   <agentDir>/sessions/<encoded-cwd>/<ISO-timestamp>_<uuidv7>.jsonl
// (agentDir defaults to ~/.gjc/agent, overridable via GJC_CODING_AGENT_DIR.)
// Line 1 is a `{ type:"session", id, title?, timestamp, cwd }` header; later
// lines are `{ type:"message", message:{ role, content } }` plus other entry
// types (model_change, compaction, …). The encoded-cwd dir name is
// gjc-internal, so we read each file's header `cwd` and match it to the
// workspace (like codex) rather than reversing the encoding.
//
// The id the launcher tracks is the FILE STEM (`<ts>_<uuid>`), which uniquely
// names the transcript. Resume passes the absolute jsonl PATH to `gjc -r <path>`
// (gjc opens a path directly; only bare ids go through gjc's id resolver + the
// cross-project fork prompt), so the launcher never depends on gjc's internal
// id matching. A fresh `gjc` names its own file, so the panel discovers + pins
// the new stem the same way kiro/codex/grok do.
const GJC_META_CHUNK = 65536;

function _gjcSessionsDir(cwd) {
  return getGjcPaths(cwd).sessionsDir;
}

function _gjcStem(filePath) {
  return path.basename(filePath).replace(/\.jsonl$/i, '');
}

// Walk <sessionsDir>/<encoded-cwd>/*.jsonl. Empty/aborted gjc sessions leave an
// artifacts directory (`<stem>/`) with no sibling `<stem>.jsonl`; globbing only
// .jsonl files skips those cleanly. Returns absolute jsonl paths; [] when the
// tree doesn't exist (gjc never run for any cwd).
function _walkGjcSessionFiles(dir) {
  const out = [];
  let groups;
  try { groups = fs.readdirSync(dir); } catch { return out; }
  for (const g of groups) {
    const groupDir = path.join(dir, g);
    let groupStat;
    try { groupStat = fs.statSync(groupDir); } catch { continue; }
    if (!groupStat.isDirectory()) continue;
    let files;
    try { files = fs.readdirSync(groupDir); } catch { continue; }
    for (const f of files) {
      if (f.endsWith('.jsonl')) out.push(path.join(groupDir, f));
    }
  }
  return out;
}

// --- Chief REST REPL sessions ----------------------------------------------
//
// chief-repl writes launcher-owned session directories:
//   <chiefSessionsDir>/<launcher-session-id>/summary.json + updates.jsonl
// with one simple transcript row per visible turn:
//   { role: "user"|"assistant", text, timestamp }

function _chiefSessionsDir(cwd) {
  return getChiefPaths(cwd).sessionsDir;
}

function _readChiefSummary(sessionDir) {
  try {
    const p = path.join(sessionDir, 'summary.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function _walkChiefSessionDirs(dir) {
  const out = [];
  let ids;
  try { ids = fs.readdirSync(dir); } catch { return out; }
  for (const id of ids) {
    const sessionDir = path.join(dir, id);
    let st;
    try { st = fs.statSync(sessionDir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const updatesPath = path.join(sessionDir, 'updates.jsonl');
    const summaryPath = path.join(sessionDir, 'summary.json');
    if (fs.existsSync(updatesPath) || fs.existsSync(summaryPath)) out.push(sessionDir);
  }
  return out;
}

// First user prompt (single line) from a gjc head — title fallback when the
// header carries no title yet.
function _gjcFirstUserPrompt(head) {
  for (const d of head) {
    if (!d || d.type !== 'message' || !d.message || d.message.role !== 'user') continue;
    const c = d.message.content;
    if (typeof c === 'string') {
      const t = c.trim().split('\n')[0].trim();
      if (t) return t;
    } else if (Array.isArray(c)) {
      for (const b of c) {
        if (b && typeof b === 'object' && typeof b.text === 'string' && b.text.trim()) {
          return b.text.trim().split('\n')[0].trim();
        }
      }
    }
  }
  return '';
}

// List gjc sessions for a cwd, newest first. Reads only the 64 KB head of each
// jsonl (the header is line 1) for cwd + title. Entry shape matches the other
// agent lists: { sessionId, title, cwd, mtime }. `_dir` is test-only injection.
function listGjcSessions(cwd, _dir) {
  const dir = _dir || _gjcSessionsDir(cwd);
  const out = [];
  for (const p of _walkGjcSessionFiles(dir)) {
    let stat;
    try { stat = fs.statSync(p); } catch { continue; }
    let metaCwd = '';
    let title = '';
    let firstMsg = '';
    try {
      const head = _splitJsonLines(_readChunk(p, GJC_META_CHUNK));
      for (const d of head) {
        if (d && d.type === 'session') {
          if (typeof d.cwd === 'string') metaCwd = d.cwd;
          if (typeof d.title === 'string' && d.title.trim()) title = d.title.trim();
        }
      }
      if (!title) firstMsg = _gjcFirstUserPrompt(head);
    } catch { continue; }
    out.push({ sessionId: _gjcStem(p), title: title || firstMsg || '', cwd: metaCwd, mtime: stat.mtimeMs });
  }
  let result = out;
  if (cwd) result = result.filter((s) => _cwdMatch(s.cwd, cwd));
  result.sort((a, b) => b.mtime - a.mtime);
  return result;
}

// Resolve a gjc session id (the file stem) to its jsonl path (or null). The
// stem embeds a uuidv7 so it's globally unique — a directory walk + stem match,
// no header reads or cwd filter needed.
function findGjcSessionPath(sessionId, _dir, cwd) {
  if (!sessionId) return null;
  const dir = _dir || _gjcSessionsDir(cwd);
  const needle = String(sessionId);
  for (const p of _walkGjcSessionFiles(dir)) {
    if (_gjcStem(p) === needle) return p;
  }
  return null;
}

function _chiefSummaryInfo(summary) {
  return (summary && typeof summary === 'object' && summary.info && typeof summary.info === 'object')
    ? summary.info
    : (summary && typeof summary === 'object' ? summary : {});
}

function _chiefTimestampMs(summary, updatesPath) {
  const info = _chiefSummaryInfo(summary);
  const raw = info.updated_at || info.created_at || summary?.updated_at || summary?.created_at;
  const parsed = Date.parse(raw || '');
  if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  try { return fs.statSync(updatesPath).mtimeMs; } catch { return 0; }
}

function _chiefFirstUserFromUpdates(updatesPath) {
  try {
    const head = _splitJsonLines(_readChunk(updatesPath, 65536));
    const msg = _extractChiefMessages(head).find((m) => m.role === 'user');
    return msg ? msg.text.trim().split('\n')[0].trim() : '';
  } catch {
    return '';
  }
}

function findChiefSessionPath(sessionId, _dir, cwd) {
  if (!sessionId) return null;
  const dir = _dir || _chiefSessionsDir(cwd);
  return path.join(dir, String(sessionId), 'updates.jsonl');
}

function listChiefSessions(cwd, _dir) {
  const dir = _dir || _chiefSessionsDir(cwd);
  const out = [];
  for (const sessionDir of _walkChiefSessionDirs(dir)) {
    const sessionId = path.basename(sessionDir);
    const updatesPath = path.join(sessionDir, 'updates.jsonl');
    const summary = _readChiefSummary(sessionDir);
    const info = _chiefSummaryInfo(summary);
    const metaCwd = info.cwd || '';
    if (cwd && !_cwdMatch(metaCwd, cwd)) continue;
    const title = info.generated_title || info.title
      || summary?.generated_title || summary?.title
      || (fs.existsSync(updatesPath) ? _chiefFirstUserFromUpdates(updatesPath) : '');
    out.push({
      sessionId,
      title: title || '',
      cwd: metaCwd,
      mtime: _chiefTimestampMs(summary, updatesPath),
    });
  }
  out.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return out;
}

function getSessionJsonlPath(sessionId, cwd, agent) {
  // Phase 0: antigravity (agy) stores conversations as protobuf blobs inside a
  // SQLite db (~/.gemini/antigravity-cli/conversations/<id>.db), not jsonl — the
  // reader can't parse that yet, so resolve to no transcript (no reader pane).
  if (agent === 'antigravity') return null;
  if (agent === 'codex') {
    // Codex assigns its own session ids (the rollout filename's trailing UUID).
    // A Tree-resume carries the real id → exact rollout path, so the reader
    // works for resumed sessions. A fresh session's placeholder UUID never
    // matches a rollout on disk → null (no reader until kiro-style id-discovery
    // pinning lands in a later phase). No cwd-latest fallback on purpose — it
    // would bleed sibling sessions sharing the cwd into the reader (the exact
    // bug the kiro pinning work fixed).
    return findCodexSessionPath(sessionId, null, cwd);
  }
  if (agent === 'grok') {
    return findGrokSessionPath(sessionId, null, cwd);
  }
  if (agent === 'gjc') {
    // gjc assigns its own session ids (the file stem). A Tree-resume / pinned
    // fresh session carries the real stem → exact jsonl path; a fresh session's
    // placeholder UUID never matches a stem on disk → null (no reader until the
    // panel discovers + pins the real stem, mirroring codex/grok).
    return findGjcSessionPath(sessionId, null, cwd);
  }
  if (agent === 'chief') {
    return findChiefSessionPath(sessionId, null, cwd);
  }
  if (agent === 'kiro') {
    // Kiro auto-assigns its own session ids. Once we know the REAL id — a
    // Tree-resume, or a fresh session whose id the reader has discovered and
    // pinned back onto the entry — read THAT exact transcript. Reading
    // cwd-latest instead (the old behaviour) bled every other kiro session
    // sharing this cwd into the reader: open two kiro tabs in one folder and
    // both showed whichever session wrote most recently. Our placeholder
    // crypto.randomUUID()s never exist as <id>.jsonl on disk, so existsSync
    // cleanly tells a real kiro id from a not-yet-pinned placeholder.
    if (sessionId) {
      const direct = path.join(getKiroSessionsDir(cwd), `${sessionId}.jsonl`);
      if (fs.existsSync(direct)) return direct;
    }
    // Fresh session, real id not yet known → cwd-latest discovery (the reader
    // watch pins the real id as soon as kiro writes the transcript).
    return findLatestKiroSessionPath(cwd);
  }
  if (!sessionId) return null;
  if (!cwd) return null;
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

// v3.21.3: head + tail window used by extractAiTitle. `ai-title` is rewritten
// as a session grows and Claude Code appends the newest one, so the winning
// title sits within a few KB of EOF — measured across 504 real titled sessions
// the last ai-title is a median 4.3 KB from the end, p95 29.7 KB. A 64 KB tail
// covers every one of them. The head window catches the single shape a tail
// misses: a title written early on a session that then grew without ever being
// retitled (one file in 663), and gjc's `type:"session"` header, which is
// always line 1. Both chunks' truncated boundary lines fail JSON.parse and are
// dropped by _splitJsonLines, so a partial line can never produce a title.
const TITLE_HEAD_BYTES = 64 * 1024;
const TITLE_TAIL_BYTES = 64 * 1024;

function _readHeadTail(filePath, size, headBytes, tailBytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    if (size <= headBytes + tailBytes) {
      const buf = Buffer.alloc(size);
      const n = fs.readSync(fd, buf, 0, size, 0);
      return buf.toString('utf-8', 0, n);
    }
    const head = Buffer.alloc(headBytes);
    const hn = fs.readSync(fd, head, 0, headBytes, 0);
    const tail = Buffer.alloc(tailBytes);
    const tn = fs.readSync(fd, tail, 0, tailBytes, size - tailBytes);
    // The join newline keeps the head's trailing partial and the tail's leading
    // partial from fusing into one accidentally-parseable line.
    return head.toString('utf-8', 0, hn) + '\n' + tail.toString('utf-8', 0, tn);
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

// v3.24.1: incremental message cache. The reader (split pane and standalone)
// re-renders every time the session file it shows changes, and each render
// used to re-read and JSON.parse the WHOLE file — synchronously, on the
// extension host thread that also pumps every terminal's PTY output. Files
// over 2 MB were not even cached (v3.5.6, for memory), so a long session paid
// the full price on every poll while its agent was writing: 0.5 s per render
// at 25.7 MB, about 1 s at 47 MB, roughly once a second for a whole turn —
// every terminal stalls for that long each time.
//
// Agent transcripts are append-only, so an entry remembers how far into the
// file it has parsed and the next call reads only the bytes after that point.
// It keeps the extracted reader messages, not the parsed lines — the 25.7 MB
// session above reduces to 213 messages — so caching big files no longer
// costs the memory that made v3.5.6 stop caching them.
//
// Append-only is checked, not assumed. An entry keeps the file's first bytes
// and the bytes just before its offset, and both must still be on disk before
// it reads on; a file that is the same size with a new mtime was rewritten in
// place (nothing was appended), and a shrunk one was truncated. Any of those is
// parsed again from the start. The same two windows are compared again after
// reading, so a writer that replaces the file mid-read cannot leave a shifted
// parse that every later check would accept.
const _msgCache = new Map(); // `${kind}\0${filePath}` → entry
const _MSG_CACHE_MAX = 20; // ~max active sessions across both readers + the tree provider
const _MSG_READ_CHUNK = 4 * 1024 * 1024;
const _MSG_HEAD_BYTES = 4096;
const _MSG_PROBE_BYTES = 256;
const _MSG_KINDS = new Set(['kiro', 'codex', 'grok', 'gjc', 'chief']);

// Claude Code jsonls reach the reader as agent 'claude' or with no agent at
// all (the tree's turn count); both parse as claude.
function _messageKind(agent) {
  return _MSG_KINDS.has(agent) ? agent : 'claude';
}

function _newMessageEntry(kind) {
  return { kind, offset: 0, head: null, probe: null, acc: _newMessageAccumulator(kind), size: -1, mtimeMs: -1, lastUsed: 0 };
}

function _readMessagesIncremental(filePath, agent) {
  const kind = _messageKind(agent);
  let stat;
  try { stat = fs.statSync(filePath); } catch { return null; }
  const key = kind + '\0' + filePath;
  const cached = _msgCache.get(key);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    cached.lastUsed = Date.now();
    return cached;
  }
  let fd;
  let e = null;
  let consistent = false;
  try {
    fd = fs.openSync(filePath, 'r');
    // Size and mtime of the file actually open, not of whatever the path
    // named a moment ago.
    const st = fs.fstatSync(fd);
    if (cached && _isAppendOf(fd, cached, st)) {
      e = cached;
      consistent = _consumeAppended(fd, e, st.size);
    }
    if (!consistent) {
      e = _newMessageEntry(kind);
      consistent = _consumeAppended(fd, e, st.size);
    }
    e.size = st.size;
    e.mtimeMs = st.mtimeMs;
  } catch {
    _msgCache.delete(key);
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
  if (!consistent) {
    // Still being replaced while it was read: answer from this parse, but
    // don't keep it — the next call starts over.
    _msgCache.delete(key);
    return e;
  }
  e.lastUsed = Date.now();
  if (!_msgCache.has(key) && _msgCache.size >= _MSG_CACHE_MAX) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, v] of _msgCache) {
      if (v.lastUsed < oldestTime) { oldestTime = v.lastUsed; oldestKey = k; }
    }
    if (oldestKey) _msgCache.delete(oldestKey);
  }
  _msgCache.set(key, e);
  return e;
}

// True when the open file is the one the entry parsed, with only bytes added.
function _isAppendOf(fd, e, st) {
  if (st.size < e.offset) return false;
  if (st.size === e.size && st.mtimeMs !== e.mtimeMs) return false;
  return _bytesAt(fd, e.head, 0) && _bytesAt(fd, e.probe, e.offset - (e.probe ? e.probe.length : 0));
}

function _bytesAt(fd, bytes, pos) {
  if (!bytes || bytes.length === 0) return true;
  const buf = Buffer.alloc(bytes.length);
  const n = fs.readSync(fd, buf, 0, buf.length, pos);
  return n === buf.length && buf.equals(bytes);
}

// Parse every complete line between e.offset and `size`, advancing e.offset
// past each one. Lines are split on the raw 0x0A byte before decoding, so a
// multi-byte character can never be cut by a chunk boundary. Returns false
// when the file no longer holds the bytes this pass parsed (replaced mid-read).
function _consumeAppended(fd, e, size) {
  const startOffset = e.offset;
  let pos = e.offset;
  let carry = null; // bytes of a line not yet terminated; starts at e.offset
  let head = null; // the file's first bytes, when this pass reads from 0
  let tail = null; // the last bytes this pass consumed
  while (pos < size) {
    const want = Math.min(_MSG_READ_CHUNK, size - pos);
    const buf = Buffer.allocUnsafe(want);
    const n = fs.readSync(fd, buf, 0, want, pos);
    if (n <= 0) break;
    if (pos === 0) head = Buffer.from(buf.subarray(0, Math.min(_MSG_HEAD_BYTES, n)));
    pos += n;
    const chunk = carry ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
    let start = 0;
    let nl;
    while ((nl = chunk.indexOf(10, start)) !== -1) {
      _pushJsonLine(e, chunk.toString('utf-8', start, nl));
      start = nl + 1;
    }
    if (start > 0) tail = Buffer.from(chunk.subarray(Math.max(0, start - _MSG_PROBE_BYTES), start));
    e.offset += start;
    carry = start < chunk.length ? chunk.subarray(start) : null;
  }
  // A last line without its newline counts once it parses: a record cut off
  // mid-write never does, and a writer that omits the final newline would
  // otherwise hide its newest message forever.
  if (carry && carry.length > 0 && _pushJsonLine(e, carry.toString('utf-8'))) {
    e.offset += carry.length;
    tail = Buffer.from(carry.subarray(Math.max(0, carry.length - _MSG_PROBE_BYTES)));
  }
  // A small append (one short line, a lone newline) would shrink the probe to
  // just its own bytes; extend it with the previous probe, which ends exactly
  // where this pass began.
  if (tail && tail.length < _MSG_PROBE_BYTES && e.probe && e.offset - tail.length === startOffset) {
    const joined = Buffer.concat([e.probe, tail]);
    tail = Buffer.from(joined.subarray(Math.max(0, joined.length - _MSG_PROBE_BYTES)));
  }
  if (head) e.head = head;
  if (tail) e.probe = tail;
  return _bytesAt(fd, e.head, 0) && _bytesAt(fd, e.probe, e.offset - (e.probe ? e.probe.length : 0));
}

// Returns false when the text is not a JSON line (blank, partial, corrupt) —
// those are skipped exactly as _splitJsonLines skips them.
function _pushJsonLine(e, text) {
  let d;
  try { d = JSON.parse(text); } catch { return false; }
  e.acc.push(d);
  return true;
}

// Test-only: clear the read caches so unit tests can observe fresh reads.
function _clearLineCache() {
  _msgCache.clear();
  _codexMetaCache.clear();
}

// Reader message extraction is written as accumulators — push one parsed line
// at a time, read the messages so far with result() — so the incremental cache
// above and the one-shot _extract*Messages(lines) helpers share one parser per
// agent. result() returns a fresh array: the cache keeps appending to its own.
function _newMessageAccumulator(kind) {
  if (kind === 'kiro') return _lineMapAccumulator(_kiroLineMessage);
  if (kind === 'codex') return _codexAccumulator();
  if (kind === 'grok') return _grokAccumulator();
  if (kind === 'gjc') return _lineMapAccumulator(_gjcLineMessage);
  if (kind === 'chief') return _lineMapAccumulator(_chiefLineMessage);
  return _lineMapAccumulator(_claudeLineMessage);
}

// For agents where each line maps to at most one message on its own.
function _lineMapAccumulator(lineToMessage) {
  const out = [];
  return {
    push(d) {
      const m = lineToMessage(d);
      if (m) out.push(m);
    },
    result() { return out.slice(); },
  };
}

function _extractWith(acc, lines) {
  for (const d of lines) acc.push(d);
  return acc.result();
}

// Kiro JSONL parser helper. Each line has: { version, kind, data: { ... } }
//   kind === 'Prompt'           → role 'user'
//   kind === 'AssistantMessage' → role 'assistant'
//   kind === 'ToolResults'      → skip
// Content blocks: { kind: 'text', data: '…' } and { kind: 'toolUse', data: {
//   name, input } }. An assistant turn that calls a tool is frequently just an
//   empty text block + a toolUse block — surfacing the toolUse keeps those
//   turns visible in the reader instead of dropping the whole message.
// Timestamp comes from data.meta?.timestamp.
function _kiroLineMessage(d) {
  const kind = d && d.kind;
  if (kind !== 'Prompt' && kind !== 'AssistantMessage') return null;
  const role = kind === 'Prompt' ? 'user' : 'assistant';
  const content = d.data && d.data.content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const c of content) {
    if (!c) continue;
    if (c.kind === 'text' && typeof c.data === 'string' && c.data.trim()) {
      parts.push(c.data);
    } else if (c.kind === 'toolUse' && c.data) {
      // Show the tool call (name + its stated purpose) so tool-only
      // assistant turns aren't invisible in the reader.
      const name = c.data.name || 'tool';
      const purpose = c.data.input && c.data.input.__tool_use_purpose;
      parts.push(purpose ? '`🔧 ' + name + '` — ' + purpose : '`🔧 ' + name + '`');
    }
  }
  if (parts.length === 0) return null;
  const timestamp = (d.data && d.data.meta && d.data.meta.timestamp) || null;
  return { role, text: parts.join('\n\n'), timestamp };
}

function _extractKiroMessages(lines) {
  return _extractWith(_lineMapAccumulator(_kiroLineMessage), lines);
}

// Codex JSONL parser helper. Rollout records are { timestamp, type, payload }.
// The conversation also surfaces as response_item records, but role=user there
// includes injected AGENTS.md / environment context, so the reader intentionally
// consumes only clean event_msg turns.
//
// Codex App builds switched the clean event shape in August 2026:
//   legacy: payload.type = user_message | agent_message, payload.message
//   current: payload.type = item_completed, payload.item.type =
//            UserMessage | AgentMessage, payload.item.content[]
// Prefer the current shape whenever conversational completed items are present;
// this prevents duplicate turns in transitional rollouts that contain both.
function _codexCompletedItemText(item) {
  if (!item) return '';
  const content = Array.isArray(item.content) ? item.content : [item.content];
  const parts = [];
  for (const c of content) {
    if (typeof c === 'string' && c.trim()) {
      parts.push(c);
    } else if (c && typeof c.text === 'string' && c.text.trim()) {
      parts.push(c.text);
    }
  }
  return parts.join('\n\n');
}

// Both shapes are collected side by side because whether the current one is
// present is a property of the whole file: one completed turn anywhere means
// the legacy records are duplicates.
function _codexAccumulator() {
  const completed = [];
  const legacy = [];
  let hasCompletedTurns = false;
  return {
    push(d) {
      if (!d || d.type !== 'event_msg' || !d.payload) return;
      const p = d.payload;
      if (p.type === 'item_completed' && p.item) {
        const item = p.item;
        const role = item.type === 'UserMessage' ? 'user'
          : item.type === 'AgentMessage' ? 'assistant' : null;
        if (!role) return;
        hasCompletedTurns = true;
        const text = _codexCompletedItemText(item);
        if (text.trim()) completed.push({ role, text, timestamp: d.timestamp || null });
      } else if (p.type === 'user_message' || p.type === 'agent_message') {
        const text = typeof p.message === 'string' ? p.message : '';
        if (!text.trim()) return;
        legacy.push({
          role: p.type === 'user_message' ? 'user' : 'assistant',
          text,
          timestamp: d.timestamp || null,
        });
      }
    },
    result() { return (hasCompletedTurns ? completed : legacy).slice(); },
  };
}

function _extractCodexMessages(lines) {
  return _extractWith(_codexAccumulator(), lines);
}

// Grok updates.jsonl parser helper. ACP update lines carry
// { params: { update: { sessionUpdate, content: { text } } } }. The same file
// also includes thoughts and hook/tool events; the reader surfaces only visible
// dialogue chunks, preserving their order.
// The run of same-role chunks still being written is kept open between pushes
// and shown as the last message, the same as the one-shot flush at the end.
function _grokAccumulator() {
  const out = [];
  let currentRole = null;
  let currentText = '';
  let currentTs = null;

  const flush = () => {
    if (currentRole && currentText.trim()) {
      out.push({ role: currentRole, text: currentText, timestamp: currentTs });
    }
    currentRole = null;
    currentText = '';
    currentTs = null;
  };

  return {
    push(d) {
      const update = d?.params?.update || d?.update || {};
      const kind = update.sessionUpdate || update.type || '';
      let role = null;
      if (kind === 'user_message_chunk') role = 'user';
      else if (kind === 'agent_message_chunk' || kind === 'assistant_message_chunk') role = 'assistant';
      else return;

      const text = update.content?.text ?? update.text ?? update.chunk ?? '';
      if (typeof text !== 'string' || !text) return;
      if (currentRole && currentRole !== role) flush();
      if (!currentRole) {
        currentRole = role;
        const meta = (d.params && d.params._meta) || d._meta || update._meta || {};
        currentTs = meta.agentTimestampMs
          || _toEpochMs(d.timestamp || update.timestamp || update.created_at)
          || null;
        if (currentTs === 0) currentTs = null;
      }
      currentText += text;
    },
    result() {
      const res = out.slice();
      if (currentRole && currentText.trim()) {
        res.push({ role: currentRole, text: currentText, timestamp: currentTs });
      }
      return res;
    },
  };
}

function _extractGrokMessages(lines) {
  return _extractWith(_grokAccumulator(), lines);
}

// gjc JSONL parser helper. Line 1 is a `{ type:"session" }` header; dialogue
// lines are `{ type:"message", message:{ role, content } }` where content is a
// string OR an array of blocks (text blocks carry a `.text` string; tool_use /
// thinking / image blocks are dropped — matching the claude extractor). Only
// user + assistant turns surface; other roles and non-message entries (model
// changes, compaction, custom messages) are skipped.
function _gjcLineMessage(d) {
  if (!d || d.type !== 'message' || !d.message) return null;
  const role = d.message.role;
  if (role !== 'user' && role !== 'assistant') return null;
  const content = d.message.content;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const parts = [];
    for (const blk of content) {
      if (blk && typeof blk === 'object' && typeof blk.text === 'string' && blk.text.trim()) {
        parts.push(blk.text);
      }
    }
    text = parts.join('\n\n');
  }
  if (!text.trim()) return null;
  return { role, text, timestamp: d.timestamp || null };
}

function _extractGjcMessages(lines) {
  return _extractWith(_lineMapAccumulator(_gjcLineMessage), lines);
}

function _chiefLineMessage(d) {
  if (!d || (d.role !== 'user' && d.role !== 'assistant')) return null;
  const text = typeof d.text === 'string' ? d.text : '';
  if (!text.trim()) return null;
  return { role: d.role, text, timestamp: d.timestamp || null };
}

function _extractChiefMessages(lines) {
  return _extractWith(_lineMapAccumulator(_chiefLineMessage), lines);
}

// Latest `ai-title` line wins — Claude Code rewrites the title as a session grows.
// Kiro, codex, grok, and chief sessions have no title line in the jsonl; return null
// for them (their titles come from per-agent metadata/list helpers). gjc keeps
// its (auto/user) title on the session header line, so it's read from there.
// v3.21.3: reads a 64 KB head + 64 KB tail window instead of the whole file.
// This is the tree's hot path — _loadSessions calls it on up to 130 jsonls per
// refresh, synchronously, on the extension host thread. Whole-file scanning
// measured 4.5 s for 130 files (259 MB read + JSON.parsed) on iloom-workspace,
// long enough to stall PTY output and make the entire launcher look frozen.
// The windowed read brings the same 130 files to 0.42 s and was validated to
// return byte-identical titles on all 663 sessions across both vaults.
//
// v3.24.1: always the window. It used to answer from the reader's whole-file
// parse when one was cached (under 2 MB), so the same file could yield two
// titles depending on whether a reader had it open; the tree keeps whichever
// it saw first for a given size and mtime.
function extractAiTitle(filePath, agent) {
  if (agent === 'kiro' || agent === 'codex' || agent === 'grok' || agent === 'chief') return null;
  let stat;
  try { stat = fs.statSync(filePath); } catch { return null; }
  let lines;
  try {
    lines = _splitJsonLines(_readHeadTail(filePath, stat.size, TITLE_HEAD_BYTES, TITLE_TAIL_BYTES));
  } catch { return null; }
  if (agent === 'gjc') {
    let gjcTitle = null;
    for (const d of lines) {
      if (d && d.type === 'session' && typeof d.title === 'string' && d.title.trim()) {
        gjcTitle = d.title.trim(); // latest header wins (gjc rewrites it)
      }
    }
    return gjcTitle;
  }
  let title = null;
  for (const d of lines) {
    if (d && d.type === 'ai-title' && typeof d.aiTitle === 'string' && d.aiTitle.trim()) {
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

// One Claude Code line → reader message, or null.
function _claudeLineMessage(d) {
  if (!d || typeof d !== 'object' || d.isSidechain) return null;
  const ts = d.timestamp || null;
  if (d.type === 'assistant') {
    const content = d.message && d.message.content;
    if (!Array.isArray(content)) return null;
    const parts = [];
    for (const blk of content) {
      if (blk && blk.type === 'text' && typeof blk.text === 'string' && blk.text.trim()) {
        parts.push(blk.text);
      }
    }
    if (parts.length === 0) return null;
    return { role: 'assistant', text: parts.join('\n\n'), timestamp: ts };
  }
  if (d.type === 'user' && !d.isMeta) {
    const msg = d.message;
    if (!msg || msg.role !== 'user') return null;
    if (typeof msg.content !== 'string') return null;
    const t = msg.content;
    if (SYS_TAG_RE.test(t)) return null;
    if (!t.trim()) return null;
    return { role: 'user', text: t, timestamp: ts };
  }
  return null;
}

function extractMessages(filePath, agent) {
  const e = _readMessagesIncremental(filePath, agent);
  return e ? e.acc.result() : [];
}

// User + assistant turn count — the length of extractMessages(), so the number
// on the metadata row equals the rendered reader transcript length.
function extractMessageCount(filePath, agent) {
  const e = _readMessagesIncremental(filePath, agent);
  return e ? e.acc.result().length : 0;
}

module.exports = {
  getSessionJsonlPath,
  findLatestKiroSessionPath,
  listKiroSessions,
  listAntigravitySessions,
  listCodexSessions,
  findCodexSessionPath,
  listGrokSessions,
  findGrokSessionPath,
  findGrokEventsPath,
  _toEpochMs,
  listGjcSessions,
  findGjcSessionPath,
  listChiefSessions,
  findChiefSessionPath,
  extractAiTitle,
  extractFirstUserMessage,
  extractMessages,
  extractMessageCount,
  _extractChiefMessages,
  _clearLineCache,
};
