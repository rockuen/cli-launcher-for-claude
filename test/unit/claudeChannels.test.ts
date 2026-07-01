// claudeChannels / claudeChannelSetup — pure helper contracts (vscode-independent).
//
// The runtime API (promptAndSetupTelegramChannel / setupTelegramChannel /
// disableTelegramChannel) needs the vscode runtime and is exercised by
// integration/e2e. These unit tests lock the pure logic that drives the wizard:
// channel spawn-arg construction, Claude version parsing/gating, bot-token
// validation, the token .env path/content, and the plugin/marketplace argv
// (no shell interpolation), plus token redaction.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';

const cc = require(
  path.join(process.cwd(), 'src/lib/claudeChannels'),
) as {
  CHANNEL_PLUGINS: Record<string, string>;
  resolveEnabledChannels: (cfg: { get: (k: string, d?: any) => any }) => string[];
  claudeChannelsArgs: (cfg: { get: (k: string, d?: any) => any }) => string[];
};

const cs = require(
  path.join(process.cwd(), 'src/handlers/claudeChannelSetup'),
) as {
  parseClaudeVersion: (out: string | null) => number[] | null;
  isVersionSupported: (parsed: number[] | null, min?: number[]) => boolean;
  isValidBotToken: (token: unknown) => boolean;
  telegramEnvPath: (home?: string) => string;
  buildEnvFileContent: (token: string) => string;
  buildMarketplaceAddArgs: () => string[];
  buildPluginInstallArgs: () => string[];
  redactToken: (message: unknown, token: string) => string;
  MIN_CLAUDE_VERSION: number[];
  TELEGRAM_MARKETPLACE: string;
  TELEGRAM_PLUGIN: string;
  TELEGRAM_CHANNEL_ENABLED_KEY: string;
};

// Minimal stand-in for vscode's WorkspaceConfiguration.get(key, default).
function mockCfg(values: Record<string, any>) {
  return { get: (key: string, def?: any) => (key in values ? values[key] : def) };
}

// ===========================================================================
// claudeChannels.js — spawn args
// ===========================================================================

test('claudeChannelsArgs: telegram on -> --channels spec; off/missing -> []', () => {
  const on = mockCfg({ 'claude.channels.telegram.enabled': true });
  assert.deepEqual(
    cc.claudeChannelsArgs(on),
    ['--channels', 'plugin:telegram@claude-plugins-official'],
  );
  assert.deepEqual(cc.claudeChannelsArgs(mockCfg({ 'claude.channels.telegram.enabled': false })), []);
  assert.deepEqual(cc.claudeChannelsArgs(mockCfg({})), []); // default false when unset
});

test('resolveEnabledChannels: returns enabled channel keys', () => {
  assert.deepEqual(cc.resolveEnabledChannels(mockCfg({ 'claude.channels.telegram.enabled': true })), ['telegram']);
  assert.deepEqual(cc.resolveEnabledChannels(mockCfg({})), []);
});

test('CHANNEL_PLUGINS: telegram maps to the official plugin channel spec', () => {
  assert.equal(cc.CHANNEL_PLUGINS.telegram, 'plugin:telegram@claude-plugins-official');
});

// ===========================================================================
// claudeChannelSetup.js — version gate
// ===========================================================================

test('parseClaudeVersion: extracts semver from version output, null on miss', () => {
  assert.deepEqual(cs.parseClaudeVersion('2.1.80 (Claude Code)'), [2, 1, 80]);
  assert.deepEqual(cs.parseClaudeVersion('claude 2.1.95'), [2, 1, 95]);
  assert.deepEqual(cs.parseClaudeVersion('v3.0.0'), [3, 0, 0]);
  assert.equal(cs.parseClaudeVersion('no version'), null);
  assert.equal(cs.parseClaudeVersion(null), null);
  assert.equal(cs.parseClaudeVersion(''), null);
});

test('isVersionSupported: gates on >= 2.1.80 (channels floor)', () => {
  assert.equal(cs.isVersionSupported([2, 1, 80]), true); // exact floor
  assert.equal(cs.isVersionSupported([2, 1, 81]), true);
  assert.equal(cs.isVersionSupported([2, 2, 0]), true);
  assert.equal(cs.isVersionSupported([3, 0, 0]), true);
  assert.equal(cs.isVersionSupported([2, 1, 79]), false);
  assert.equal(cs.isVersionSupported([2, 0, 99]), false);
  assert.equal(cs.isVersionSupported([1, 9, 9]), false);
  assert.equal(cs.isVersionSupported(null), false);
  assert.equal(cs.isVersionSupported([2, 1]), false); // malformed
  assert.deepEqual(cs.MIN_CLAUDE_VERSION, [2, 1, 80]);
});

// ===========================================================================
// claudeChannelSetup.js — token validation
// ===========================================================================

test('isValidBotToken: accepts BotFather shape, rejects junk', () => {
  assert.equal(cs.isValidBotToken('123456789:AAH-abcdEFGhijklmnop_qrstuvwx12345'), true);
  assert.equal(cs.isValidBotToken('  123456789:AAH-abcdEFGhijklmnop_qrstuvwx12345  '), true); // trimmed
  assert.equal(cs.isValidBotToken('123:short'), false); // body too short
  assert.equal(cs.isValidBotToken('abc:AAH-abcdEFGhijklmnop_qrstuvwx12345'), false); // non-numeric id
  assert.equal(cs.isValidBotToken('nope'), false);
  assert.equal(cs.isValidBotToken(''), false);
  assert.equal(cs.isValidBotToken(undefined), false);
  assert.equal(cs.isValidBotToken(12345), false);
});

// ===========================================================================
// claudeChannelSetup.js — token .env path + content
// ===========================================================================

test('telegramEnvPath: <home>/.claude/channels/telegram/.env', () => {
  const p = cs.telegramEnvPath('HOMEDIR');
  assert.ok(p.includes('HOMEDIR'), 'path should be under the given home');
  assert.ok(
    p.endsWith(path.join('.claude', 'channels', 'telegram', '.env')),
    'path should end with .claude/channels/telegram/.env',
  );
});

test('buildEnvFileContent: TELEGRAM_BOT_TOKEN=<token> with trailing newline, trimmed', () => {
  assert.equal(cs.buildEnvFileContent('TOK'), 'TELEGRAM_BOT_TOKEN=TOK\n');
  assert.equal(cs.buildEnvFileContent('  TOK  '), 'TELEGRAM_BOT_TOKEN=TOK\n');
});

// ===========================================================================
// claudeChannelSetup.js — plugin/marketplace argv (no shell interpolation)
// ===========================================================================

test('buildMarketplaceAddArgs: discrete argv for `claude plugin marketplace add`', () => {
  assert.deepEqual(
    cs.buildMarketplaceAddArgs(),
    ['plugin', 'marketplace', 'add', 'anthropics/claude-plugins-official'],
  );
  assert.equal(cs.TELEGRAM_MARKETPLACE, 'anthropics/claude-plugins-official');
});

test('buildPluginInstallArgs: discrete argv for `claude plugin install --scope user`', () => {
  assert.deepEqual(
    cs.buildPluginInstallArgs(),
    ['plugin', 'install', 'telegram@claude-plugins-official', '--scope', 'user'],
  );
  assert.equal(cs.TELEGRAM_PLUGIN, 'telegram@claude-plugins-official');
});

// ===========================================================================
// claudeChannelSetup.js — redaction + config key
// ===========================================================================

test('redactToken: masks token occurrences in error text', () => {
  assert.equal(cs.redactToken('setup failed near TOK end', 'TOK'), 'setup failed near *** end');
  assert.equal(cs.redactToken('TOK TOK', 'TOK'), '*** ***');
  assert.equal(cs.redactToken('', 'TOK'), '');
  assert.equal(cs.redactToken(null, 'TOK'), '');
  assert.equal(cs.redactToken('msg', ''), 'msg'); // empty token → unchanged
});

test('TELEGRAM_CHANNEL_ENABLED_KEY matches the launcher setting key', () => {
  assert.equal(cs.TELEGRAM_CHANNEL_ENABLED_KEY, 'claude.channels.telegram.enabled');
});
