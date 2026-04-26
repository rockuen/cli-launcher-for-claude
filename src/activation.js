// @module activation — activate()/deactivate() lifecycle hooks.
// Exposes 10 commands under the `claudeCodeLauncher.*` prefix (legacy identifier,
// do NOT rename — user keybindings.json depends on it).
//
// activate() flow (order is load-bearing):
//   1. state.context / isDeactivating
//   2. migrateFromWorkspaceState (legacy workspaceState → sessions.json)
//   3. statusBar creation + show
//   4. 10 command registrations (each subscriptions.push)
//   5. SessionTreeDataProvider + treeView + expand/collapse tracking
//   6. restoreSessions (MUST be last — earlier restore would try to refresh
//      a treeView that isn't registered yet)

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { t } = require('./i18n');
const state = require('./state');
const { sessionStoreGet, sessionStoreUpdate, migrateFromWorkspaceState } = require('./store/sessionStore');
const { saveSessions, restoreSessions } = require('./store/sessionManager');
const { killPtyProcess } = require('./pty/kill');
const { SessionTreeDataProvider } = require('./tree/SessionTreeDataProvider');
const { setStatusBar } = require('./panel/statusIndicator');
const { createPanel } = require('./panel/createPanel');
const { MAX_DEPTH, pathDepth, getParentPath, getLeafName, getDescendants, isAddAllowed } = require('./util/groupPath');

function activate(context) {
  state.context = context;
  state.isDeactivating = false;
  const extensionPath = context.extensionPath;

  // Migrate legacy workspaceState data to JSON file
  migrateFromWorkspaceState(context);

  state.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  state.statusBar.command = 'claudeCodeLauncher.open';
  setStatusBar('idle');
  state.statusBar.show();
  context.subscriptions.push(state.statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.open', (opts) => {
      createPanel(context, extensionPath, null, opts || {});
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.renameTab', async () => {
      let activeEntry = null;
      for (const [, entry] of state.panels) {
        if (entry.panel.active) { activeEntry = entry; break; }
      }
      if (!activeEntry) {
        vscode.window.showWarningMessage(t('noActiveTab'));
        return;
      }
      const newName = await vscode.window.showInputBox({
        prompt: t('enterTabName'),
        value: activeEntry.title
      });
      if (newName) {
        activeEntry.title = newName;
        activeEntry.panel.title = newName;
        saveSessions();
      }
    })
  );

  // Session tree view — v2.6.0: register TreeDragAndDropController via provider
  state.sessionTreeProvider = new SessionTreeDataProvider(context);
  const treeView = vscode.window.createTreeView('claudeCodeLauncher.sessionList', {
    treeDataProvider: state.sessionTreeProvider,
    dragAndDropController: state.sessionTreeProvider,
    canSelectMany: true
  });
  context.subscriptions.push(treeView);

  // Track expanded groups. For custom groups use _groupName (full path) so
  // nested groups at the same leaf name are distinguished. Fall back to the
  // label-stripped value for built-in groups (Resume Later, Recent, Trash).
  treeView.onDidExpandElement(e => {
    const key = e.element._groupName || (e.element.label ? String(e.element.label).replace(/\s*\(\d+\)$/, '') : null);
    if (key) state.sessionTreeProvider._expandedGroups.add(key);
  });
  treeView.onDidCollapseElement(e => {
    const key = e.element._groupName || (e.element.label ? String(e.element.label).replace(/\s*\(\d+\)$/, '') : null);
    if (key) state.sessionTreeProvider._expandedGroups.delete(key);
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.refreshSessions', () => {
      state.sessionTreeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.resumeSession', (sessionId, opts) => {
      const titleMap = sessionStoreGet('claudeSessionTitles', {});
      const title = titleMap[sessionId] || undefined;
      // Remove from saved sessions list when resuming
      const saved = sessionStoreGet('claudeSavedSessions', []);
      const filtered = saved.filter(s => s.sessionId !== sessionId);
      if (filtered.length !== saved.length) {
        sessionStoreUpdate('claudeSavedSessions', filtered);
      }
      const backend = (opts && opts.backend) || vscode.workspace
        .getConfiguration('claudeCodeLauncher')
        .get('terminal.defaultBackend', 'webview');
      createPanel(context, extensionPath, { sessionId, title }, { backend });
    }),
    // Phase 10 — explicit backend override commands for the tree context menu.
    // The tree's default click still goes through resumeSession (default backend);
    // these two let the user resume the same session in the other backend
    // without flipping the global default.
    vscode.commands.registerCommand('claudeCodeLauncher.resumeSessionInWebview', (item) => {
      const sessionId = typeof item === 'string' ? item : item && item._sessionId;
      if (!sessionId) return;
      return vscode.commands.executeCommand(
        'claudeCodeLauncher.resumeSession',
        sessionId,
        { backend: 'webview' }
      );
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.resumeSessionInMultiplexer', (item) => {
      const sessionId = typeof item === 'string' ? item : item && item._sessionId;
      if (!sessionId) return;
      return vscode.commands.executeCommand(
        'claudeCodeLauncher.resumeSession',
        sessionId,
        { backend: 'multiplexer' }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.moveToGroup', async (item) => {
      const sessionId = item?._sessionId;
      if (!sessionId) return;
      const groups = sessionStoreGet('claudeSessionGroups', {});
      const groupNames = Object.keys(groups);
      // Build indented picks: 'Work', '  Backend', '    API'
      const indentedPicks = groupNames.map(n => {
        const depth = pathDepth(n);
        const indent = '  '.repeat(depth - 1);
        return { label: indent + getLeafName(n), description: n, _fullPath: n };
      });
      const ADD_NEW = '$(add) New Group...';
      const ADD_SUB = '$(add) New Sub-Group...';
      const REMOVE = '$(close) Remove from Group';
      const pickItems = [
        ...indentedPicks,
        { label: ADD_NEW, _fullPath: ADD_NEW },
        { label: ADD_SUB, _fullPath: ADD_SUB },
        { label: REMOVE, _fullPath: REMOVE }
      ];
      const choice = await vscode.window.showQuickPick(pickItems, { placeHolder: 'Move session to group...' });
      if (!choice) return;
      // Remove from all existing groups first
      for (const g of Object.keys(groups)) {
        groups[g] = groups[g].filter(id => id !== sessionId);
        if (groups[g].length === 0) delete groups[g];
      }
      // Also remove from legacy saved/archived
      const saved = sessionStoreGet('claudeSavedSessions', []);
      sessionStoreUpdate('claudeSavedSessions', saved.filter(s => s.sessionId !== sessionId));
      const archived = sessionStoreGet('claudeArchivedSessions', []);
      sessionStoreUpdate('claudeArchivedSessions', archived.filter(s => s.sessionId !== sessionId));
      if (choice._fullPath === REMOVE) {
        // Just remove, already done above
      } else if (choice._fullPath === ADD_NEW) {
        const name = await vscode.window.showInputBox({ prompt: 'Group name' });
        if (name && name.trim() && !name.includes('/')) {
          if (!groups[name]) groups[name] = [];
          groups[name].push(sessionId);
        } else if (name) {
          vscode.window.showErrorMessage('Group name cannot contain "/".');
        }
      } else if (choice._fullPath === ADD_SUB) {
        // Step 1: pick parent group
        const parentPicks = groupNames
          .filter(n => isAddAllowed(n))
          .map(n => {
            const depth = pathDepth(n);
            const indent = '  '.repeat(depth - 1);
            return { label: indent + getLeafName(n), description: n, _fullPath: n };
          });
        if (parentPicks.length === 0) {
          vscode.window.showErrorMessage(`Maximum group depth (${MAX_DEPTH}) reached.`);
          return;
        }
        const parentChoice = await vscode.window.showQuickPick(parentPicks, { placeHolder: 'Select parent group...' });
        if (!parentChoice) return;
        const leafName = await vscode.window.showInputBox({ prompt: 'Sub-group name' });
        if (!leafName || !leafName.trim() || leafName.includes('/')) {
          if (leafName !== undefined) vscode.window.showErrorMessage('Sub-group name cannot be empty or contain "/".');
          return;
        }
        const newPath = `${parentChoice._fullPath}/${leafName.trim()}`;
        if (!groups[newPath]) groups[newPath] = [];
        groups[newPath].push(sessionId);
      } else {
        const targetPath = choice._fullPath;
        if (!groups[targetPath]) groups[targetPath] = [];
        groups[targetPath].push(sessionId);
      }
      sessionStoreUpdate('claudeSessionGroups', groups);
      if (state.sessionTreeProvider) state.sessionTreeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.deleteGroup', async (item) => {
      const groups = sessionStoreGet('claudeSessionGroups', {});
      const choice = item?._groupName;
      if (!choice || !(choice in groups)) return;
      // Confirm
      const descendants = getDescendants(groups, choice);
      const toDelete = [choice, ...descendants];
      const sessionCount = toDelete.reduce((s, p) => s + (groups[p] ? groups[p].length : 0), 0);
      const detail = descendants.length > 0
        ? `This will also delete ${descendants.length} sub-group(s). ${sessionCount} session(s) will be moved to Recent Sessions.`
        : sessionCount > 0
          ? `${sessionCount} session(s) will be moved to Recent Sessions.`
          : '';
      const confirm = await vscode.window.showWarningMessage(
        `Delete group "${choice}"?${detail ? ' ' + detail : ''}`,
        { modal: true }, 'Delete'
      );
      if (confirm !== 'Delete') return;
      // Remove all descendant + self groups (sessions become ungrouped)
      for (const p of toDelete) {
        delete groups[p];
      }
      sessionStoreUpdate('claudeSessionGroups', groups);
      if (state.sessionTreeProvider) state.sessionTreeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.renameGroup', async (item) => {
      const groups = sessionStoreGet('claudeSessionGroups', {});
      const oldFullPath = item?._groupName;
      if (!oldFullPath || !(oldFullPath in groups)) return;
      const currentLeaf = getLeafName(oldFullPath);
      const newLeaf = await vscode.window.showInputBox({ prompt: 'New group name (leaf only)', value: currentLeaf });
      if (!newLeaf || !newLeaf.trim() || newLeaf === currentLeaf) return;
      if (newLeaf.includes('/')) {
        vscode.window.showErrorMessage('Group name cannot contain "/".');
        return;
      }
      const parentPath = getParentPath(oldFullPath);
      const newFullPath = parentPath ? `${parentPath}/${newLeaf.trim()}` : newLeaf.trim();
      if (pathDepth(newFullPath) > MAX_DEPTH) {
        vscode.window.showErrorMessage(`Maximum group depth (${MAX_DEPTH}) reached.`);
        return;
      }
      if (newFullPath === oldFullPath) return;
      // Rename: this group + all descendants
      const descendants = getDescendants(groups, oldFullPath);
      const toRename = [oldFullPath, ...descendants];
      // Build replacement in key order
      const allKeys = Object.keys(groups);
      const rebuilt = {};
      for (const k of allKeys) {
        if (toRename.includes(k)) {
          const newKey = newFullPath + k.substring(oldFullPath.length);
          rebuilt[newKey] = groups[k];
        } else {
          rebuilt[k] = groups[k];
        }
      }
      // Update expanded state
      const exp = state.sessionTreeProvider._expandedGroups;
      for (const old of toRename) {
        if (exp.has(old)) {
          exp.delete(old);
          exp.add(newFullPath + old.substring(oldFullPath.length));
        }
      }
      sessionStoreUpdate('claudeSessionGroups', rebuilt);
      if (state.sessionTreeProvider) state.sessionTreeProvider.refresh();
    })
  );

  // Trash: delete session (move .jsonl to trash/)
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.trashSession', async (item) => {
      const sessionId = item?._sessionId;
      if (!sessionId) return;
      const projDir = state.sessionTreeProvider._getProjectDir();
      if (!projDir) return;
      const src = path.join(projDir, sessionId + '.jsonl');
      if (!fs.existsSync(src)) return;
      const trashDir = path.join(projDir, 'trash');
      if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir, { recursive: true });
      fs.renameSync(src, path.join(trashDir, sessionId + '.jsonl'));
      // Remove from all groups
      const groups = sessionStoreGet('claudeSessionGroups', {});
      for (const g of Object.keys(groups)) {
        groups[g] = groups[g].filter(id => id !== sessionId);
        if (groups[g].length === 0) delete groups[g];
      }
      sessionStoreUpdate('claudeSessionGroups', groups);
      const saved = sessionStoreGet('claudeSavedSessions', []);
      sessionStoreUpdate('claudeSavedSessions', saved.filter(s => s.sessionId !== sessionId));
      if (state.sessionTreeProvider) state.sessionTreeProvider.refresh();
    })
  );

  // Trash: restore session
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.restoreSession', async (item) => {
      const sessionId = item?._sessionId;
      if (!sessionId) return;
      const projDir = state.sessionTreeProvider._getProjectDir();
      if (!projDir) return;
      const trashDir = path.join(projDir, 'trash');
      const src = path.join(trashDir, sessionId + '.jsonl');
      if (!fs.existsSync(src)) return;
      fs.renameSync(src, path.join(projDir, sessionId + '.jsonl'));
      if (state.sessionTreeProvider) state.sessionTreeProvider.refresh();
    })
  );

  // v2.6.0: sort + nesting commands
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.moveSessionUp', (item) => {
      const sid = item?._sessionId;
      if (sid) state.sessionTreeProvider.moveSessionUp(sid);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.moveSessionDown', (item) => {
      const sid = item?._sessionId;
      if (sid) state.sessionTreeProvider.moveSessionDown(sid);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.moveUnderSession', async (item) => {
      const sid = item?._sessionId;
      if (!sid) return;
      // Build candidate list: top-level sessions only (parent empty), not self
      const parents = sessionStoreGet('claudeSessionParent', {});
      const titleMap = sessionStoreGet('claudeSessionTitles', {});
      const projDir = state.sessionTreeProvider._getProjectDir();
      if (!projDir) return;
      const files = fs.readdirSync(projDir).filter(f => f.endsWith('.jsonl'));
      const hasChildrenOfMe = Object.values(parents).some(p => p === sid);
      if (hasChildrenOfMe) {
        vscode.window.showWarningMessage(t('nestDepthErr'));
        return;
      }
      const candidates = [];
      for (const f of files) {
        const cid = f.replace('.jsonl', '');
        if (cid === sid) continue;
        if (parents[cid]) continue; // can't nest under a sub-session
        const label = titleMap[cid] || cid.substring(0, 8);
        candidates.push({ label, detail: cid, sessionId: cid });
      }
      if (candidates.length === 0) {
        vscode.window.showInformationMessage(t('nestNoCandidates'));
        return;
      }
      const pick = await vscode.window.showQuickPick(candidates, {
        placeHolder: t('nestPickPlaceholder'),
        matchOnDetail: true
      });
      if (!pick) return;
      const result = state.sessionTreeProvider.setSessionParent(sid, pick.sessionId);
      if (!result.ok) {
        const reasons = { self: t('nestSelfErr'), depth: t('nestDepthErr'), hasChildren: t('nestHasChildrenErr') };
        vscode.window.showWarningMessage(reasons[result.reason] || 'Failed to nest');
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.removeSessionParent', (item) => {
      const sid = item?._sessionId;
      if (sid) state.sessionTreeProvider.removeSessionParent(sid);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.moveGroupUp', (item) => {
      const name = item?._groupName;
      if (name) state.sessionTreeProvider.moveGroupUp(name);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.moveGroupDown', (item) => {
      const name = item?._groupName;
      if (name) state.sessionTreeProvider.moveGroupDown(name);
    })
  );

  // Phase 13: add a sub-group under a given group node
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.addSubGroup', async (item) => {
      const parentPath = item?._groupName;
      if (!parentPath) return;
      if (!isAddAllowed(parentPath)) {
        vscode.window.showErrorMessage(`Maximum group depth (${MAX_DEPTH}) reached.`);
        return;
      }
      const leafName = await vscode.window.showInputBox({ prompt: `New sub-group name under "${parentPath}"` });
      if (leafName === undefined) return; // cancelled
      if (!leafName.trim()) {
        vscode.window.showErrorMessage('Sub-group name cannot be empty.');
        return;
      }
      if (leafName.includes('/')) {
        vscode.window.showErrorMessage('Sub-group name cannot contain "/".');
        return;
      }
      const newPath = `${parentPath}/${leafName.trim()}`;
      const groups = sessionStoreGet('claudeSessionGroups', {});
      if (!groups[newPath]) groups[newPath] = [];
      sessionStoreUpdate('claudeSessionGroups', groups);
      if (state.sessionTreeProvider) state.sessionTreeProvider.refresh();
    })
  );

  // Trash: empty all
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.emptyTrash', async () => {
      const projDir = state.sessionTreeProvider._getProjectDir();
      if (!projDir) return;
      const trashDir = path.join(projDir, 'trash');
      if (!fs.existsSync(trashDir)) return;
      const files = fs.readdirSync(trashDir).filter(f => f.endsWith('.jsonl'));
      if (files.length === 0) return;
      const confirm = await vscode.window.showWarningMessage(
        `Delete ${files.length} session(s) permanently?`, { modal: true }, 'Delete'
      );
      if (confirm === 'Delete') {
        for (const f of files) fs.unlinkSync(path.join(trashDir, f));
        if (state.sessionTreeProvider) state.sessionTreeProvider.refresh();
      }
    })
  );

  // Phase 4 — orchestration layer (OMC mode + future OMC-dependent UI).
  const orchestration = require('../out/orchestration');
  const orchestrationOutput = vscode.window.createOutputChannel('CLI Launcher — Orchestration');
  context.subscriptions.push(orchestrationOutput);
  orchestration.activate(context, orchestrationOutput).catch((err) => {
    orchestrationOutput.appendLine(`[orch] activate failed: ${err}`);
  });

  // Restore previous sessions (MUST be last — tree + commands must be ready first)
  restoreSessions(s => {
    const backend = vscode.workspace
      .getConfiguration('claudeCodeLauncher')
      .get('terminal.defaultBackend', 'webview');
    createPanel(context, extensionPath, s, { backend });
  });
}

function deactivate() {
  state.isDeactivating = true;

  // Save sessions BEFORE cleanup so they survive reload
  if (state.context && state.panels.size > 0) {
    const sessions = [];
    let order = 0;
    for (const [, entry] of state.panels) {
      if (!entry.pty) continue; // don't restore dead sessions
      sessions.push({
        title: entry.title,
        memo: entry.memo || '',
        cwd: entry.cwd,
        sessionId: entry.sessionId,
        order: order++,
        viewColumn: entry.panel.viewColumn || 1
      });
    }
    sessionStoreUpdate('claudeSessions', sessions);
  }

  for (const [, entry] of state.panels) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    killPtyProcess(entry.pty);
  }
  state.panels.clear();
}

module.exports = { activate, deactivate };
