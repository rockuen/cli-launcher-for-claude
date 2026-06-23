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

test('gjc idle icon uses the shared idle gray without a square background', () => {
  const idle = readIcon('gjc-idle.svg');
  const sharedIdle = firstHexColor(readIcon('claude-idle.svg'));

  assert.equal(idle.includes('<rect'), false, 'gjc idle icon must not use a boxed background');
  assert.equal(firstHexColor(idle), sharedIdle);
  assert.match(idle, /stroke="#888888"/);
});

test('gjc running icon uses the shared running yellow', () => {
  const running = firstHexColor(readIcon('gjc-running.svg'));
  const sharedRunning = firstHexColor(readIcon('claude-running.svg'));

  assert.equal(running, sharedRunning);
});

test('all agents have a blue waiting icon distinct from the shell icon glyph', () => {
  for (const agent of ['claude', 'codex', 'grok', 'kiro', 'antigravity', 'gjc', 'chief']) {
    const waiting = readIcon(`${agent}-waiting.svg`);
    const shell = readIcon(`${agent}-shell.svg`);

    assert.match(waiting, /#[0-9a-fA-F]{6}/, `${agent} waiting icon should contain a hex color`);
    assert.equal(firstHexColor(waiting), '#4FC3F7');
    assert.notEqual(waiting, shell, `${agent} waiting icon must not duplicate shell glyph`);
    assert.match(waiting, /<title>.* waiting<\/title>/);
  }
});
