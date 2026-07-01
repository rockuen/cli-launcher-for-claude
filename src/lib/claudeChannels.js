// Claude `--channels` resolution for opt-in chat-bridge channels (Telegram, …).
//
// Mirrors src/lib/claudeEffort.js: read the launcher config and produce spawn
// args, empty when nothing is enabled. Channels are a Claude Code research-
// preview feature (v2.1.80+) that push events from Telegram/Discord/iMessage
// into a running session for a two-way chat bridge. This is entirely separate
// from gjc's one-way Telegram notifications (see handlers/telegramSettings.js).
//
// The full setup wizard (bot token, plugin install, pairing guidance) lives in
// handlers/claudeChannelSetup.js. This module only maps "which channels are
// toggled on" -> the `--channels plugin:<name>@<marketplace>` spawn flag.
//
// The CLI accepts several channel specs after a single `--channels` flag,
// space-separated on the command line — i.e. argv `['--channels', spec1, spec2]`.

'use strict';

// Channel key -> official plugin channel spec passed to `claude --channels`.
// Extend this map (e.g. discord) and add a matching package.json setting to
// support more channels; the wizard/UI wire up per key.
const CHANNEL_PLUGINS = {
  telegram: 'plugin:telegram@claude-plugins-official',
};

/**
 * Ordered list of channel keys the user has toggled on in launcher config.
 * @param {{ get: (key: string, def?: any) => any }} cfg `claudeCodeLauncher` configuration
 * @returns {string[]} e.g. ['telegram'] (empty when none enabled)
 */
function resolveEnabledChannels(cfg) {
  const enabled = [];
  for (const key of Object.keys(CHANNEL_PLUGINS)) {
    if (cfg.get('claude.channels.' + key + '.enabled', false)) enabled.push(key);
  }
  return enabled;
}

/**
 * Build the spawn args for enabled channels. Empty when none are on.
 * @param {{ get: (key: string, def?: any) => any }} cfg `claudeCodeLauncher` configuration
 * @returns {string[]} `['--channels', <spec>, …]` or `[]`
 */
function claudeChannelsArgs(cfg) {
  const specs = resolveEnabledChannels(cfg).map((k) => CHANNEL_PLUGINS[k]);
  return specs.length ? ['--channels', ...specs] : [];
}

module.exports = { CHANNEL_PLUGINS, resolveEnabledChannels, claudeChannelsArgs };
