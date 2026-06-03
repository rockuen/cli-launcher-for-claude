// @module tree/QuickActionsProvider — top-of-container "Quick Actions" view.
//
// A small, flat TreeDataProvider that surfaces the launcher's primary actions
// as clickable rows at the very top of the sidebar container:
//   - one "New <Agent> Session" row per agent that is BOTH installed AND
//     enabled (claudeCodeLauncher.enabledAgents) — derived from listAgents() so
//     toggling kiro off in settings drops its row automatically (call refresh()
//     from the enabledAgents config-change handler).
//   - a "Hand off to other agent" row (claude↔kiro handoff).
//
// The settings ⚙ lives in this view's view/title (navigation@0); the per-agent
// session views no longer carry the ⚙ — it's consolidated here. Rows fire the
// unified claudeCodeLauncher.newSession command (agentId argument) and the
// existing handoffToOther command.

const vscode = require('vscode');
const { listAgents } = require('../agents/registry');

class QuickActionsProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = element.icon;
    item.command = element.command;
    return item;
  }

  getChildren(element) {
    if (element) return [];
    const enabled = vscode.workspace
      .getConfiguration('claudeCodeLauncher')
      .get('enabledAgents', ['claude', 'kiro']);
    const actions = [];
    for (const a of listAgents()) {
      if (!a.installed || !enabled.includes(a.id)) continue;
      actions.push({
        label: `New ${a.label} Session`,
        icon: new vscode.ThemeIcon('add'),
        command: {
          command: 'claudeCodeLauncher.newSession',
          title: `New ${a.label} Session`,
          arguments: [a.id],
        },
      });
    }
    actions.push({
      label: 'Hand off to other agent',
      icon: new vscode.ThemeIcon('arrow-swap'),
      command: {
        command: 'claudeCodeLauncher.handoffToOther',
        title: 'Hand off to other agent',
      },
    });
    return actions;
  }
}

module.exports = { QuickActionsProvider };
