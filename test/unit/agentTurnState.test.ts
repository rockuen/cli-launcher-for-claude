// Turn-state gate: "is the agent still mid-turn?" read from the transcript.
//
// Regression cover for v3.20.9 — Kiro panels fired a completion notification
// several times inside one turn because PTY silence was treated as "done".

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  WORKING,
  COMPLETE,
  TAIL_BYTES,
  kiroTurnStateFromRecords,
  grokTurnStateFromRecords,
  readAgentTurnState,
  _clearTurnStateCache,
} = require(path.join(process.cwd(), 'src/lib/agentTurnState'));

const prompt = () => ({ kind: 'Prompt', data: { content: [{ kind: 'text', data: 'do it' }] } });
const toolResults = () => ({ kind: 'ToolResults', data: { content: [{ kind: 'toolResult' }] } });
const assistantToolUse = (name = 'read') => ({
  kind: 'AssistantMessage',
  data: { content: [{ kind: 'text', data: 'looking' }, { kind: 'toolUse', data: { name } }] },
});
const assistantFinal = () => ({
  kind: 'AssistantMessage',
  data: { content: [{ kind: 'text', data: 'all done' }] },
});

test('a just-submitted prompt is mid-turn (model call in flight)', () => {
  assert.equal(kiroTurnStateFromRecords([assistantFinal(), prompt()]), WORKING);
});

test('a pending toolUse is mid-turn (tool executing, TUI silent)', () => {
  assert.equal(kiroTurnStateFromRecords([prompt(), assistantToolUse('shell')]), WORKING);
});

test('a fresh tool result is mid-turn (model resumes next)', () => {
  assert.equal(
    kiroTurnStateFromRecords([prompt(), assistantToolUse(), toolResults()]),
    WORKING,
  );
});

test('a text-only assistant message ends the turn', () => {
  assert.equal(
    kiroTurnStateFromRecords([prompt(), assistantToolUse(), toolResults(), assistantFinal()]),
    COMPLETE,
  );
});

test('a full multi-tool turn reports complete only on its last record', () => {
  const turn = [
    prompt(),
    assistantToolUse('read'), toolResults(),
    assistantToolUse('grep'), toolResults(),
    assistantToolUse('shell'), toolResults(),
    assistantFinal(),
  ];
  assert.equal(kiroTurnStateFromRecords(turn), COMPLETE);
  for (let cut = 1; cut < turn.length; cut++) {
    assert.equal(kiroTurnStateFromRecords(turn.slice(0, cut)), WORKING, 'cut at ' + cut);
  }
});

test('unrecognized records are skipped; nothing recognizable is "unknown", not "done"', () => {
  assert.equal(kiroTurnStateFromRecords([assistantFinal(), { kind: 'SomethingNew' }]), COMPLETE);
  assert.equal(kiroTurnStateFromRecords([{ kind: 'SomethingNew' }, { foo: 1 }]), null);
  assert.equal(kiroTurnStateFromRecords([]), null);
  assert.equal(kiroTurnStateFromRecords(null), null);
  // Malformed assistant record → unknown, so the caller keeps its old behavior.
  assert.equal(kiroTurnStateFromRecords([{ kind: 'AssistantMessage', data: {} }]), null);
});

function writeTranscript(records: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-turn-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return file;
}

test('readAgentTurnState reads the transcript tail and reports mtime', () => {
  _clearTurnStateCache();
  const file = writeTranscript([prompt(), assistantToolUse('shell')]);
  const res = readAgentTurnState('kiro', file);
  assert.equal(res.state, WORKING);
  assert.equal(typeof res.mtimeMs, 'number');

  fs.appendFileSync(file, JSON.stringify(assistantFinal()) + '\n', 'utf8');
  assert.equal(readAgentTurnState('kiro', file).state, COMPLETE);
});

test('a final record larger than the first tail window still resolves', () => {
  _clearTurnStateCache();
  const huge = {
    kind: 'ToolResults',
    data: { content: [{ kind: 'toolResult', data: 'x'.repeat(TAIL_BYTES + 50_000) }] },
  };
  const file = writeTranscript([prompt(), assistantToolUse(), huge]);
  assert.equal(readAgentTurnState('kiro', file).state, WORKING);
});

test('the gate is inert for other agents and for missing transcripts', () => {
  _clearTurnStateCache();
  const file = writeTranscript([prompt()]);
  assert.equal(readAgentTurnState('claude', file).state, null);
  assert.equal(readAgentTurnState('kiro', null).state, null);
  assert.equal(readAgentTurnState('kiro', path.join(os.tmpdir(), 'no-such-kiro-session.jsonl')).state, null);
});

const grokTurnEnded = () => ({ ts: '2026-08-21T03:02:44.997Z', type: 'turn_ended', outcome: 'completed' });
const grokTurnStarted = () => ({ ts: '2026-08-21T02:20:12.409Z', type: 'turn_started', turn_number: 0 });
const grokStreaming = () => ({ ts: '2026-08-21T02:20:15.522Z', type: 'phase_changed', phase: 'streaming_text' });
const grokTool = () => ({ ts: '2026-08-21T02:20:20.000Z', type: 'tool_started' });
const grokMcp = () => ({ ts: '2026-08-21T02:20:00.525Z', type: 'mcp_server_connected' });

test('grok turn_ended is complete even if MCP noise follows in reverse scan', () => {
  assert.equal(grokTurnStateFromRecords([grokTurnStarted(), grokStreaming(), grokTurnEnded()]), COMPLETE);
  assert.equal(grokTurnStateFromRecords([grokTurnEnded(), grokMcp()]), COMPLETE);
});

test('grok turn_started / streaming / tool_started are mid-turn', () => {
  assert.equal(grokTurnStateFromRecords([grokTurnEnded(), grokTurnStarted()]), WORKING);
  assert.equal(grokTurnStateFromRecords([grokTurnStarted(), grokStreaming()]), WORKING);
  assert.equal(grokTurnStateFromRecords([grokTurnStarted(), grokTool()]), WORKING);
});

test('grok unrecognized tails are unknown, not done', () => {
  assert.equal(grokTurnStateFromRecords([grokMcp()]), null);
  assert.equal(grokTurnStateFromRecords([]), null);
  assert.equal(grokTurnStateFromRecords(null), null);
});

test('readAgentTurnState(grok) reads events.jsonl tails', () => {
  _clearTurnStateCache();
  const file = writeTranscript([grokTurnStarted(), grokStreaming()]);
  assert.equal(readAgentTurnState('grok', file).state, WORKING);
  fs.appendFileSync(file, JSON.stringify(grokTurnEnded()) + '\n', 'utf8');
  assert.equal(readAgentTurnState('grok', file).state, COMPLETE);
});

test('the panel gates its completion notification on the transcript', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/panel/createPanel.js'), 'utf8');
  const start = source.indexOf("if (entry.state !== 'running') return;");
  assert.notEqual(start, -1);
  const end = source.indexOf('showDesktopNotification(entry.title);', start);
  assert.notEqual(end, -1);
  const block = source.slice(start, end);

  // The gate must sit between "still running?" and the notification.
  assert.ok(block.includes('readAgentTurnState(entry.agent, resolveTurnStatePath())'));
  assert.ok(block.includes("turnGate.state === 'working'"));
  assert.ok(block.includes('TURN_GATE_MAX_STALE_MS'));
  assert.ok(block.includes('setTimeout(onOutputSettled, TURN_GATE_RECHECK_MS)'));
  // kiro + grok are the only agents that hit the transcript path.
  assert.ok(source.includes("entry.agent === 'kiro'"));
  assert.ok(source.includes('findGrokEventsPath'));
  assert.ok(source.includes('grokTurnComplete'));
});
