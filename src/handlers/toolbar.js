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
      // The in-session toolbar "+" opens a new tab with the SAME agent as the
      // current session (entry.agent) — clicking "+" in a Kiro tab opens
      // another Kiro tab, in an Antigravity tab another Antigravity tab, etc.
      // No agent QuickPick — it inherits the current session's agent for a fast
      // same-agent new tab. (Contrast the robot/editor-title icon, which routes
      // through claudeCodeLauncher.open and DOES show the agent picker. The
      // pickAgent param is kept for signature compatibility but unused here.)
      createPanel(context, extensionPath, null, { agent: entry.agent });
      break;
    }
    case 'copy-link': {
      // v3.22.0: deep link to this exact session. Required lazily — toolbar.js
      // is loaded on the PTY path and copySessionLink pulls in `vscode`.
      const { copySessionLinkFromPanel } = require('./copySessionLink');
      await copySessionLinkFromPanel(context, entry.tabId);
      break;
    }
  }
}

module.exports = { handleToolbar };
