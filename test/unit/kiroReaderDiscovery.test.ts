// Kiro/Codex fresh-session reader discovery guards.
//
// Fresh sessions get real ids only after their CLIs start. The reader must
// snapshot existing ids before spawn, then retry discovery until the new id is
// pinned, otherwise a fast first write can leave the split reader empty.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

function createPanelSource(): string {
  return fs.readFileSync(path.join(process.cwd(), 'src/panel/createPanel.js'), 'utf8');
}

test('fresh Kiro sessions snapshot existing ids before PTY spawn', () => {
  const source = createPanelSource();

  const snapshot = source.indexOf('const kiroPreSessionIds');
  const spawn = source.indexOf('ptyProcess = createBackend({');

  assert.notEqual(snapshot, -1);
  assert.notEqual(spawn, -1);
  assert.ok(snapshot < spawn);
  assert.ok(source.includes('entry._kiroPreIds || new Set(listKiroSessions(entry.cwd).map(s => s.sessionId))'));
});

test('fresh reader discovery retries when filesystem events are missed', () => {
  const source = createPanelSource();

  assert.ok(source.includes('let discoveryTimer = null;'));
  assert.ok(source.includes('discoveryTimer = setInterval(schedule, 1000);'));
  assert.ok(source.includes('if (discoveryTimer) { clearInterval(discoveryTimer); discoveryTimer = null; }'));
});
