// @module state — module-local singleton for runtime state shared across modules.
// We deliberately avoid DI/EventEmitter here: the extension runs in a single
// activate() context with no test harness, and singleton readability beats the
// indirection cost of a DI container.

const state = {
  panels: new Map(),       // tabId → entry
  tabCounter: 0,
  statusBar: null,         // vscode.StatusBarItem
  sessionTreeProvider: null,
  context: null,           // ExtensionContext, injected at activate()
  isDeactivating: false,
  // v3.6.2: opt-in Diagnostics instance. Null when
  // claudeCodeLauncher.diagnostics.enabled is false. createPanel.js's
  // onData hot-path uses optional chaining so the disabled cost is one
  // null check per PTY chunk.
  diagnostics: null,
};

module.exports = state;
