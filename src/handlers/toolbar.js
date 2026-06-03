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
      const agent = pickAgent ? await pickAgent() : null;
      // null means the user cancelled the QuickPick — skip creation.
      if (agent === null && pickAgent) return;
      createPanel(context, extensionPath, null, agent ? { agent } : {});
      break;
    }
  }
}

module.exports = { handleToolbar };
