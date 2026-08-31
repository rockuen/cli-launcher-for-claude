// Reader file-watch reliability regression coverage (v3.21.6).

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const {
  isRawSizeChange,
  attachRawSizeChangeFallback,
} = require(path.join(process.cwd(), 'src/lib/readerWatch'));

test('raw size fallback detects Codex append even when mtime is frozen', () => {
  const frozenMtime = 1788143180125;
  assert.equal(isRawSizeChange({
    prev: { size: 1552406, mtimeMs: frozenMtime, atimeMs: frozenMtime + 1 },
    curr: { size: 1667996, mtimeMs: frozenMtime, atimeMs: frozenMtime + 1 },
  }), true);
});

test('raw size fallback ignores metadata-only and malformed events', () => {
  assert.equal(isRawSizeChange({ prev: { size: 10 }, curr: { size: 10 } }), false);
  assert.equal(isRawSizeChange({ prev: { size: 10 }, curr: { size: Number.NaN } }), false);
  assert.equal(isRawSizeChange(null), false);
});

test('fallback schedules only a raw size delta', () => {
  const handlers: Record<string, (...args: any[]) => void> = {};
  const watcher = {
    on(event: string, handler: (...args: any[]) => void) {
      handlers[event] = handler;
      return this;
    },
  };
  let scheduled = 0;
  attachRawSizeChangeFallback(watcher, () => { scheduled += 1; });
  assert.ok(handlers.raw, 'raw listener should be attached');

  handlers.raw('change', 'rollout.jsonl', { prev: { size: 100 }, curr: { size: 100 } });
  handlers.raw('change', 'rollout.jsonl', { prev: { size: 100 }, curr: { size: 101 } });
  assert.equal(scheduled, 1);
});

test('split and standalone readers both attach the size-change fallback', () => {
  const split = fs.readFileSync(path.join(process.cwd(), 'src/panel/createPanel.js'), 'utf8');
  const standalone = fs.readFileSync(path.join(process.cwd(), 'src/panel/readerView.js'), 'utf8');
  assert.match(split, /attachRawSizeChangeFallback\(watcher, schedule\)/);
  assert.match(standalone, /attachRawSizeChangeFallback\(liveWatcher, scheduleLiveRender\)/);
});

test('standalone reader reconciles once when its watcher becomes ready', () => {
  const standalone = fs.readFileSync(path.join(process.cwd(), 'src/panel/readerView.js'), 'utf8');
  const watchStart = standalone.indexOf('liveWatcher = chokidar.watch(filePath');
  const watchEnd = standalone.indexOf('});', watchStart);
  assert.ok(watchStart > 0 && watchEnd > watchStart);
  assert.match(standalone.slice(watchStart, watchEnd), /ignoreInitial:\s*false/);
});
