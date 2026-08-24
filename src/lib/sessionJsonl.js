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
    let metaCwd = '';
    let metaId = m[1];
    let firstMsg = '';
    try {
      const head = _splitJsonLines(_readChunk(p, CODEX_META_CHUNK));
      for (const d of head) {
        if (d && d.type === 'session_meta' && d.payload) {
          if (d.payload.cwd) metaCwd = d.payload.cwd;
          if (d.payload.id) metaId = d.payload.id;
        } else if (!firstMsg && d && d.type === 'event_msg' && d.payload
                   && d.payload.type === 'user_message' && typeof d.payload.message === 'string') {
          firstMsg = d.payload.message.trim().split('\n')[0].trim();
        }
      }
    } catch { continue; }
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

// Kiro JSONL parser helper. Each line has: { version, kind, data: { ... } }
//   kind === 'Prompt'           → role 'user'
//   kind === 'AssistantMessage' → role 'assistant'
//   kind === 'ToolResults'      → skip
// Content blocks: { kind: 'text', data: '…' } and { kind: 'toolUse', data: {
//   name, input } }. An assistant turn that calls a tool is frequently just an
//   empty text block + a toolUse block — surfacing the toolUse keeps those
//   turns visible in the reader instead of dropping the whole message.
// Timestamp comes from data.meta?.timestamp.
function _extractKiroMessages(lines) {
  const out = [];
  for (const d of lines) {
    const kind = d && d.kind;
    if (kind !== 'Prompt' && kind !== 'AssistantMessage') continue;
    const role = kind === 'Prompt' ? 'user' : 'assistant';
    const content = d.data && d.data.content;
    if (!Array.isArray(content)) continue;
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
    if (parts.length === 0) continue;
    const timestamp = (d.data && d.data.meta && d.data.meta.timestamp) || null;
    out.push({ role, text: parts.join('\n\n'), timestamp });
  }
  return out;
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

function _extractCodexMessages(lines) {
  const out = [];
  const hasCompletedTurns = lines.some((d) => {
    const item = d && d.type === 'event_msg' && d.payload
      && d.payload.type === 'item_completed' && d.payload.item;
    return item && (item.type === 'UserMessage' || item.type === 'AgentMessage');
  });

  for (const d of lines) {
    if (!d || d.type !== 'event_msg' || !d.payload) continue;
    let role = null;
    let text = '';

    if (hasCompletedTurns) {
      if (d.payload.type !== 'item_completed' || !d.payload.item) continue;
      const item = d.payload.item;
      if (item.type === 'UserMessage') role = 'user';
      else if (item.type === 'AgentMessage') role = 'assistant';
      else continue;
      text = _codexCompletedItemText(item);
    } else {
      const pt = d.payload.type;
      if (pt !== 'user_message' && pt !== 'agent_message') continue;
      role = pt === 'user_message' ? 'user' : 'assistant';
      text = typeof d.payload.message === 'string' ? d.payload.message : '';
    }

    if (!text.trim()) continue;
    out.push({
      role,
      text,
      timestamp: d.timestamp || null,
    });
  }
  return out;
}

// Grok updates.jsonl parser helper. ACP update lines carry
// { params: { update: { sessionUpdate, content: { text } } } }. The same file
// also includes thoughts and hook/tool events; the reader surfaces only visible
// dialogue chunks, preserving their order.
function _extractGrokMessages(lines) {
  const out = [];
  let currentRole = null;
  let currentText = '';
  let currentTs = null;

  const flush = () => {
    if (!currentRole || !currentText.trim()) {
      currentRole = null;
      currentText = '';
      currentTs = null;
      return;
    }
    out.push({ role: currentRole, text: currentText, timestamp: currentTs });
    currentRole = null;
    currentText = '';
    currentTs = null;
  };

  for (const d of lines) {
    const update = d?.params?.update || d?.update || {};
    const kind = update.sessionUpdate || update.type || '';
    let role = null;
    if (kind === 'user_message_chunk') role = 'user';
    else if (kind === 'agent_message_chunk' || kind === 'assistant_message_chunk') role = 'assistant';
    else continue;

    const text = update.content?.text ?? update.text ?? update.chunk ?? '';
    if (typeof text !== 'string' || !text) continue;
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
  }
  flush();
  return out;
}

// gjc JSONL parser helper. Line 1 is a `{ type:"session" }` header; dialogue
// lines are `{ type:"message", message:{ role, content } }` where content is a
// string OR an array of blocks (text blocks carry a `.text` string; tool_use /
// thinking / image blocks are dropped — matching the claude extractor). Only
// user + assistant turns surface; other roles and non-message entries (model
// changes, compaction, custom messages) are skipped.
function _extractGjcMessages(lines) {
  const out = [];
  for (const d of lines) {
    if (!d || d.type !== 'message' || !d.message) continue;
    const role = d.message.role;
    if (role !== 'user' && role !== 'assistant') continue;
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
    if (!text.trim()) continue;
    out.push({ role, text, timestamp: d.timestamp || null });
  }
  return out;
}

function _extractChiefMessages(lines) {
  const out = [];
  for (const d of lines) {
    if (!d || (d.role !== 'user' && d.role !== 'assistant')) continue;
    const text = typeof d.text === 'string' ? d.text : '';
    if (!text.trim()) continue;
    out.push({ role: d.role, text, timestamp: d.timestamp || null });
  }
  return out;
}

// Latest `ai-title` line wins — Claude Code rewrites the title as a session grows.
// Kiro, codex, grok, and chief sessions have no title line in the jsonl; return null
// for them (their titles come from per-agent metadata/list helpers). gjc keeps
// its (auto/user) title on the session header line, so it's read from there.
function extractAiTitle(filePath, agent) {
  if (agent === 'kiro' || agent === 'codex' || agent === 'grok' || agent === 'chief') return null;
  const lines = _readLinesCached(filePath);
  if (!lines) return null;
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

function extractMessages(filePath, agent) {
  const lines = _readLinesCached(filePath);
  if (!lines) return [];
  if (agent === 'kiro') return _extractKiroMessages(lines);
  if (agent === 'codex') return _extractCodexMessages(lines);
  if (agent === 'grok') return _extractGrokMessages(lines);
  if (agent === 'gjc') return _extractGjcMessages(lines);
  if (agent === 'chief') return _extractChiefMessages(lines);
  const out = [];
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
function extractMessageCount(filePath, agent) {
  const lines = _readLinesCached(filePath);
  if (!lines) return 0;
  if (agent === 'kiro') return _extractKiroMessages(lines).length;
  if (agent === 'codex') return _extractCodexMessages(lines).length;
  if (agent === 'grok') return _extractGrokMessages(lines).length;
  if (agent === 'gjc') return _extractGjcMessages(lines).length;
  if (agent === 'chief') return _extractChiefMessages(lines).length;
  let n = 0;
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
