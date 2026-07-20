import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { writePtyChunked, PTY_CHUNK_DELAY } = require(path.join(process.cwd(), 'src/pty/write'));

test('custom post-write delay starts after the final PTY chunk', () => {
  const originalSetTimeout = global.setTimeout;
  const scheduled: Array<{ callback: () => void, delay: number }> = [];
  const received: string[] = [];

  global.setTimeout = ((callback: () => void, delay: number) => {
    scheduled.push({ callback, delay });
    return 0 as any;
  }) as typeof setTimeout;

  try {
    const entry = {
      pty: { write: (data: string) => received.push(data) },
      _disposed: false,
    };

    writePtyChunked(entry, 'x'.repeat(300), { afterDelayMs: 300 });
    writePtyChunked(entry, '\r');

    assert.equal(received.join(''), 'x'.repeat(256));
    const betweenChunks = scheduled.shift();
    assert.equal(betweenChunks?.delay, PTY_CHUNK_DELAY);

    betweenChunks?.callback();
    assert.equal(received.join(''), 'x'.repeat(300));
    const settlePaste = scheduled.shift();
    assert.equal(settlePaste?.delay, 300);

    settlePaste?.callback();
    assert.equal(received.join(''), 'x'.repeat(300) + '\r');
    assert.equal(scheduled.shift()?.delay, PTY_CHUNK_DELAY);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});
