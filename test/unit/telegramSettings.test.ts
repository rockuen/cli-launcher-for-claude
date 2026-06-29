// telegramSettings — pure helper contracts (vscode-independent).
// detectTelegramSupport/setupTelegram/disableTelegram require the vscode runtime
// and are exercised by integration/e2e; these unit tests lock the pure logic:
// version parsing/gating, bot-token & chat-id validation, notify-setup arg
// construction (no shell interpolation), and daemon-status telegram detection.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';

const tg = require(
  path.join(process.cwd(), 'src/handlers/telegramSettings'),
) as {
  parseGjcVersion: (out: string | null) => number[] | null;
  isVersionSupported: (parsed: number[] | null, min?: number[]) => boolean;
  isValidBotToken: (token: unknown) => boolean;
  isValidChatId: (chatId: unknown) => boolean;
  buildNotifySetupArgs: (token: string, chatId: string, redact: boolean) => string[];
  telegramKindPresent: (status: unknown) => boolean;
  MIN_GJC_VERSION: number[];
};

test('parseGjcVersion: extracts semver from version output, null on miss', () => {
  assert.deepEqual(tg.parseGjcVersion('gjc v0.7.7'), [0, 7, 7]);
  assert.deepEqual(tg.parseGjcVersion('0.7.0'), [0, 7, 0]);
  assert.deepEqual(tg.parseGjcVersion('Gajae Code 1.2.30 (build x)'), [1, 2, 30]);
  assert.equal(tg.parseGjcVersion('no version here'), null);
  assert.equal(tg.parseGjcVersion(null), null);
  assert.equal(tg.parseGjcVersion(''), null);
});

test('isVersionSupported: gates on >= 0.7.0 (telegram SDK floor)', () => {
  assert.equal(tg.isVersionSupported([0, 7, 0]), true); // exact floor
  assert.equal(tg.isVersionSupported([0, 7, 7]), true);
  assert.equal(tg.isVersionSupported([0, 8, 0]), true);
  assert.equal(tg.isVersionSupported([1, 0, 0]), true);
  assert.equal(tg.isVersionSupported([0, 6, 9]), false);
  assert.equal(tg.isVersionSupported([0, 6, 99]), false);
  assert.equal(tg.isVersionSupported(null), false);
  assert.equal(tg.isVersionSupported([0, 7]), false); // malformed
  assert.deepEqual(tg.MIN_GJC_VERSION, [0, 7, 0]);
});

test('isValidBotToken: accepts BotFather shape, rejects junk', () => {
  assert.equal(tg.isValidBotToken('123456789:AAH-abcdEFGhijklmnop_qrstuvwx12345'), true);
  assert.equal(tg.isValidBotToken('  123456789:AAH-abcdEFGhijklmnop_qrstuvwx12345  '), true); // trimmed
  assert.equal(tg.isValidBotToken('123:short'), false); // body too short
  assert.equal(tg.isValidBotToken('abc:AAH-abcdEFGhijklmnop_qrstuvwx12345'), false); // non-numeric id
  assert.equal(tg.isValidBotToken('nope'), false);
  assert.equal(tg.isValidBotToken(''), false);
  assert.equal(tg.isValidBotToken(undefined), false);
  assert.equal(tg.isValidBotToken(12345), false);
});

test('isValidChatId: integer (incl. negative) or @username', () => {
  assert.equal(tg.isValidChatId('123456789'), true);
  assert.equal(tg.isValidChatId('-1001234567890'), true); // supergroup/channel
  assert.equal(tg.isValidChatId('@mychannel'), true);
  assert.equal(tg.isValidChatId('@abcd'), true);
  assert.equal(tg.isValidChatId('@bad'), false); // too short
  assert.equal(tg.isValidChatId('bad id'), false);
  assert.equal(tg.isValidChatId(''), false);
  assert.equal(tg.isValidChatId(undefined), false);
});

test('buildNotifySetupArgs: arg array, optional --redact, no shell interpolation', () => {
  assert.deepEqual(
    tg.buildNotifySetupArgs('TOK', 'CID', true),
    ['notify', 'setup', '--token', 'TOK', '--chat-id', 'CID', '--redact'],
  );
  assert.deepEqual(
    tg.buildNotifySetupArgs('TOK', 'CID', false),
    ['notify', 'setup', '--token', 'TOK', '--chat-id', 'CID'],
  );
  // Token/chatId are discrete argv entries (never concatenated into a shell string),
  // and are trimmed.
  const args = tg.buildNotifySetupArgs('  T O K  ', '  C ID ', false);
  assert.equal(args[3], 'T O K');
  assert.equal(args[5], 'C ID');
  assert.equal(args.length, 6);
});

test('telegramKindPresent: detects kind=telegram in daemon status json', () => {
  assert.equal(tg.telegramKindPresent('[{"kind":"telegram","configured":false}]'), true);
  assert.equal(
    tg.telegramKindPresent([{ kind: 'telegram', configured: true }]),
    true,
  );
  assert.equal(tg.telegramKindPresent('[{"kind":"other"}]'), false);
  assert.equal(tg.telegramKindPresent('[]'), false);
  assert.equal(tg.telegramKindPresent('not json'), false);
  assert.equal(tg.telegramKindPresent(null), false);
  assert.equal(tg.telegramKindPresent({}), false);
});
