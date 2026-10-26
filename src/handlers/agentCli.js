// @module handlers/agentCli — runs the IPC server behind the `cli-launcher`
// command and hands each tab's PTY the environment that reaches it.
//
// Protocol, server and session operations live in lib/agentCli (vscode-free).
// This module binds them to the live panels: title lookup, rename, and the
// deep-link resume path the URI handler already uses.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const state = require('../state');
const {
  newNonce,
  makeIpcPath,
  stripAgentCliEnv,
  buildAgentCliEnv,
  createAgentCliServer,
  createSessionOps,
} = require('../lib/agentCli');
const { getSessionJsonlPath, extractAiTitle } = require('../lib/sessionJsonl');
const { notificationText } = require('../lib/sessionLink');
const { sessionStoreGet, sessionStoreUpdate } = require('../store/sessionStore');
const { saveSessions, isDefaultTabTitle } = require('../store/sessionManager');

const FALLBACK_EXTENSION_ID = 'rockuen.cli-launcher-for-claude';

// Agents whose transcript carries a title extractAiTitle can read. For the
// others the lookup would only walk their session tree for nothing.
const AUTO_TITLE_AGENTS = new Set(['claude', 'gjc']);

// { ipcPath, nonce, binDir, nodeRuntime, scheme } once started; null when the
// feature is off or the server failed, so tabs get no endpoint.
let running = null;

// Title for a session link, best first: a name the user gave the tab, the
// Sessions view's stored title, then the agent's own auto-title.
function titleFor(entry, sessionId) {
  const agent = entry.agent || 'claude';
  if (entry.title && !isDefaultTabTitle(entry.title)) return entry.title;
  try {
    const titles = sessionStoreGet(`${agent}SessionTitles`, {});
    if (titles && typeof titles[sessionId] === 'string' && titles[sessionId]) return titles[sessionId];
  } catch (_) {}
  if (!AUTO_TITLE_AGENTS.has(agent)) return null;
  try {
    const file = getSessionJsonlPath(sessionId, entry.cwd, agent);
    if (file && fs.existsSync(file)) return extractAiTitle(file, agent) || null;
  } catch (_) {}
  return null;
}

// Same effect as the Rename Tab command: the tab title, the in-panel title,
// and (through saveSessions) the per-agent title store the Sessions view reads.
// `also.sessionId` is Claude's live id after /clear, titled as well.
function renameEntry(entry, title, also) {
  entry.title = title;
  try { entry.panel.title = title; } catch (_) {}
  try { entry.panel.webview.postMessage({ type: 'title-updated', title }); } catch (_) {}
  saveSessions();
  const liveId = also && also.sessionId;
  if (liveId && liveId !== entry.sessionId) {
    const key = `${entry.agent || 'claude'}SessionTitles`;
    try {
      const titles = sessionStoreGet(key, {});
      titles[liveId] = title;
      sessionStoreUpdate(key, titles);
      state.refreshSessionTrees();
    } catch (_) {}
  }
}

// An agent asking to resume a session spawns processes (an agent CLI, maybe an
// editor window), so it waits for the user's click. Switching to a tab that is
// already open is harmless and happens at once.
function requestOpen(context, link, caller) {
  const { handleLink, revealExistingPanel } = require('../uri/sessionUriHandler');
  if (revealExistingPanel(link.sessionId)) return 'revealed';
  // Agent-supplied text, kept plain and short (see notificationText). The
  // folder comes first so a long title cannot push it out of view.
  const who = notificationText((caller && caller.title) || 'a launcher tab', 60);
  const where = link.cwd ? `in ${notificationText(link.cwd, 160)}: ` : '';
  const what = `${link.agent} session ${link.title ? `"${notificationText(link.title, 80)}"` : link.sessionId}`;
  vscode.window
    .showInformationMessage(`The agent in "${who}" wants to open ${where}${what}.`, 'Open')
    .then((choice) => {
      if (choice === 'Open') handleLink(context, link);
    });
  return 'confirm';
}

function ensureExecutable(file) {
  if (process.platform === 'win32') return;
  try {
    const mode = fs.statSync(file).mode;
    if ((mode & 0o111) !== 0o111) fs.chmodSync(file, mode | 0o755);
  } catch (_) {}
}

/** Start the server (once per activation). Safe to call when disabled. */
function startAgentCli(context) {
  if (running) return running;
  const cfg = vscode.workspace.getConfiguration('claudeCodeLauncher');
  if (!cfg.get('agentCli.enabled', true)) return null;

  const binDir = path.join(context.extensionPath, 'bin', 'path');
  if (!fs.existsSync(binDir)) return null;
  // vsix extraction does not promise to keep the executable bit.
  ensureExecutable(path.join(binDir, 'cli-launcher'));

  const scheme = vscode.env.uriScheme || 'vscode';
  const ipcPath = makeIpcPath();
  const nonce = newNonce();
  const extensionId = (context.extension && context.extension.id) || FALLBACK_EXTENSION_ID;
  const version = (context.extension && context.extension.packageJSON && context.extension.packageJSON.version) || null;

  const handlers = createSessionOps({
    getPanels: () => state.panels.entries(),
    scheme,
    extensionId,
    version,
    titleFor,
    rename: renameEntry,
    openLink: (link, caller) => requestOpen(context, link, caller),
  });
  const server = createAgentCliServer({ ipcPath, nonce, handlers });

  // Tabs restored during activation may spawn before listen() resolves; the
  // endpoint is fixed up front, so their environment is already right.
  const started = {
    ipcPath,
    nonce,
    binDir,
    // The editor's own runtime: always present and recent, unlike a user Node.
    nodeRuntime: process.execPath,
    scheme,
  };
  running = started;
  server.listen().catch((e) => {
    console.error('[agent-cli] IPC server failed to start:', (e && e.message) || e);
    // Tabs started from now on get no endpoint instead of a dead one.
    if (running === started) running = null;
  });
  context.subscriptions.push({
    dispose: () => {
      server.close();
      if (running === started) running = null;
    },
  });
  return running;
}

/**
 * Give a tab's PTY environment the agent CLI variables (mutates `env`).
 * Inherited CLI_LAUNCHER_* are always dropped first. `enabled: false` (tmux /
 * psmux tabs: the server's environment wins over the client's, so a second
 * tab would act as the first) leaves the tab without the command.
 * @param {Record<string,string>} env the environment the PTY gets otherwise
 * @param {{tabId:any, agent?:string, cwd?:string, enabled?:boolean}} tab
 */
function applyAgentCliEnv(env, tab) {
  stripAgentCliEnv(env);
  if (!running || tab.enabled === false) return env;
  try {
    Object.assign(env, buildAgentCliEnv({
      ...running,
      tabId: tab.tabId,
      agent: tab.agent,
      cwd: tab.cwd,
    }, env));
  } catch (e) {
    console.error('[agent-cli] env build failed (non-fatal):', (e && e.message) || e);
  }
  return env;
}

module.exports = { startAgentCli, applyAgentCliEnv, _test: { titleFor, renameEntry } };
