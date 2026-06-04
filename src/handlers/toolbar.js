// @module handlers/toolbar — toolbar button actions.
// new-tab requires createPanel + pickAgent injection (extension.js owns panel creation).

async function handleToolbar(action, entry, context, extensionPath, createPanel, pickAgent) {
  switch (action) {
    case 'compact':
      if (entry.pty) entry.pty.write('/compact\r');
      break;
    case 'clear':
      if (entry.pty) entry.pty.write('/clear\r');
      break;
    case 'new-tab': {
      // Launch the default agent directly (claudeCodeLauncher.agent) — no agent
      // QuickPick. createPanel resolves the default when none is forced. (The
      // pickAgent param is kept for signature compatibility but no longer used.)
      createPanel(context, extensionPath, null, {});
      break;
    }
  }
}

module.exports = { handleToolbar };
