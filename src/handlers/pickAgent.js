// @module handlers/pickAgent — QuickPick helper for selecting the agent of a new session.
// Candidates = registry agents that are BOTH enabled (claudeCodeLauncher.enabledAgents)
// AND installed (detect()). Behaviour:
//   - 0 candidates → fall back to 'claude' (always-available default; no prompt).
//   - 1 candidate  → return it directly (no prompt).
//   - 2+           → QuickPick with the default agent (claudeCodeLauncher.agent) on top.
// Returns the selected agent id (string), or null if the user cancelled (Esc).
// Caller should skip session creation on null.

const vscode = require('vscode');
const { listAgents } = require('../agents/registry');

async function pickAgent() {
  const cfg = vscode.workspace.getConfiguration('claudeCodeLauncher');
  const def = cfg.get('agent') || 'claude';
  const enabled = cfg.get('enabledAgents', ['claude']);

  // enabled ∩ installed
  const candidates = listAgents().filter(
    (a) => enabled.includes(a.id) && a.installed
  );

  // 0 candidates → safe fallback (claude always works as the default backend).
  if (candidates.length === 0) return 'claude';

  // 1 candidate → no need to prompt.
  if (candidates.length === 1) return candidates[0].id;

  const items = candidates.map((a) => ({
    label: `${a.label}${a.id === def ? ' (default)' : ''}`,
    description: a.cliName,
    _agent: a.id,
  }));

  // Bring the default agent to the top.
  items.sort((a, b) => (b._agent === def ? 1 : 0) - (a._agent === def ? 1 : 0));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select agent for the new session',
  });

  if (!picked) return null;
  return picked._agent;
}

module.exports = { pickAgent };
