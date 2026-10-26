// v3.27.0 — Recent Sessions by period.
//
// Recent Sessions used to list only the 30 most recent Claude sessions; older
// ungrouped ones were not shown anywhere. They are now listed by period
// (Today, Yesterday, Previous 7 days, Previous 30 days, months, years), and the
// older ones are only stat'ed until their period is expanded.
//
// Covers the pure bucketing helper, then a real SessionTreeDataProvider over a
// fake ~/.claude/projects folder with a stub `vscode`.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Module from 'node:module';

/* eslint-disable @typescript-eslint/no-var-requires */
const { periodOf, bucketByPeriod, periodLabel } = require(path.join(process.cwd(), 'src/lib/sessionPeriods'));

const NAMES = { today: 'Today', yesterday: 'Yesterday', last7: 'Previous 7 days', last30: 'Previous 30 days' };
const DAY = 24 * 60 * 60 * 1000;
// A fixed "now": Monday 2026-10-26 14:00 local time.
const NOW = new Date(2026, 9, 26, 14, 0, 0).getTime();
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h, 0, 0).getTime();

// ---- pure helper ----

test('periodOf: day boundaries are local midnights', () => {
  assert.equal(periodOf(at(2026, 10, 26, 0) + 1, NOW).key, 'today');
  assert.equal(periodOf(NOW + DAY, NOW).key, 'today', 'a future mtime (clock skew) counts as today');
  assert.equal(periodOf(0, NOW).key, 'unknown', 'no timestamp is not "today"');
  assert.equal(periodOf(NaN, NOW).key, 'unknown');
  assert.equal(periodOf(at(2026, 10, 26, 0) - 1, NOW).key, 'yesterday');
  assert.equal(periodOf(at(2026, 10, 25, 0), NOW).key, 'yesterday');
  assert.equal(periodOf(at(2026, 10, 24, 23), NOW).key, 'last7');
  assert.equal(periodOf(at(2026, 10, 19, 0), NOW).key, 'last7');
  assert.equal(periodOf(at(2026, 10, 18, 23), NOW).key, 'last30');
  assert.equal(periodOf(at(2026, 9, 26, 0), NOW).key, 'last30');
  assert.equal(periodOf(at(2026, 9, 25, 23), NOW).key, 'm:2026-09');
  assert.equal(periodOf(at(2026, 5, 3), NOW).key, 'm:2026-05');
  assert.equal(periodOf(at(2025, 11, 30), NOW).key, 'm:2025-11', 'eleven months back is still a month');
  assert.equal(periodOf(at(2025, 10, 30), NOW).key, 'y:2025', 'twelve months back becomes a year');
  assert.equal(periodOf(at(2023, 1, 1), NOW).key, 'y:2023');
});

test('bucketByPeriod: newest bucket first, entries kept in order', () => {
  const entries = [
    { id: 'old', t: at(2026, 6, 1) },
    { id: 'now', t: NOW - 1000 },
    { id: 'sep', t: at(2026, 9, 2) },
    { id: 'y1', t: at(2026, 10, 25, 9) },
    { id: 'y2', t: at(2026, 10, 25, 8) },
    { id: 'jun2', t: at(2026, 6, 20) },
  ];
  entries.unshift({ id: 'nodate', t: 0 });
  const buckets = bucketByPeriod(entries, (e: any) => e.t, NOW);
  assert.deepEqual(buckets.map((b: any) => b.key), ['today', 'yesterday', 'm:2026-09', 'm:2026-06', 'unknown']);
  assert.deepEqual(buckets[1].entries.map((e: any) => e.id), ['y1', 'y2']);
  assert.deepEqual(buckets[3].entries.map((e: any) => e.id), ['old', 'jun2']);
});

test('periodLabel: fixed names, month names per locale, years', () => {
  assert.equal(periodLabel({ kind: 'last7' }, NAMES, 'en-US'), 'Previous 7 days');
  assert.equal(periodLabel({ kind: 'month', year: 2026, month: 9 }, NAMES, 'en-US'), 'September 2026');
  assert.equal(periodLabel({ kind: 'month', year: 2026, month: 9 }, NAMES, 'ko-KR'), '2026년 9월');
  assert.equal(periodLabel({ kind: 'year', year: 2024 }, NAMES, 'en-US'), '2024');
  assert.equal(periodLabel({ kind: 'unknown' }, { ...NAMES, unknown: '날짜 없음' }, 'ko-KR'), '날짜 없음');
});

test('7- and 30-day boundaries are calendar days (a daylight-saving change cannot shift them)', () => {
  // Whatever the local zone, the boundary is the local midnight N calendar days back.
  const n = new Date(NOW);
  const back = (d: number) => new Date(n.getFullYear(), n.getMonth(), n.getDate() - d).getTime();
  assert.equal(periodOf(back(7), NOW).key, 'last7');
  assert.equal(periodOf(back(7) - 1, NOW).key, 'last30');
  assert.equal(periodOf(back(30), NOW).key, 'last30');
  assert.equal(periodOf(back(30) - 1, NOW).key, 'm:2026-09');
});

// ---- the tree, over a fake Claude project folder ----

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'periods-'));
const wsDir = path.join(tmpRoot, 'ws');
fs.mkdirSync(wsDir);
const projDir = path.join(tmpRoot, '.claude', 'projects', wsDir.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(projDir, { recursive: true });

const realNow = Date.now();
type Fixture = { id: string; ageDays: number; title?: string; untitled?: boolean };
const fixtures: Fixture[] = [];
// 24 within the last 30 days, 16 older (months back), one of them untitled
for (let i = 0; i < 24; i++) fixtures.push({ id: `recent-${String(i).padStart(2, '0')}`, ageDays: i * 1.2 });
for (let i = 0; i < 16; i++) fixtures.push({ id: `older-${String(i).padStart(2, '0')}`, ageDays: 40 + i * 7 });
fixtures.find((f) => f.id === 'older-15')!.untitled = true;
// A grouped old session: listed in its group, never in Recent Sessions
fixtures.push({ id: 'grouped-old', ageDays: 90 });

for (const f of fixtures) {
  const file = path.join(projDir, `${f.id}.jsonl`);
  const lines = f.untitled
    ? [{ type: 'summary', summary: '' }]
    : [
      { type: 'user', message: { role: 'user', content: `first message of ${f.id}` } },
      { type: 'ai-title', aiTitle: `Title ${f.id}` },
    ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const mtime = new Date(realNow - f.ageDays * DAY);
  fs.utimesSync(file, mtime, mtime);
}
// A subagent transcript older Claude Code kept beside the sessions — never a session.
{
  const file = path.join(projDir, 'agent-a0348c1.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: 'Warmup' } }) + '\n');
  const mtime = new Date(realNow - 50 * DAY);
  fs.utimesSync(file, mtime, mtime);
}

const config: Record<string, any> = {};
class FakeTreeItem {
  label: any; collapsibleState: any; contextValue: any; description: any; tooltip: any; iconPath: any; command: any; resourceUri: any;
  constructor(label: any, collapsibleState: any) { this.label = label; this.collapsibleState = collapsibleState; }
}
const vscodeStub: any = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: wsDir } }],
    getConfiguration: () => ({ get: (k: string, d: any) => (k in config ? config[k] : d) }),
  },
  window: {},
  env: { language: 'en' },
  EventEmitter: class { event = () => {}; fire() {} },
  ThemeIcon: class { constructor(public id: string) {} },
  TreeItem: FakeTreeItem,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  DataTransferItem: class { constructor(public value: any) {} },
  Uri: { parse: (s: string) => ({ toString: () => s }), file: (p: string) => ({ fsPath: p }) },
};
const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, [request, ...rest]);
};
const origHome = process.env.HOME;
const origUserProfile = process.env.USERPROFILE;
process.env.HOME = tmpRoot;
process.env.USERPROFILE = tmpRoot;
const { sessionStoreUpdate, sessionStoreGet } = require('../../src/store/sessionStore');
const { SessionTreeDataProvider } = require('../../src/tree/SessionTreeDataProvider');
(Module as any)._load = origLoad;

sessionStoreUpdate('claudeSessionGroups', { Archive: ['grouped-old'] });

function recentOf(roots: any[]) {
  const recent = roots.find((n: any) => n.contextValue === 'recentGroup');
  assert.ok(recent, 'a Recent Sessions node');
  return recent;
}
const count = (label: string) => Number(/\((\d+)\)$/.exec(label)?.[1]);

test('Recent Sessions lists every ungrouped session by period, not just the 30 newest', () => {
  delete config['recentSessions.groupByPeriod'];
  const provider = new SessionTreeDataProvider({}, 'claude');
  const recent = recentOf(provider._buildGroups({}));
  const periods = recent._children;
  assert.ok(periods.every((p: any) => p._periodKey), 'children are period nodes');
  assert.equal(periods[0]._periodKey, 'today');
  const keys = periods.map((p: any) => p._periodKey);
  // Fixed periods come first, then months newest-first
  const monthKeys = keys.filter((k: string) => k.startsWith('m:') || k.startsWith('y:'));
  assert.deepEqual(monthKeys, [...monthKeys].sort().reverse());
  // 40 ungrouped sessions; the untitled one is not known yet, so it is counted
  assert.equal(count(recent.label), 40);
  assert.equal(periods.reduce((s: number, p: any) => s + count(p.label), 0), 40);
  // The newest 30 are built already; older ones wait for their period
  const lazy = periods.filter((p: any) => p._lazyFiles);
  assert.ok(lazy.length > 0, 'older periods are lazy');
  assert.ok(lazy.every((p: any) => p._children === undefined));
});

test('expanding an older period reads its titles then, and an untitled session drops out of the count', async () => {
  delete config['recentSessions.groupByPeriod'];
  const provider = new SessionTreeDataProvider({}, 'claude');
  let recent = recentOf(provider._buildGroups({}));
  const allIds: string[] = [];
  for (const p of recent._children) {
    const kids = await provider.getChildren(p);
    // Sorted newest first inside a period
    const mtimes = kids.map((k: any) => k._mtime);
    assert.deepEqual(mtimes, [...mtimes].sort((a: number, b: number) => b - a), `${p.label} sorted`);
    for (const k of kids) {
      assert.equal(k.contextValue, 'session');
      assert.match(k.label, /^Title /);
      allIds.push(k._sessionId);
    }
  }
  assert.equal(allIds.length, 39, 'every titled ungrouped session is reachable');
  assert.ok(!allIds.includes('older-15'), 'untitled stays hidden');
  assert.ok(!allIds.includes('grouped-old'), 'grouped sessions are not in Recent Sessions');
  // Next refresh: the title cache now knows older-15 is empty
  recent = recentOf(provider._buildGroups({}));
  assert.equal(count(recent.label), 39);
});

test('the grouped session still shows in its group', () => {
  const provider = new SessionTreeDataProvider({}, 'claude');
  const group = provider._buildGroups({}).find((n: any) => n.contextValue === 'customGroup');
  assert.ok(group);
  assert.deepEqual(group._children.map((c: any) => c._sessionId), ['grouped-old']);
});

test('groupByPeriod off → the old flat list of the newest 30', () => {
  config['recentSessions.groupByPeriod'] = false;
  try {
    const provider = new SessionTreeDataProvider({}, 'claude');
    const recent = recentOf(provider._buildGroups({}));
    assert.ok(recent._children.every((c: any) => c.contextValue === 'session'));
    assert.equal(recent._children.length, 30);
    assert.equal(count(recent.label), 30);
  } finally {
    delete config['recentSessions.groupByPeriod'];
  }
});

test('a search filter matches loaded titles only (older periods are not read for it)', () => {
  const provider = new SessionTreeDataProvider({}, 'claude');
  provider.setFilter('title');
  const recent = recentOf(provider._buildGroups({}));
  assert.ok(recent._children.every((p: any) => !p._lazyFiles));
  assert.equal(count(recent.label), 30);
});

test('unified view: lazily built Claude leaves carry the unified markers', async () => {
  const provider = new SessionTreeDataProvider({}, 'unified');
  const recent = recentOf(provider._buildGroups({ unified: true }));
  const lazy = recent._children.find((p: any) => p._lazyFiles);
  assert.ok(lazy);
  const kids = await provider.getChildren(lazy);
  assert.ok(kids.length > 0);
  assert.ok(kids.every((k: any) => k._agent === 'claude' && k._unified === true));
});

test('period nodes accept drops like the Recent Sessions header (drop = ungroup)', () => {
  const provider = new SessionTreeDataProvider({}, 'claude');
  const recent = recentOf(provider._buildGroups({}));
  assert.ok(recent._children.every((p: any) => p.contextValue === 'recentGroup'));
});

test('subagent transcripts (agent-*.jsonl) are never listed', async () => {
  const provider = new SessionTreeDataProvider({}, 'claude');
  const recent = recentOf(provider._buildGroups({}));
  const ids: string[] = [];
  for (const p of recent._children) for (const k of await provider.getChildren(p)) ids.push(k._sessionId);
  assert.ok(!ids.some((id) => id.startsWith('agent-')));
  assert.ok(!provider._claudeSessionIds().some((s: any) => s._sessionId.startsWith('agent-')));
});

test('period expand state has its own key: a group named "Today" does not share it', () => {
  const provider = new SessionTreeDataProvider({}, 'claude');
  const recent = recentOf(provider._buildGroups({}));
  const today = recent._children.find((p: any) => p._periodKey === 'today');
  assert.equal(today._expandKey, 'period:today');
  assert.equal(today.collapsibleState, 2, 'Today starts expanded');
  provider._expandedGroups.add('Today'); // what a custom group named "Today" would record
  provider._expandedGroups.delete('period:today');
  const again = recentOf(provider._buildGroups({}))._children.find((p: any) => p._periodKey === 'today');
  assert.equal(again.collapsibleState, 1);
  // activation.js keys expansion by _expandKey first
  const activation = fs.readFileSync(path.join(process.cwd(), 'src/activation.js'), 'utf8');
  assert.equal((activation.match(/const key = e\.element\._expandKey \|\| e\.element\._groupName/g) || []).length, 16);
});

test('nesting with an older session keeps both visible (parent and child are loaded up front)', async () => {
  // older-03 under a listed parent, and a listed session under an older parent
  // (older-10 and older-12 are past the newest 30, so neither is built by default)
  sessionStoreUpdate('claudeSessionParent', { 'older-10': 'recent-00', 'recent-05': 'older-12' });
  try {
    const provider = new SessionTreeDataProvider({}, 'claude');
    const recent = recentOf(provider._buildGroups({}));
    const leaves: any[] = [];
    for (const p of recent._children) leaves.push(...await provider.getChildren(p));
    const byId = new Map(leaves.map((l: any) => [l._sessionId, l]));
    assert.deepEqual((byId.get('recent-00')._subSessions || []).map((s: any) => s._sessionId), ['older-10']);
    assert.deepEqual((byId.get('older-12')._subSessions || []).map((s: any) => s._sessionId), ['recent-05']);
    assert.ok(!byId.has('older-10') && !byId.has('recent-05'), 'children are not also top-level');
  } finally {
    sessionStoreUpdate('claudeSessionParent', {});
  }
});

test('Move Up/Down works on an older session and stays inside its period', () => {
  const provider = new SessionTreeDataProvider({}, 'claude');
  provider.refresh = () => {}; // no debounce timer in tests
  const ids = provider._claudeSessionIds();
  const mtimeOf = new Map(ids.map((s: any) => [s._sessionId, s._mtime]));
  // An older (stat-only) session that is not first in its period, so it can move up
  const target = ['older-08', 'older-09', 'older-10', 'older-11', 'older-12', 'older-13']
    .find((id) => provider._getSiblings({}, id).indexOf(id) > 0)!;
  assert.ok(target);
  const period = periodOf(mtimeOf.get(target), Date.now()).key;
  const siblings = provider._getSiblings({}, target);
  assert.ok(siblings.every((id: string) => periodOf(mtimeOf.get(id), Date.now()).key === period), 'same period only');
  const before = siblings.indexOf(target);
  provider.moveSessionUp(target);
  try {
    const order = sessionStoreGet('claudeSessionSortOrder', {});
    assert.ok(order[target] < order[siblings[before - 1]], 'moved above its neighbour');
    assert.ok(Object.keys(order).every((id) => periodOf(mtimeOf.get(id), Date.now()).key === period), 'no other period touched');
  } finally {
    sessionStoreUpdate('claudeSessionSortOrder', {});
  }
});

test('search also finds older sessions once their titles are known (no file reads for it)', async () => {
  const provider = new SessionTreeDataProvider({}, 'claude');
  const found = async () => {
    const recent = provider._buildGroups({}).find((n: any) => n.contextValue === 'recentGroup');
    if (!recent) return [];
    const out: any[] = [];
    for (const p of recent._children) out.push(...await provider.getChildren(p));
    return out.map((l: any) => l._sessionId).sort();
  };
  provider.setFilter('older-1');
  // Fresh cache: older titles are unknown, so the search finds none of them
  assert.deepEqual(await found(), []);
  // Open every period once (unfiltered), then search again
  provider.setFilter('');
  for (const p of recentOf(provider._buildGroups({}))._children) await provider.getChildren(p);
  provider.setFilter('older-1');
  assert.deepEqual(await found(), ['older-10', 'older-11', 'older-12', 'older-13', 'older-14']);
});

test('a search hit on a saved title builds the leaf without reading the file', () => {
  sessionStoreUpdate('claudeSessionTitles', { 'older-14': '저장된 제목 Q3 정리' });
  try {
    const provider = new SessionTreeDataProvider({}, 'claude');
    const reads: string[] = [];
    const orig = provider._getFileMeta.bind(provider);
    provider._getFileMeta = (p: string, m: number, s: number) => { reads.push(path.basename(p)); return orig(p, m, s); };
    provider.setFilter('q3 정리');
    const recent = recentOf(provider._buildGroups({}));
    const leaves = recent._children.flatMap((p: any) => p._children || []);
    assert.deepEqual(leaves.map((l: any) => [l._sessionId, l.label]), [['older-14', '저장된 제목 Q3 정리']]);
    assert.ok(!reads.includes('older-14.jsonl'), 'the matched older file was not read');
  } finally {
    sessionStoreUpdate('claudeSessionTitles', {});
  }
});

test('cleanup', () => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origUserProfile;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
