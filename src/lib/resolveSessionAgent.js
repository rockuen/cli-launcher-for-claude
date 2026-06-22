// @module lib/resolveSessionAgent — single source of truth for deciding which
// agent (claude / kiro / codex / grok / gjc / chief / antigravity) a panel runs.
//
// THE BUG THIS FIXES: an EXISTING session (resume from the tree, or auto-restore
// on reload) must keep its OWN agent and must NEVER inherit the configured
// `claudeCodeLauncher.agent` default. Previously the Claude resume path created
// the panel session WITHOUT an agent field, so the resolver fell through to the
// configured default — meaning a Claude session opened as Gajae Code (gjc)
// whenever gjc was set as the default agent. A Claude session must stay Claude,
// a gjc session must stay gjc, regardless of what the default is set to.
//
// Resolution order:
//   1. explicit force (opts.agent) — handoff / agent-scoped new-session commands
//      / backend-override resume — always wins.
//   2. EXISTING session → its own `session.agent`. Sessions persisted before the
//      agent field existed were always Claude, so a missing agent means 'claude'
//      — NOT the configured default.
//   3. BRAND-NEW session (no session object) → the configured default agent,
//      else 'claude'. The default agent only ever decides what a fresh, agentless
//      "open" / quick "+" launch spawns.
//
// `configuredDefaultAgent` is the value of `claudeCodeLauncher.agent` (may be
// undefined). Kept as a plain arg so this module stays vscode-free and unit
// testable.
function resolveSessionAgent({ optsAgent, session, configuredDefaultAgent } = {}) {
  if (optsAgent) return optsAgent;
  if (session) return session.agent || 'claude';
  return configuredDefaultAgent || 'claude';
}

module.exports = { resolveSessionAgent };
