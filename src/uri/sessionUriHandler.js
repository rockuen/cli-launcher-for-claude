// @module uri/sessionUriHandler — resume a session from a deep link.
//
// `<scheme>://rockuen.cli-launcher-for-claude/resume?agent=…&session=…&cwd=…`
// clicked anywhere in the OS (a Burst todo link, a note, a chat message) opens
// the editor and re-opens that exact session tab.
//
// Window routing (see lib/windowRoute for why): the window that receives the
// URI resumes it when the session's cwd is inside its own workspace; otherwise
// it parks a pending record in globalStorage and launches the editor CLI on
// that folder, and the window that owns the folder claims the record — via the
// fs.watch below when it is already running, or via consumePendingResume()
// when the CLI had to open it fresh.

const vscode = require('vscode');
const fs = require('fs');
const state = require('./../state');
const { parseSessionLink } = require('../lib/sessionLink');
const { routeForLink, pendingFilePath, shouldClaimPending } = require('../lib/windowRoute');
const { openFolderWindow } = require('../lib/editorCli');

function workspaceFolderPaths() {
  return (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
}

function globalStorageDir(context) {
  const dir = context.globalStorageUri ? context.globalStorageUri.fsPath : context.globalStoragePath;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
  return dir;
}

// An already-open tab for this session wins over spawning a second one — a
// duplicate tab on the same session id would have two PTYs writing one
// transcript.
function revealExistingPanel(sessionId) {
  for (const entry of state.panels.values()) {
    if (entry && entry.sessionId === sessionId && entry.panel) {
      try {
        entry.panel.reveal(entry.panel.viewColumn);
        return true;
      } catch (_) {
        return false;
      }
    }
  }
  return false;
}

function resumeHere(link) {
  return vscode.commands.executeCommand('claudeCodeLauncher.resumeSession', link.sessionId, {
    agent: link.agent,
    cwd: link.cwd || undefined,
    title: link.title || undefined,
  });
}

function writePending(context, link) {
  const file = pendingFilePath(globalStorageDir(context));
  const payload = {
    sessionId: link.sessionId,
    agent: link.agent,
    cwd: link.cwd,
    title: link.title,
    ts: Date.now(),
  };
  try {
    fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

// Reading and deleting is the claim: whichever window unlinks the file first
// owns the resume, so two windows on overlapping folders cannot both act.
function claimPending(context) {
  const file = pendingFilePath(globalStorageDir(context));
  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
  if (!shouldClaimPending(pending, workspaceFolderPaths(), Date.now())) return null;
  try {
    fs.unlinkSync(file);
  } catch (_) {
    return null; // another window got there first
  }
  return pending;
}

function handleLink(context, link) {
  if (revealExistingPanel(link.sessionId)) return;

  if (routeForLink(link, workspaceFolderPaths()) === 'here') {
    resumeHere(link);
    return;
  }

  // The session belongs to another folder — hand it to that window.
  if (!writePending(context, link)) {
    resumeHere(link); // storage unavailable: better a tab here than nothing
    return;
  }
  const launched = openFolderWindow(link.cwd, vscode.env.appRoot);
  if (!launched) {
    // Nothing will claim the record — a stale one would fire at whichever
    // window opens that folder next, within the TTL. Take it back.
    try { fs.unlinkSync(pendingFilePath(globalStorageDir(context))); } catch (_) {}
    vscode.window.showWarningMessage(
      `Could not open a window for ${link.cwd}. Open that folder and click the link again.`
    );
  }
}

/** Claim a record left by another window (called once during activate). */
function consumePendingResume(context) {
  const pending = claimPending(context);
  if (pending) resumeHere(pending);
}

function registerSessionUriHandler(context) {
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri) {
        const link = parseSessionLink({ path: uri.path, query: uri.query });
        if (!link) {
          vscode.window.showWarningMessage(`Unrecognized session link: ${uri.toString()}`);
          return;
        }
        handleLink(context, link);
      },
    })
  );

  // A window that is already running gets no activate() call, so watch the
  // pending file for records addressed at this workspace.
  const dir = globalStorageDir(context);
  let watcher;
  try {
    watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
      if (filename && !String(filename).startsWith('pending-resume')) return;
      const pending = claimPending(context);
      if (pending) resumeHere(pending);
    });
  } catch (_) {
    watcher = null;
  }
  if (watcher) {
    context.subscriptions.push({ dispose: () => { try { watcher.close(); } catch (_) {} } });
  }

  // A record may already be waiting when this window is the one the CLI just
  // opened. Deferred so the tree providers exist before a panel is created.
  setTimeout(() => consumePendingResume(context), 1500);
}

module.exports = { registerSessionUriHandler, consumePendingResume, handleLink };
