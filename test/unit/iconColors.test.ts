import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

function readIcon(name: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'icons', name), 'utf8');
}

function firstHexColor(svg: string): string {
  const match = svg.match(/(?:fill|stroke)="(#[0-9a-fA-F]{6})"/);
  assert.ok(match, 'expected icon to contain a hex fill or stroke');
  return match[1].toUpperCase();
}

test('grok running icon uses the shared running yellow, not done green', () => {
  const running = firstHexColor(readIcon('grok-running.svg'));
  const done = firstHexColor(readIcon('grok-done.svg'));
  const sharedRunning = firstHexColor(readIcon('claude-running.svg'));

  assert.equal(running, sharedRunning);
  assert.notEqual(running, done);
});
