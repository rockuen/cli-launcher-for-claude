// @module state — module-local singleton for runtime state shared across modules.
// We deliberately avoid DI/EventEmitter here: the extension runs in a single
// activate() context with no test harness, and singleton readability beats the
// indirection cost of a DI container.

const state = {
  panels: new Map(),       // tabId → entry
  tabCounter: 0,
  statusBar: null,         // vscode.StatusBarItem
  sessionTreeProvider: null,  // 'Claude Sessions' view provider (agentMode 'claude')
  kiroTreeProvider: null,     // 'Kiro Sessions' view provider (agentMode 'kiro')
  antigravityTreeProvider: null, // 'Antigravity Sessions' view provider (agentMode 'antigravity')
  quickActionsProvider: null, // 'Quick Actions' top-of-container view provider
  context: null,           // ExtensionContext, injected at activate()
  isDeactivating: false,
  // Refresh both agent-scoped session views. Lifecycle events (PTY state
  // change, exit, restore) fire one of these; routing through the helper keeps
  // the kiro view live without sprinkling two refresh calls at every site.
  // Each provider's refresh() is debounced (500ms) so this stays cheap on the
  // PTY hot path. Null-safe so it works before activate() wires the providers.
  refreshSessionTrees() {
    if (this.sessionTreeProvider) this.sessionTreeProvider.refresh();
    if (this.kiroTreeProvider) this.kiroTreeProvider.refresh();
    if (this.antigravityTreeProvider) this.antigravityTreeProvider.refresh();
  },
  // v3.6.2: opt-in Diagnostics instance. Null when
  // claudeCodeLauncher.diagnostics.enabled is false. createPanel.js's
  // onData hot-path uses optional chaining so the disabled cost is one
  // null check per PTY chunk.
  diagnostics: null,
};

module.exports = state;
