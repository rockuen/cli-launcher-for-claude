// Phase 6 — multiplexer launcher tests.
//
// We test the parts that don't need a real vscode host:
//   - buildSessionName format
//   - openClaudeInMultiplexer wiring (newSession args, info message text)
//
// vscode.window is replaced via the showInfo dependency-injection seam
// so the test runs in plain node:test.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildSessionName,
  openClaudeInMultiplexer,
} from '../../src/orchestration/core/multiplexerLauncher';
import type {
  IMultiplexerBackend,
  MultiplexerSession,
  NewSessionOptions,
  SendKeysOptions,
} from '../../src/orchestration/backends/IMultiplexerBackend';

class FakeBackend implements IMultiplexerBackend {
  readonly id: string;
  readonly newSessionCalls: NewSessionOptions[] = [];
  disposed = false;

  constructor(id: string) {
    this.id = id;
  }

  async available(): Promise<boolean> {
    return true;
  }

  async newSession(opts: NewSessionOptions): Promise<MultiplexerSession> {
    this.newSessionCalls.push(opts);
    return { name: opts.name, cwd: opts.cwd };
  }

  async sendKeys(_opts: SendKeysOptions): Promise<void> {
    // unused
  }

  async killSession(_name: string): Promise<void> {
    // unused
  }

  async listSessions(): Promise<MultiplexerSession[]> {
    return [];
  }

  dispose(): void {
    this.disposed = true;
  }
}

test('buildSessionName: returns prefix-YYYYMMDDHHmmss shape', () => {
  const name = buildSessionName();
  assert.match(name, /^cli-launcher-\d{14}$/);
});

test('buildSessionName: honors custom prefix', () => {
  const name = buildSessionName('test');
  assert.match(name, /^test-\d{14}$/);
});

test('openClaudeInMultiplexer: tmux backend → newSession with command="claude" + attach hint', async () => {
  const backend = new FakeBackend('tmux');
  const messages: string[] = [];
  const result = await openClaudeInMultiplexer({
    backend,
    cwd: '/tmp/work',
    showInfo: (m) => {
      messages.push(m);
      return Promise.resolve(undefined);
    },
  });

  assert.equal(backend.newSessionCalls.length, 1);
  const call = backend.newSessionCalls[0]!;
  assert.equal(call.cwd, '/tmp/work');
  assert.equal(call.command, 'claude');
  assert.match(call.name, /^cli-launcher-\d{14}$/);
  assert.equal(result.name, call.name);

  assert.equal(messages.length, 1);
  assert.ok(messages[0]!.includes('tmux attach -t '));
  assert.ok(messages[0]!.includes(call.name));
});

test('openClaudeInMultiplexer: psmux backend surfaces psmux attach hint', async () => {
  const backend = new FakeBackend('psmux');
  const messages: string[] = [];
  await openClaudeInMultiplexer({
    backend,
    cwd: 'C:\\Users\\Won\\code',
    showInfo: (m) => {
      messages.push(m);
      return Promise.resolve(undefined);
    },
  });

  assert.equal(messages.length, 1);
  assert.ok(messages[0]!.includes('psmux attach -t '));
});

test('openClaudeInMultiplexer: respects custom command override', async () => {
  const backend = new FakeBackend('tmux');
  await openClaudeInMultiplexer({
    backend,
    cwd: '/tmp',
    command: 'claude --resume abc123',
    showInfo: () => Promise.resolve(undefined),
  });

  assert.equal(backend.newSessionCalls[0]!.command, 'claude --resume abc123');
});
