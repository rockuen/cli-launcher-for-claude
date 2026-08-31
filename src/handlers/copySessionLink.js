// @module handlers/copySessionLink — put a resume deep link on the clipboard.
//
// Called from the session-tree context menu, the in-panel toolbar 🔗 button,
// and the command palette. The link carries the session's own cwd so clicking
// it later lands in (or opens) the right editor window — see uri/sessionUriHandler.

const vscode = require('vscode');
const state = require('./../state');
const { t } = require('../i18n');
const { buildSessionLink } = require('../lib/sessionLink');

const FALLBACK_EXTENSION_ID = 'rockuen.cli-launcher-for-claude';

function extensionId(context) {
  return (context && context.extension && context.extension.id) || FALLBACK_EXTENSION_ID;
}

// Claude sessions are stored per workspace and resume without an explicit cwd,
// so their link uses this window's folder; the other agents carry their own.
function defaultCwd() {
  const folders = vscode.workspace.workspaceFolders || [];
  return folders.length ? folders[0].uri.fsPath : undefined;
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {{sessionId?:string, agent?:string, cwd?:string, title?:string}} source
 */
async function copySessionLink(context, source) {
  const src = source || {};
  const link = buildSessionLink({
    scheme: vscode.env.uriScheme,
    extensionId: extensionId(context),
    sessionId: src.sessionId,
    agent: src.agent || 'claude',
    cwd: src.cwd || defaultCwd(),
    title: src.title,
  });

  if (!link) {
    vscode.window.showWarningMessage(t('sessionLinkFailed'));
    return null;
  }

  await vscode.env.clipboard.writeText(link);
  vscode.window.showInformationMessage(t('sessionLinkCopied'));
  return link;
}

/** Tree context-menu entry point — reads the fields the tree stamps on items. */
function copySessionLinkFromTreeItem(context, item) {
  if (!item || !item._sessionId) {
    vscode.window.showWarningMessage(t('sessionLinkFailed'));
    return Promise.resolve(null);
  }
  return copySessionLink(context, {
    sessionId: item._sessionId,
    agent: item._agent || 'claude',
    cwd: item._cwd,
    title: typeof item.label === 'string' ? item.label : undefined,
  });
}

/** Toolbar / command-palette entry point — uses the focused launcher panel. */
function copySessionLinkFromPanel(context, tabId) {
  const id = tabId || state.activeTabId;
  const entry = id ? state.panels.get(id) : null;
  if (!entry || !entry.sessionId) {
    vscode.window.showWarningMessage(t('sessionLinkNoSession'));
    return Promise.resolve(null);
  }
  return copySessionLink(context, {
    sessionId: entry.sessionId,
    agent: entry.agent || 'claude',
    cwd: entry.cwd,
    title: entry.title,
  });
}

module.exports = { copySessionLink, copySessionLinkFromTreeItem, copySessionLinkFromPanel };
