// @module handlers/pickAgent — QuickPick helper for selecting the agent of a new session.
// Candidates = registry agents that are BOTH enabled (claudeCodeLauncher.enabledAgents)
// AND installed (detect()), optionally minus an excluded agent (used by handoff
// to drop the source agent from the target list). Behaviour:
//   - 0 candidates → 'claude' fallback with no exclude; null when excluding
//                    (nothing left to pick — the caller decides what to show).
//   - 1 candidate  → return it directly (no prompt).
//   - 2+           → QuickPick with the default agent (claudeCodeLauncher.agent) on top.
// Returns the selected agent id (string), or null if the user cancelled (Esc) /
// nothing was available. Caller should skip session creation on null.
//
// @param {{ exclude?: string, placeHolder?: string }} [options]

const vscode = require('vscode');
const { listAgents } = require('../agents/registry');

async function pickAgent(options = {}) {
  const { exclude = null, placeHolder = 'Select agent for the new session' } = options;
  const cfg = vscode.workspace.getConfiguration('claudeCodeLauncher');
  const def = cfg.get('agent') || 'claude';
  const enabled = cfg.get('enabledAgents', ['claude']);

  // enabled ∩ installed, minus the excluded agent (if any).
  let candidates = listAgents().filter(
    (a) => enabled.includes(a.id) && a.installed
  );
  if (exclude) candidates = candidates.filter((a) => a.id !== exclude);

  // 0 candidates: claude is the always-available default when not excluding;
  // when excluding (handoff), null means "no other agent to hand off to".
  if (candidates.length === 0) return exclude ? null : 'claude';

  // 1 candidate → no need to prompt.
  if (candidates.length === 1) return candidates[0].id;

  const items = candidates.map((a) => ({
    label: `${a.label}${a.id === def ? ' (default)' : ''}`,
    description: a.cliName,
    _agent: a.id,
  }));

  // Bring the default agent to the top.
  items.sort((a, b) => (b._agent === def ? 1 : 0) - (a._agent === def ? 1 : 0));

  const picked = await vscode.window.showQuickPick(items, { placeHolder });

  if (!picked) return null;
  return picked._agent;
}

module.exports = { pickAgent };
