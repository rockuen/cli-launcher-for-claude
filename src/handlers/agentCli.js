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
const { HOOK_COMMAND, claudeHookSettings } = require('../lib/agentNotify');
const { sessionStoreGet, sessionStoreUpdate } = require('../store/sessionStore');
const { saveSessions, isDefaultTabTitle } = require('../store/sessionManager');
const { setPanelTitle } = require('../panel/panelTitle');

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
  setPanelTitle(entry);
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

// v3.28.0: `cli-launcher notify` → the tab (createPanel entry._agentNotify:
// tab state + toast). A tab without the hook-up (none expected) still toasts.
function notifyEntry(entry, ev) {
  if (typeof entry._agentNotify === 'function') return entry._agentNotify(ev);
  const { showDesktopNotification } = require('./desktopNotification');
  const { notifyMessage } = require('../lib/agentNotify');
  showDesktopNotification(entry.title, notifyMessage(ev));
  return { attention: false, toast: true };
}

// The settings file a Claude tab gets with `--settings`: Stop / Notification
// hooks that run `cli-launcher notify --from-hook`. Written once per
// activation into this extension's global storage (no quoting of JSON on a
// command line, which a `claude.cmd` shim would re-parse through cmd).
function claudeHookSettingsFile(context) {
  const dir = context.globalStorageUri ? context.globalStorageUri.fsPath : context.globalStoragePath;
  if (!dir) return null;
  const file = path.join(dir, 'claude-agent-hooks.json');
  const content = JSON.stringify(claudeHookSettings(HOOK_COMMAND), null, 2);
  try {
    // Written only when missing or different: Claude processes in other
    // windows may be reading it, and a deleted file is put back.
    let current = null;
    try { current = fs.readFileSync(file, 'utf8'); } catch (_) {}
    if (current !== content) {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, content);
      try {
        fs.renameSync(tmp, file);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        throw e;
      }
    }
    return file;
  } catch (e) {
    console.error('[agent-cli] could not write the Claude hook settings (non-fatal):', (e && e.message) || e);
    return null;
  }
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
    notify: notifyEntry,
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
    context,
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
      ipcPath: running.ipcPath,
      nonce: running.nonce,
      binDir: running.binDir,
      nodeRuntime: running.nodeRuntime,
      scheme: running.scheme,
      tabId: tab.tabId,
      agent: tab.agent,
      cwd: tab.cwd,
    }, env));
  } catch (e) {
    console.error('[agent-cli] env build failed (non-fatal):', (e && e.message) || e);
  }
  return env;
}

/**
 * Extra `claude` arguments that wire this tab's Stop / Notification hooks to
 * `cli-launcher notify` (v3.28.0). Empty when the agent CLI is off, the tab
 * gets no `cli-launcher` (tmux/psmux), or claudeCodeLauncher.agentCli.claudeHooks
 * is off — the tab then keeps the guessed notifications.
 * @param {{enabled?:boolean}} [tab]
 */
function claudeHookArgs(tab) {
  if (!running || (tab && tab.enabled === false)) return [];
  // VSCodroid: SELinux may refuse to execute bin/path/cli-launcher from the
  // app's files dir — every hook would fail with a notice. Unverified, so off.
  if (process.platform === 'android') return [];
  const cfg = vscode.workspace.getConfiguration('claudeCodeLauncher');
  if (!cfg.get('agentCli.claudeHooks', true)) return [];
  const file = claudeHookSettingsFile(running.context);
  if (!file) return [];
  // An npm-installed claude runs through cmd.exe, which re-parses & ^ % | < > !
  // even inside the quoted path node-pty passes. Rare paths; keep guessing there.
  if (process.platform === 'win32' && /[&^%|<>!"]/.test(file)) return [];
  return ['--settings', file];
}

module.exports = { startAgentCli, applyAgentCliEnv, claudeHookArgs, _test: { titleFor, renameEntry, notifyEntry } };
