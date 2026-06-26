// Claude `--effort` resolution shared by fresh spawns (createPanel) and
// restarts (restartPty). The Claude CLI accepts `--effort <low|medium|high|
// xhigh|max>`; any other value triggers a "Unknown --effort value" warning and
// falls back to the default. We expose `auto` in the UI to mean "let Claude pick
// its default" — i.e. pass no `--effort` flag at all.
//
// Backward compat: older builds used a boolean `autoEffortMax` (true = max).
// When the new `claude.effort` setting is still at its `auto` default but a user
// had the legacy flag on, we honor it as `max` so existing setups don't change.

// Values the CLI actually accepts for `--effort`.
const VALID_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];

// Options offered in the settings dropdown. `auto` = CLI default (no flag).
const EFFORT_OPTIONS = ['auto', ...VALID_EFFORT];

/**
 * Resolve the effective effort level from launcher config.
 * @param {{ get: (key: string, def?: any) => any }} cfg `claudeCodeLauncher` configuration
 * @returns {string|null} a valid effort level, or null for "auto" (no flag)
 */
function resolveClaudeEffort(cfg) {
  let level = cfg.get('claude.effort', 'auto');
  // Legacy fallback: only when the user hasn't picked an explicit level.
  if (level === 'auto' && cfg.get('autoEffortMax', false)) level = 'max';
  return VALID_EFFORT.includes(level) ? level : null;
}

/**
 * Build the spawn args for the resolved effort. Empty when "auto".
 * @param {{ get: (key: string, def?: any) => any }} cfg `claudeCodeLauncher` configuration
 * @returns {string[]} `['--effort', <level>]` or `[]`
 */
function claudeEffortArgs(cfg) {
  const level = resolveClaudeEffort(cfg);
  return level ? ['--effort', level] : [];
}

module.exports = { VALID_EFFORT, EFFORT_OPTIONS, resolveClaudeEffort, claudeEffortArgs };
