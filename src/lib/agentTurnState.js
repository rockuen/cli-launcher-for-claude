// @module lib/agentTurnState — "is the agent still mid-turn?" read from the
// session transcript, used to gate the panel's completion notification.
//
// WHY (v3.20.9): the panel decides a turn ended purely from PTY silence — 3s
// with no bytes after a >=7s run flips the tab to needs-attention and fires a
// desktop notification. Claude Code animates continuously while it works, so
// silence really does mean "done" there. Kiro's TUI does not: it goes quiet
// while a tool call runs (a long shell command, a big file read) and while it
// waits on the model between tool calls, so the panel announced "finished"
// repeatedly in the middle of a single turn and then went back to running when
// the next chunk arrived.
//
// The transcript is the authority for agents whose TUI cadence disagrees
// with "PTY silence = done":
//   kiro — TUI goes quiet WHILE a tool/model call is in flight (false done)
//   grok — TUI keeps redrawing AFTER the turn ends (false running)
//
// The transcript is the authority. kiro-cli appends records as the turn
// progresses (verified on kiro-cli 2.13 transcripts, ~/.kiro/sessions/cli):
//
//   {"kind":"Prompt","data":{...}}              user submitted
//   {"kind":"AssistantMessage","data":{"content":[{"kind":"thinking"},
//                                                 {"kind":"text"},
//                                                 {"kind":"toolUse","data":{"name":"read"}}]}}
//   {"kind":"ToolResults","data":{"content":[{"kind":"toolResult"}]}}
//   ... repeats per tool call ...
//   {"kind":"AssistantMessage","data":{"content":[{"kind":"text"}]}}   turn done
//
// So the LAST record tells us where we are: a Prompt or ToolResults means a
// model call is in flight, an AssistantMessage carrying a toolUse means a tool
// is executing, and an AssistantMessage with no toolUse is the final answer.
//
// Note kiro records in the wild carry no usable timestamp (data.meta.timestamp
// is absent), which is why the freshness bound in the caller uses file mtime.

const fs = require('fs');

const WORKING = 'working';
const COMPLETE = 'complete';

// Tail read sizes. A single ToolResults record can be huge (a 100KB+ file read
// or command dump), and a tail that lands mid-record yields no parseable line
// at all — so escalate once before giving up.
const TAIL_BYTES = 256 * 1024;
const TAIL_BYTES_MAX = 4 * 1024 * 1024;

const KIRO_KINDS = { Prompt: 1, AssistantMessage: 1, ToolResults: 1 };

// Grok events.jsonl: turn_ended is the only reliable "done". The TUI keeps
// redrawing a clock/spinner after the model finishes, so PTY silence never
// arrives and the tab would stay yellow without this. Phases and tool
// events mean a turn is still in flight.
const GROK_WORKING_PHASES = {
  waiting_for_model: 1,
  streaming_reasoning: 1,
  streaming_text: 1,
  tool_execution: 1,
  permission_prompt: 1,
};
const GROK_WORKING_TYPES = {
  turn_started: 1,
  loop_started: 1,
  first_token: 1,
  tool_started: 1,
};

// Pure: given kiro transcript records (oldest → newest), report whether the
// session is mid-turn. Returns null when the records carry no recognizable
// kind — the caller then leaves the existing PTY-silence behavior alone rather
// than guessing.
function kiroTurnStateFromRecords(records) {
  if (!Array.isArray(records)) return null;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    const kind = r && r.kind;
    if (!kind || !KIRO_KINDS[kind]) continue;
    if (kind === 'Prompt') return WORKING;      // model call in flight
    if (kind === 'ToolResults') return WORKING; // tool returned, model resumes
    const content = r.data && r.data.content;
    if (!Array.isArray(content)) return null;
    for (let j = 0; j < content.length; j++) {
      const c = content[j];
      if (c && c.kind === 'toolUse') return WORKING; // tool executing
    }
    return COMPLETE;                            // final answer, no pending tool
  }
  return null;
}

// Pure: given grok events.jsonl records (oldest → newest), report whether
// the session is mid-turn. Returns null when nothing recognizable is in the
// tail so the caller keeps PTY-silence behavior.
function grokTurnStateFromRecords(records) {
  if (!Array.isArray(records)) return null;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (!r || !r.type) continue;
    if (r.type === 'turn_ended') return COMPLETE;
    if (GROK_WORKING_TYPES[r.type]) return WORKING;
    if (r.type === 'phase_changed' && GROK_WORKING_PHASES[r.phase]) return WORKING;
  }
  return null;
}

function _parseLines(text) {
  const out = [];
  if (!text) return out;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) {}
  }
  return out;
}

function _readTail(filePath, bytes, size) {
  let fd;
  try {
    const start = Math.max(0, size - bytes);
    const len = size - start;
    if (len <= 0) return null;
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf-8', 0, n);
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

// Cache keyed on (path, mtime, size) — the gate re-checks every few seconds
// while a tool runs, and during exactly that window the file does not change.
const _cache = new Map();
const _CACHE_MAX = 20;

// Read the turn state for an agent transcript.
//   { state: 'working' | 'complete' | null, mtimeMs: number|null }
// state === null means "unknown" (missing/unreadable/unrecognized transcript).
function readAgentTurnState(agent, filePath) {
  if ((agent !== 'kiro' && agent !== 'grok') || !filePath) return { state: null, mtimeMs: null };
  let stat;
  try { stat = fs.statSync(filePath); } catch (_) { return { state: null, mtimeMs: null }; }
  if (!stat.isFile || !stat.isFile()) return { state: null, mtimeMs: null };
  const cached = _cache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { state: cached.state, mtimeMs: stat.mtimeMs };
  }
  let records = _parseLines(_readTail(filePath, TAIL_BYTES, stat.size));
  if (records.length === 0 && stat.size > TAIL_BYTES) {
    records = _parseLines(_readTail(filePath, TAIL_BYTES_MAX, stat.size));
  }
  const turn = agent === 'grok'
    ? grokTurnStateFromRecords(records)
    : kiroTurnStateFromRecords(records);
  if (_cache.size >= _CACHE_MAX) {
    const oldest = _cache.keys().next();
    if (!oldest.done) _cache.delete(oldest.value);
  }
  _cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, state: turn });
  return { state: turn, mtimeMs: stat.mtimeMs };
}

function _clearTurnStateCache() { _cache.clear(); }

module.exports = {
  WORKING,
  COMPLETE,
  TAIL_BYTES,
  kiroTurnStateFromRecords,
  grokTurnStateFromRecords,
  readAgentTurnState,
  _clearTurnStateCache,
};
