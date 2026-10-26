// v3.27.0 — Trash on Gajae (gjc), Grok and the other agent sessions.
//
// Trash did nothing for gjc in two ways: the per-agent views tag leaves with
// _agentMode only, and trashAgentSession read _agent (unified-view only), so
// it returned at once; in the unified view the file did move to
// <sessions>/trash/, but the gjc listing walks every folder under <sessions>
// and listed it again. Grok moved only updates.jsonl and left summary.json, so
// the session stayed. Listings now skip trash/, and Trash moves whole sessions.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/* eslint-disable @typescript-eslint/no-var-requires */
const {
  listGjcSessions, findGjcSessionPath, listGrokSessions, findGrokSessionPath, findGrokSessionDir,
} = require(path.join(process.cwd(), 'src/lib/sessionJsonl'));
const { moveToTrash, trashSession, AGENT_TRASH_DIR } = require(path.join(process.cwd(), 'src/lib/agentTrash'));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-trash-'));
const cwd = path.join(tmpRoot, 'ws');
fs.mkdirSync(cwd);

const gjcHeader = (id: string) => JSON.stringify({ type: 'session', id, title: id, cwd }) + '\n';
function grokSession(dir: string, id: string, withUpdates = true) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ info: { id, cwd, title: id, updated_at: '2026-10-01T00:00:00Z' } }));
  if (withUpdates) fs.writeFileSync(path.join(dir, 'updates.jsonl'), '');
}

test('gjc: sessions moved to <sessions>/trash/ are not listed or resolved', () => {
  const sessions = path.join(tmpRoot, 'gjc-sessions');
  const live = path.join(sessions, '--ws--');
  const trash = path.join(sessions, AGENT_TRASH_DIR);
  fs.mkdirSync(live, { recursive: true });
  fs.mkdirSync(trash, { recursive: true });
  fs.writeFileSync(path.join(live, '2026-06-20T08-00-00-000Z_live.jsonl'), gjcHeader('live'));
  fs.writeFileSync(path.join(trash, '2026-06-20T07-00-00-000Z_gone.jsonl'), gjcHeader('gone'));
  assert.deepEqual(listGjcSessions(cwd, sessions).map((s: any) => s.sessionId), ['2026-06-20T08-00-00-000Z_live']);
  assert.equal(findGjcSessionPath('2026-06-20T07-00-00-000Z_gone', sessions, cwd), null);
});

test('grok: a session folder in <sessions>/trash/ is not listed; a summary-only folder is still found for Trash', () => {
  const sessions = path.join(tmpRoot, 'grok-sessions');
  grokSession(path.join(sessions, 'grp', 'live-id'), 'live-id');
  grokSession(path.join(sessions, 'grp', 'summary-only'), 'summary-only', false);
  grokSession(path.join(sessions, AGENT_TRASH_DIR, 'gone-id'), 'gone-id');
  assert.deepEqual(listGrokSessions(cwd, sessions).map((s: any) => s.sessionId).sort(), ['live-id', 'summary-only']);
  assert.equal(findGrokSessionPath('gone-id', sessions, cwd), null);
  // findGrokSessionPath needs updates.jsonl; the folder lookup Trash uses does not
  assert.equal(findGrokSessionPath('summary-only', sessions, cwd), null);
  assert.equal(findGrokSessionDir('summary-only', sessions, cwd), path.join(sessions, 'grp', 'summary-only'));
});

test('trashSession moves a gjc transcript, then its sidecar folder, out of the listing', () => {
  const sessions = path.join(tmpRoot, 'gjc-move');
  const group = path.join(sessions, '--ws--');
  const stem = '2026-06-20T09-00-00-000Z_abc';
  fs.mkdirSync(path.join(group, stem, 'resident-cache'), { recursive: true });
  fs.writeFileSync(path.join(group, stem, '1.bash.log'), 'log');
  fs.writeFileSync(path.join(group, `${stem}.jsonl`), gjcHeader(stem));
  const file = findGjcSessionPath(stem, sessions, cwd);
  const moved = trashSession(file, sessions, file.replace(/\.jsonl$/, ''));
  assert.deepEqual(moved.map((p: string) => path.relative(sessions, p)), [
    path.join('trash', `${stem}.jsonl`),
    path.join('trash', stem),
  ]);
  assert.ok(fs.existsSync(path.join(sessions, 'trash', stem, '1.bash.log')));
  assert.deepEqual(listGjcSessions(cwd, sessions), []);
});

test('trashSession moves a whole Grok session folder', () => {
  const sessions = path.join(tmpRoot, 'grok-move');
  grokSession(path.join(sessions, 'grp', 'g-1'), 'g-1');
  trashSession(findGrokSessionDir('g-1', sessions, cwd), sessions, null);
  assert.ok(fs.existsSync(path.join(sessions, 'trash', 'g-1', 'summary.json')));
  assert.deepEqual(listGrokSessions(cwd, sessions), []);
});

test('moveToTrash never replaces an earlier trashed copy (file or folder)', () => {
  const sessions = path.join(tmpRoot, 'collide');
  fs.mkdirSync(sessions, { recursive: true });
  for (let i = 0; i < 3; i++) {
    const f = path.join(sessions, 'same.jsonl');
    fs.writeFileSync(f, `v${i}`);
    moveToTrash(f, sessions);
    const d = path.join(sessions, 'dir-id');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'x'), `v${i}`);
    moveToTrash(d, sessions);
  }
  const trash = path.join(sessions, 'trash');
  assert.deepEqual(fs.readdirSync(trash).sort(), ['dir-id', 'dir-id.2', 'dir-id.3', 'same.2.jsonl', 'same.3.jsonl', 'same.jsonl']);
  assert.equal(fs.readFileSync(path.join(trash, 'same.jsonl'), 'utf8'), 'v0');
  assert.equal(fs.readFileSync(path.join(trash, 'dir-id.3', 'x'), 'utf8'), 'v2');
});

test('trashSession on a missing session does nothing', () => {
  assert.deepEqual(trashSession(null, tmpRoot, null), []);
  assert.deepEqual(trashSession(path.join(tmpRoot, 'nope.jsonl'), tmpRoot, null), []);
});

test('the Trash command works from the per-agent views and on nested sessions', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/activation.js'), 'utf8');
  const start = src.indexOf("registerCommand('claudeCodeLauncher.trashAgentSession'");
  const body = src.slice(start, src.indexOf('state.refreshSessionTrees();', start));
  // Per-agent views tag leaves with _agentMode only
  assert.match(body, /const agent = item\._agent \|\| item\._agentMode;/);
  // Grok: the folder, found even without updates.jsonl
  assert.match(body, /sessionPath = findGrokSessionDir\(sessionId, null, cwd\);/);
  assert.match(body, /trashSession\(sessionPath, sessionsDir, sidecar\);/);
  // Nested (subSession) leaves get the Trash button in every per-agent view
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  const menus = pkg.contributes.menus['view/item/context'].filter((m: any) => m.command === 'claudeCodeLauncher.trashAgentSession');
  for (const view of ['gjcSessions', 'codexSessions', 'antigravitySessions', 'grokSessions', 'chiefSessions']) {
    const entry = menus.find((m: any) => m.when.includes(`claudeCodeLauncher.${view}`));
    assert.ok(entry && /viewItem == subSession/.test(entry.when), `${view} trash menu covers nested sessions`);
  }
});

test('an exact gjc session that is gone is not silently continued with gjc -c', () => {
  for (const rel of ['src/panel/createPanel.js', 'src/panel/restartPty.js']) {
    const src = fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
    assert.match(src, /isGjcResume && !gjcResumePath\) \{\s*vscode\.window\.showWarningMessage\(/, rel);
  }
});

test('cleanup', () => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
