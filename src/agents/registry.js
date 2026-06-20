// @module agents/registry — extensible registry of supported CLI agents.
//
// Single source of truth for which agents the launcher knows about. The global
// settings panel and pickAgent both read from here, so adding support for a new
// agent is a ONE-LINER: append an entry to the AGENTS array below (id, label,
// cliName, detect). It then appears automatically in the global-settings Agent
// category (with install-status badge + enable toggle) and, once enabled +
// installed, in the new-session QuickPick.
//
// `detect()` returns truthy when the agent's CLI is installed/resolvable on this
// machine (delegated to pty/resolveCli so detection stays consistent with the
// shell actually spawned).

const { resolveClaudeCli, resolveKiroCli, resolveAntigravityCli, resolveCodexCli, resolveGrokCli, resolveGjcCli, isChiefCliAvailable } = require('../pty/resolveCli');

const AGENTS = [
  { id: 'claude',      label: 'Claude Code', cliName: 'claude',   detect: () => !!resolveClaudeCli() },
  { id: 'kiro',        label: 'Kiro',        cliName: 'kiro-cli',  detect: () => !!resolveKiroCli() },
  { id: 'antigravity', label: 'Antigravity', cliName: 'agy',       detect: () => !!resolveAntigravityCli() },
  { id: 'codex',       label: 'Codex',       cliName: 'codex',     detect: () => !!resolveCodexCli() },
  { id: 'grok',        label: 'Grok',        cliName: 'grok',      detect: () => !!resolveGrokCli() },
  { id: 'gjc',         label: 'Gajae',       cliName: 'gjc',       detect: () => !!resolveGjcCli() },
  { id: 'chief',       label: 'Chief',       cliName: 'chief',     detect: () => isChiefCliAvailable() },
];

// Lightweight, serializable view of the registry for UIs (webview / QuickPick).
// `installed` is evaluated at call time so it reflects the current machine.
function listAgents() {
  return AGENTS.map((a) => ({
    id: a.id,
    label: a.label,
    cliName: a.cliName,
    installed: !!a.detect(),
  }));
}

function isKnownAgent(id) {
  return AGENTS.some((a) => a.id === id);
}

module.exports = { AGENTS, listAgents, isKnownAgent };
