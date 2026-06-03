// @module handlers/pickAgent — QuickPick helper for selecting agent (claude/kiro).
// Returns the selected agent string, or null if the user cancelled (Esc).
// Caller should skip session creation on null.

const vscode = require('vscode');

async function pickAgent() {
  const def = vscode.workspace.getConfiguration('claudeCodeLauncher').get('agent') || 'claude';

  const items = [
    {
      label: `Claude${def === 'claude' ? ' (default)' : ''}`,
      description: 'claude code CLI',
      _agent: 'claude',
    },
    {
      label: `Kiro${def === 'kiro' ? ' (default)' : ''}`,
      description: 'kiro-cli',
      _agent: 'kiro',
    },
  ];

  // Bring the default item to the top.
  items.sort((a, b) => (b._agent === def ? 1 : 0) - (a._agent === def ? 1 : 0));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select agent for the new session',
  });

  if (!picked) return null;
  return picked._agent;
}

module.exports = { pickAgent };
