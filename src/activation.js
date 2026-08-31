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
const { buildHandoffNote } = require('./lib/handoff');
const { buildRenamePrefill } = require('./lib/renamePrefix');
const { getSessionJsonlPath, extractMessages, listKiroSessions, listAntigravitySessions, listCodexSessions, listGrokSessions, listGjcSessions, findCodexSessionPath, findGrokSessionPath, findGjcSessionPath, findChiefSessionPath } = require('./lib/sessionJsonl');
const { getKiroSessionsDir, getCodexPaths, getGrokPaths, getGjcPaths, getChiefPaths, getAntigravityBaseDir } = require('./lib/projectSessions');
const { writePtyChunked } = require('./pty/write');
const { sessionStoreGet, sessionStoreUpdate, deviceLocalSet, migrateFromWorkspaceState } = require('./store/sessionStore');
const { saveSessions, restoreSessions } = require('./store/sessionManager');
const { killPtyProcess } = require('./pty/kill');
const { SessionTreeDataProvider } = require('./tree/SessionTreeDataProvider');
const { QuickActionsProvider } = require('./tree/QuickActionsProvider');
const { SessionDecorationProvider } = require('./tree/SessionDecorationProvider');
const { setStatusBar } = require('./panel/statusIndicator');
const { createPanel } = require('./panel/createPanel');
const { pickAgent } = require('./handlers/pickAgent');
const { pickGjcModel, setupGjcCredentials } = require('./handlers/gjcModel');
const { promptAndSetupTelegram, disableTelegram: disableGjcTelegram, detectTelegramSupport } = require('./handlers/telegramSettings');
const { promptAndSetupTelegramChannel, disableTelegramChannel } = require('./handlers/claudeChannelSetup');
const { listAgents } = require('./agents/registry');
const { copySessionLinkFromTreeItem, copySessionLinkFromPanel } = require('./handlers/copySessionLink');
const { registerSessionUriHandler } = require('./uri/sessionUriHandler');
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
    vscode.commands.registerCommand('claudeCodeLauncher.open', async (opts) => {
      // The robot icon (editor/title openTerminal), status bar, and welcome link
      // route through here — they show the AGENT PICKER so the user chooses
      // which agent (Claude / Kiro / Antigravity) to launch. pickAgent no-ops
      // to the single candidate when only one agent is enabled+installed (and to
      // 'claude' with none), so the QuickPick only appears when there's a real
      // choice. Esc cancels (no session). An already-forced agent (opts.agent —
      // e.g. agent-scoped commands or openInMultiplexer) skips the picker.
      // NOTE: the in-session toolbar "+" (handlers/toolbar.js 'new-tab') does NOT
      // route through here — it intentionally launches the DEFAULT agent directly
      // for a fast new tab.
      const merged = Object.assign({}, opts || {});
      if (!merged.agent) {
        const picked = await pickAgent();
        if (!picked) return; // user cancelled the picker
        merged.agent = picked;
      }
      createPanel(context, extensionPath, null, merged);
    })
  );

  // Agent-scoped new-session commands. The split sidebar views ('Claude
  // Sessions' / 'Kiro Sessions') each own a + button wired here, so the agent
  // is decided by which view's header you click — no pickAgent QuickPick. The
  // generic 'open' command launches the default agent (claudeCodeLauncher.agent).
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.newClaude', () => {
      createPanel(context, extensionPath, null, { agent: 'claude' });
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.newKiro', () => {
      createPanel(context, extensionPath, null, { agent: 'kiro' });
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.newAntigravity', () => {
      createPanel(context, extensionPath, null, { agent: 'antigravity' });
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.newCodex', () => {
      createPanel(context, extensionPath, null, { agent: 'codex' });
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.newGrok', () => {
      createPanel(context, extensionPath, null, { agent: 'grok' });
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.newGjc', () => {
      createPanel(context, extensionPath, null, { agent: 'gjc' });
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.newChief', () => {
      createPanel(context, extensionPath, null, { agent: 'chief' });
    }),
    // Unified new-session command — backs the Quick Actions view rows (one per
    // installed + enabled agent). Tree-item only (hidden from the palette via
    // package.json menus); newClaude/newKiro/newAntigravity stay as the
    // session-view + button entry points.
    vscode.commands.registerCommand('claudeCodeLauncher.newSession', (agentId) => {
      createPanel(context, extensionPath, null, { agent: agentId || 'claude' });
    })
  );

  // gjc (Gajae Code) model + OAuth-subscription selection. gjc is multi-model:
  // one binary routes to whichever subscription is logged in (Claude / Codex /
  // Antigravity / Grok / …). pickGjcModel persists a fuzzy --model to
  // claudeCodeLauncher.gjc.model (applied to fresh gjc sessions); setupGjc
  // Credentials imports Claude/Codex logins + points at /login for the rest.
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.gjc.pickModel', () => pickGjcModel()),
    vscode.commands.registerCommand('claudeCodeLauncher.gjc.setupCredentials', () => setupGjcCredentials()),
    vscode.commands.registerCommand('claudeCodeLauncher.gjc.telegram.setup', () => promptAndSetupTelegram()),
    vscode.commands.registerCommand('claudeCodeLauncher.gjc.telegram.disable', () => disableGjcTelegram()),
    // Claude channels (연구 미리보기): 텔레그램 양방향 chat bridge 풀 셋업 마법사.
    // gjc.telegram(단방향 알림)과 별개. handlers/claudeChannelSetup.js 참조.
    vscode.commands.registerCommand('claudeCodeLauncher.claude.telegram.setup', () => promptAndSetupTelegramChannel()),
    vscode.commands.registerCommand('claudeCodeLauncher.claude.telegram.disable', () => disableTelegramChannel())
  );

  // gjc 텔레그램 지원 감지 → claudeCodeLauncher.gjc.telegramSupported 컨텍스트키 설정.
  // 비동기·비블로킹(activate 임계경로 차단 금지). 데몬 수명주기·싱글톤·정리는 gjc가
  // 소유하므로 런처는 감지/설정만 하고 능동 daemon stop·참조계수는 두지 않는다.
  detectTelegramSupport().catch(() => {});

  // v3.6.15 — handoff: extract the current session's conversation and inject it
  // as context into a new tab running ANOTHER agent. v3.7.20 — the target is
  // chosen from all enabled+installed agents (Claude / Kiro / Antigravity) other
  // than the source, instead of a fixed claude↔kiro toggle.
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.handoffToOther', async () => {
      // (a) Find the active (focused) panel entry.
      let activeEntry = null;
      for (const [, entry] of state.panels) {
        if (entry.panel.active) { activeEntry = entry; break; }
      }
      if (!activeEntry) {
        vscode.window.showInformationMessage(t('handoffNoActiveTab'));
        return;
      }

      // (b) Resolve jsonl path and extract messages.
      const jsonlPath = getSessionJsonlPath(activeEntry.sessionId, activeEntry.cwd, activeEntry.agent);
      if (!jsonlPath) {
        // antigravity (agy) keeps transcripts as protobuf-in-SQLite, not jsonl,
        // so it can't be a handoff SOURCE yet (extraction needs the .db parser).
        // Handing off TO antigravity works fine — only extracting FROM it doesn't.
        const msg = activeEntry.agent === 'antigravity'
          ? t('handoffAgyUnsupported')
          : t('handoffNoSessionPath');
        vscode.window.showInformationMessage(msg);
        return;
      }
      let messages;
      try {
        messages = extractMessages(jsonlPath, activeEntry.agent);
      } catch (e) {
        vscode.window.showInformationMessage(t('handoffExtractFail') + e.message);
        return;
      }
      if (!messages || messages.length === 0) {
        vscode.window.showInformationMessage(t('handoffNoMessages'));
        return;
      }

      // (c) Build handoff note (PoC: raw text; swap buildHandoffNote for AI summary later).
      const note = buildHandoffNote(messages, { fromAgent: activeEntry.agent, cwd: activeEntry.cwd });

      // (d) Pick the target agent — any enabled+installed agent other than the
      // current one (Claude / Kiro / Antigravity) — and open a new tab with it.
      // Pre-compute the eligible list so "no other agent enabled" is told apart
      // from a user cancel (Esc): empty list → guide the user; cancel → silent.
      const enabledIds = vscode.workspace
        .getConfiguration('claudeCodeLauncher')
        .get('enabledAgents', ['claude']);
      const others = listAgents().filter(
        (a) => enabledIds.includes(a.id) && a.installed && a.id !== activeEntry.agent
      );
      if (others.length === 0) {
        vscode.window.showInformationMessage(
          t('handoffNoOtherAgent')
        );
        return;
      }
      const targetAgent = others.length === 1
        ? others[0].id
        : await pickAgent({
            exclude: activeEntry.agent,
            placeHolder: `Hand off from ${activeEntry.agent} — pick the target agent`,
          });
      if (!targetAgent) return; // user cancelled the picker
      createPanel(context, extensionPath, { cwd: activeEntry.cwd }, { agent: targetAgent });

      // (e) Inject note once the new entry's PTY is ready.
      // Strategy: poll state.panels for the highest tabId (the one just created),
      // wait up to 8s for its PTY to be alive, then write once. A fixed delay
      // avoids coupling to internal idle-state machinery; 2500ms is conservative
      // but safe across both claude and kiro startup times.
      const createdTabId = state.tabCounter; // captured synchronously right after createPanel
      let injected = false;
      const INJECT_DELAY_MS = 2500;
      const INJECT_POLL_MS = 200;
      const INJECT_TIMEOUT_MS = 8000;
      const startedAt = Date.now();

      const tryInject = () => {
        const newEntry = state.panels.get(createdTabId);
        if (!newEntry || newEntry._disposed) return; // tab closed before inject
        if (injected) return;

        if (newEntry.pty) {
          injected = true;
          // Use the chunked writer so large notes don't overflow ConPTY buffers.
          setTimeout(() => {
            if (injected && newEntry.pty && !newEntry._disposed) {
              writePtyChunked(newEntry, note);
            }
          }, INJECT_DELAY_MS);
          return;
        }

        if (Date.now() - startedAt < INJECT_TIMEOUT_MS) {
          setTimeout(tryInject, INJECT_POLL_MS);
        }
      };
      setTimeout(tryInject, INJECT_POLL_MS);
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
      const cfg = vscode.workspace.getConfiguration('claudeCodeLauncher');
      const prefill = buildRenamePrefill({
        enabled: cfg.get('renamePrefix.enabled', false),
        format: cfg.get('renamePrefix.format', 'YYMMDD_'),
        existing: activeEntry.title
      });
      const newName = await vscode.window.showInputBox({
        prompt: t('enterTabName'),
        value: prefill.value,
        valueSelection: prefill.valueSelection
      });
      if (newName) {
        activeEntry.title = newName;
        activeEntry.panel.title = newName;
        if (activeEntry.agent === 'antigravity' && !activeEntry.isAntigravityResume && activeEntry.cwd) {
          const { listAntigravitySessions } = require('./lib/sessionJsonl');
          const sessions = listAntigravitySessions(activeEntry.cwd);
          if (sessions.length > 0) {
            activeEntry.sessionId = sessions[0].sessionId;
            activeEntry.isAntigravityResume = true;
          }
        }
        saveSessions();
      }
    })
  );

  // Session tree views — split into two agent-scoped views:
  //   'Claude Sessions' (claudeCodeLauncher.sessionList, id kept for keybinding
  //     compatibility) — claude groups only, kiro excluded.
  //   'Kiro Sessions' (claudeCodeLauncher.kiroSessions) — kiro sessions only,
  //     hidden via the kiroAvailable context key when kiro isn't installed/enabled.
  // v2.6.0: claude view registers a TreeDragAndDropController via its provider.
  state.sessionTreeProvider = new SessionTreeDataProvider(context, 'claude');
  const treeView = vscode.window.createTreeView('claudeCodeLauncher.sessionList', {
    treeDataProvider: state.sessionTreeProvider,
    dragAndDropController: state.sessionTreeProvider,
    canSelectMany: true
  });
  context.subscriptions.push(treeView);

  state.kiroTreeProvider = new SessionTreeDataProvider(context, 'kiro');
  const kiroTreeView = vscode.window.createTreeView('claudeCodeLauncher.kiroSessions', {
    treeDataProvider: state.kiroTreeProvider,
    dragAndDropController: state.kiroTreeProvider,
    canSelectMany: true
  });
  context.subscriptions.push(kiroTreeView);

  // 'Antigravity Sessions' (claudeCodeLauncher.antigravitySessions) — agy
  // conversations only, hidden via the antigravityAvailable context key when
  // agy isn't installed/enabled. Same shape as the kiro view.
  state.antigravityTreeProvider = new SessionTreeDataProvider(context, 'antigravity');
  const antigravityTreeView = vscode.window.createTreeView('claudeCodeLauncher.antigravitySessions', {
    treeDataProvider: state.antigravityTreeProvider,
    dragAndDropController: state.antigravityTreeProvider,
    canSelectMany: true
  });
  context.subscriptions.push(antigravityTreeView);

  // 'Codex Sessions' (claudeCodeLauncher.codexSessions) — codex rollouts only,
  // hidden via the codexAvailable context key when codex isn't installed/
  // enabled. Same shape as the kiro/antigravity views.
  state.codexTreeProvider = new SessionTreeDataProvider(context, 'codex');
  const codexTreeView = vscode.window.createTreeView('claudeCodeLauncher.codexSessions', {
    treeDataProvider: state.codexTreeProvider,
    dragAndDropController: state.codexTreeProvider,
    canSelectMany: true
  });
  context.subscriptions.push(codexTreeView);

  // 'Grok Sessions' (claudeCodeLauncher.grokSessions) — grok sessions only,
  // hidden via the grokAvailable context key when grok isn't installed/enabled.
  state.grokTreeProvider = new SessionTreeDataProvider(context, 'grok');
  const grokTreeView = vscode.window.createTreeView('claudeCodeLauncher.grokSessions', {
    treeDataProvider: state.grokTreeProvider,
    dragAndDropController: state.grokTreeProvider,
    canSelectMany: true
  });
  context.subscriptions.push(grokTreeView);

  // 'Gajae Sessions' (claudeCodeLauncher.gjcSessions) — gjc sessions only,
  // hidden via the gjcAvailable context key when gjc isn't installed/enabled.
  state.gjcTreeProvider = new SessionTreeDataProvider(context, 'gjc');
  const gjcTreeView = vscode.window.createTreeView('claudeCodeLauncher.gjcSessions', {
    treeDataProvider: state.gjcTreeProvider,
    dragAndDropController: state.gjcTreeProvider,
    canSelectMany: true
  });
  context.subscriptions.push(gjcTreeView);

  // 'Chief Sessions' (claudeCodeLauncher.chiefSessions) — chief-repl sessions
  // only, hidden via the chiefAvailable context key when the bundled wrapper is
  // unavailable or the agent is not enabled.
  state.chiefTreeProvider = new SessionTreeDataProvider(context, 'chief');
  const chiefTreeView = vscode.window.createTreeView('claudeCodeLauncher.chiefSessions', {
    treeDataProvider: state.chiefTreeProvider,
    dragAndDropController: state.chiefTreeProvider,
    canSelectMany: true
  });
  context.subscriptions.push(chiefTreeView);

  // 'Sessions' (claudeCodeLauncher.unifiedSessions) — the unified view (v3.10):
  // claude + kiro + antigravity + codex + grok + chief sessions in one tree, each leaf badged
  // with its model icon, all sharing claude's group / Resume Later / Trash
  // store. Shown when sessionViewMode === 'unified' (the default); the five
  // split views hide. Reuses claude's DND MIME since only one of unified/split
  // is ever visible at a time.
  state.unifiedTreeProvider = new SessionTreeDataProvider(context, 'unified');
  const unifiedTreeView = vscode.window.createTreeView('claudeCodeLauncher.unifiedSessions', {
    treeDataProvider: state.unifiedTreeProvider,
    dragAndDropController: state.unifiedTreeProvider,
    canSelectMany: true
  });
  context.subscriptions.push(unifiedTreeView);

  // Resolve which provider a group/session command targets. Items dragged or
  // right-clicked in the Kiro / Antigravity Sessions views carry agent markers
  // (kiroSession / antigravitySession contextValue, or a customGroup node
  // tagged _agentMode); anything else routes to the claude provider. Keeps each
  // agent's group ops fully separate so a command fired from one view can never
  // mutate another's store.
  const providerForItem = (item) => {
    // Unified-view items (any agent) route to the unified provider so their
    // group/sort/rename ops land in the one shared (claude) store — checked
    // first because a unified kiro/codex/grok leaf still carries agent-specific
    // contextValue.
    if (item && item._unified) {
      return state.unifiedTreeProvider;
    }
    if (item && (item.contextValue === 'kiroSession' || item._agentMode === 'kiro')) {
      return state.kiroTreeProvider;
    }
    if (item && (item.contextValue === 'antigravitySession' || item._agentMode === 'antigravity')) {
      return state.antigravityTreeProvider;
    }
    if (item && (item.contextValue === 'codexSession' || item._agentMode === 'codex')) {
      return state.codexTreeProvider;
    }
    if (item && (item.contextValue === 'grokSession' || item._agentMode === 'grok')) {
      return state.grokTreeProvider;
    }
    if (item && (item.contextValue === 'gjcSession' || item._agentMode === 'gjc')) {
      return state.gjcTreeProvider;
    }
    if (item && (item.contextValue === 'chiefSession' || item._agentMode === 'chief')) {
      return state.chiefTreeProvider;
    }
    return state.sessionTreeProvider;
  };

  // Kiro view shares the claude view's expand/collapse tracking semantics.
  kiroTreeView.onDidExpandElement(e => {
    const key = e.element._groupName || (e.element.label ? String(e.element.label).replace(/\s*\(\d+\)$/, '') : null);
    if (key) state.kiroTreeProvider._expandedGroups.add(key);
  });
  kiroTreeView.onDidCollapseElement(e => {
    const key = e.element._groupName || (e.element.label ? String(e.element.label).replace(/\s*\(\d+\)$/, '') : null);
    if (key) state.kiroTreeProvider._expandedGroups.delete(key);
  });

  // Antigravity view — same expand/collapse tracking.
  antigravityTreeView.onDidExpandElement(e => {
    const key = e.element._groupName || (e.element.label ? String(e.element.label).replace(/\s*\(\d+\)$/, '') : null);
    if (key) state.antigravityTreeProvider._expandedGroups.add(key);
  });
  antigravityTreeView.onDidCollapseElement(e => {
    const key = e.element._groupName || (e.element.label ? String(e.element.label).replace(/\s*\(\d+\)$/, '') : null);
    if (key) state.antigravityTreeProvider._expandedGroups.delete(key);
  });

  // Codex view — same expand/collapse tracking.
  codexTreeView.onDidExpandElement(e => {
    const key = e.element._groupName || (e.element.label ? String(e.element.label).replace(/\s*\(\d+\)$/, '') : null);
    if (key) state.codexTreeProvider._expandedGroups.add(key);
  });
  codexTreeView.onDidCollapseElement(e => {
    const key = e.element._groupName || (e.element.label ? String(e.element.label).replace(/\s*\(\d+\)$/, '') : null);
    if (key) state.codexTreeProvider._expandedGroups.delete(key);
  });

  // Unified view — same expand/collapse tracking.
  unifiedTreeView.onDidExpandElement(e => {
    const key = e.element._groupName || (e.element.label ? String(e.element.label).replace(/\s*\(\d+\)$/, '') : null);
    if (key) state.unifiedTreeProvider._expandedGroups.add(key);
  });
  unifiedTreeView.onDidCollapseElement(e => {
    const key = e.element._groupName || (e.element.label ? String(e.element.label).replace(/\s*\(\d+\)$/, '') : null);
    if (key) state.unifiedTreeProvider._expandedGroups.delete(key);
  });

  // Grok view — same expand/collapse tracking.
  grokTreeView.onDidExpandElement(e => {
    const key = e.element._groupName || (e.element.label ? String(e.element.label).replace(/\s*\(\d+\)$/, '') : null);
    if (key) state.grokTreeProvider._expandedGroups.add(key);
  });
  grokTreeView.onDidCollapseElement(e => {
    const key = e.element._groupName || (e.element.label ? String(e.element.label).replace(/\s*\(\d+\)$/, '') : null);
    if (key) state.grokTreeProvider._expandedGroups.delete(key);
  });

  // Gajae (gjc) view — same expand/collapse tracking.
  gjcTreeView.onDidExpandElement(e => {
    const key = e.element._groupName || (e.element.label ? String(e.element.label).replace(/\s*\(\d+\)$/, '') : null);
    if (key) state.gjcTreeProvider._expandedGroups.add(key);
  });
  gjcTreeView.onDidCollapseElement(e => {
    const key = e.element._groupName || (e.element.label ? String(e.element.label).replace(/\s*\(\d+\)$/, '') : null);
    if (key) state.gjcTreeProvider._expandedGroups.delete(key);
  });

  // Chief view — same expand/collapse tracking.
  chiefTreeView.onDidExpandElement(e => {
    const key = e.element._groupName || (e.element.label ? String(e.element.label).replace(/\s*\(\d+\)$/, '') : null);
    if (key) state.chiefTreeProvider._expandedGroups.add(key);
  });
  chiefTreeView.onDidCollapseElement(e => {
    const key = e.element._groupName || (e.element.label ? String(e.element.label).replace(/\s*\(\d+\)$/, '') : null);
    if (key) state.chiefTreeProvider._expandedGroups.delete(key);
  });

  // Quick Actions — top-of-container view holding the new-session rows (one per
  // installed + enabled agent) + a handoff row. The settings ⚙ lives in this
  // view's view/title. refresh() is called from the enabledAgents config-change
  // handler so toggling an agent on/off updates its row without a reload.
  state.quickActionsProvider = new QuickActionsProvider();
  const quickActionsView = vscode.window.createTreeView('claudeCodeLauncher.quickActions', {
    treeDataProvider: state.quickActionsProvider,
  });
  context.subscriptions.push(quickActionsView);

  // kiroAvailable context key — drives the 'Kiro Sessions' view visibility
  // (package.json views[].when). True only when kiro-cli is installed AND
  // 'kiro' is in claudeCodeLauncher.enabledAgents. Refreshed on enabledAgents
  // config changes below.
  function refreshKiroAvailable() {
    const enabled = vscode.workspace
      .getConfiguration('claudeCodeLauncher')
      .get('enabledAgents', ['claude']);
    const saveDisabled = vscode.workspace
      .getConfiguration('claudeCodeLauncher')
      .get('sessionSaveDisabledAgents', []);
    const kiroInstalled = listAgents().some(a => a.id === 'kiro' && a.installed);
    const available = kiroInstalled && enabled.includes('kiro') && !saveDisabled.includes('kiro');
    vscode.commands.executeCommand('setContext', 'claudeCodeLauncher.kiroAvailable', available);
  }
  refreshKiroAvailable();

  // antigravityAvailable context key — drives the 'Antigravity Sessions' view
  // visibility. True only when agy is installed AND 'antigravity' is in
  // enabledAgents. Refreshed on enabledAgents config changes below.
  function refreshAntigravityAvailable() {
    const enabled = vscode.workspace
      .getConfiguration('claudeCodeLauncher')
      .get('enabledAgents', ['claude']);
    const saveDisabled = vscode.workspace
      .getConfiguration('claudeCodeLauncher')
      .get('sessionSaveDisabledAgents', []);
    const agyInstalled = listAgents().some(a => a.id === 'antigravity' && a.installed);
    const available = agyInstalled && enabled.includes('antigravity') && !saveDisabled.includes('antigravity');
    vscode.commands.executeCommand('setContext', 'claudeCodeLauncher.antigravityAvailable', available);
  }
  refreshAntigravityAvailable();

  // codexAvailable context key — drives the 'Codex Sessions' view visibility.
  // True only when codex is installed AND 'codex' is in enabledAgents.
  // Refreshed on enabledAgents config changes below.
  function refreshCodexAvailable() {
    const enabled = vscode.workspace
      .getConfiguration('claudeCodeLauncher')
      .get('enabledAgents', ['claude']);
    const saveDisabled = vscode.workspace
      .getConfiguration('claudeCodeLauncher')
      .get('sessionSaveDisabledAgents', []);
    const codexInstalled = listAgents().some(a => a.id === 'codex' && a.installed);
    const available = codexInstalled && enabled.includes('codex') && !saveDisabled.includes('codex');
    vscode.commands.executeCommand('setContext', 'claudeCodeLauncher.codexAvailable', available);
  }
  refreshCodexAvailable();

  function refreshGrokAvailable() {
    const enabled = vscode.workspace
      .getConfiguration('claudeCodeLauncher')
      .get('enabledAgents', ['claude']);
    const saveDisabled = vscode.workspace
      .getConfiguration('claudeCodeLauncher')
      .get('sessionSaveDisabledAgents', []);
    const grokInstalled = listAgents().some(a => a.id === 'grok' && a.installed);
    const available = grokInstalled && enabled.includes('grok') && !saveDisabled.includes('grok');
    vscode.commands.executeCommand('setContext', 'claudeCodeLauncher.grokAvailable', available);
  }
  refreshGrokAvailable();

  // gjcAvailable context key — drives the 'Gajae Sessions' view visibility.
  // True only when gjc is installed AND 'gjc' is in enabledAgents.
  function refreshGjcAvailable() {
    const enabled = vscode.workspace
      .getConfiguration('claudeCodeLauncher')
      .get('enabledAgents', ['claude']);
    const saveDisabled = vscode.workspace
      .getConfiguration('claudeCodeLauncher')
      .get('sessionSaveDisabledAgents', []);
    const gjcInstalled = listAgents().some(a => a.id === 'gjc' && a.installed);
    const available = gjcInstalled && enabled.includes('gjc') && !saveDisabled.includes('gjc');
    vscode.commands.executeCommand('setContext', 'claudeCodeLauncher.gjcAvailable', available);
  }
  refreshGjcAvailable();

  function refreshChiefAvailable() {
    const enabled = vscode.workspace
      .getConfiguration('claudeCodeLauncher')
      .get('enabledAgents', ['claude']);
    const saveDisabled = vscode.workspace
      .getConfiguration('claudeCodeLauncher')
      .get('sessionSaveDisabledAgents', []);
    const chiefInstalled = listAgents().some(a => a.id === 'chief' && a.installed);
    const available = chiefInstalled && enabled.includes('chief') && !saveDisabled.includes('chief');
    vscode.commands.executeCommand('setContext', 'claudeCodeLauncher.chiefAvailable', available);
  }
  refreshChiefAvailable();

  // unifiedViewActive context key — drives the unified 'Sessions' view vs the
  // five split agent views (package.json views[].when). True when
  // sessionViewMode === 'unified' (the default). When false the unified view
  // hides and the split Claude/Codex/Grok/Kiro/Antigravity views show per their own
  // availability keys. Refreshed on sessionViewMode config changes below.
  function refreshSessionViewMode() {
    const mode = vscode.workspace
      .getConfiguration('claudeCodeLauncher')
      .get('sessionViewMode', 'unified');
    vscode.commands.executeCommand('setContext', 'claudeCodeLauncher.unifiedViewActive', mode === 'unified');
  }
  refreshSessionViewMode();

  // v3.5.8: size-based decoration. Yellows 5+ MB session labels, reds 10+ MB
  // ones. SessionTreeDataProvider tags each session item with a custom
  // resourceUri whose query carries size + trashed flag; the decoration
  // provider reads those back to compute color + tooltip. Tree refresh and
  // size growth on an existing session both call refresh() on the provider
  // to invalidate the cached decoration.
  state.sessionDecorationProvider = new SessionDecorationProvider();
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(state.sessionDecorationProvider)
  );

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
      if (state.kiroTreeProvider) state.kiroTreeProvider.refresh();
      if (state.antigravityTreeProvider) state.antigravityTreeProvider.refresh();
      if (state.codexTreeProvider) state.codexTreeProvider.refresh();
      if (state.grokTreeProvider) state.grokTreeProvider.refresh();
      if (state.gjcTreeProvider) state.gjcTreeProvider.refresh();
      if (state.chiefTreeProvider) state.chiefTreeProvider.refresh();
      if (state.unifiedTreeProvider) state.unifiedTreeProvider.refresh();
    })
  );

  // v3.11: Sessions view-title "+ New Session" button (sits left of the ⚙ in
  // the unified view). Unlike the split views' agent-pinned + buttons, this one
  // ALWAYS shows the model picker (pickAgent → enabled+installed agents), so the
  // user chooses which model the new session runs. pickAgent no-ops to the lone
  // candidate when only one agent is available, and Esc cancels (no session).
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.newSessionPick', async () => {
      const picked = await pickAgent({ placeHolder: t('newSessionPickPlaceholder') });
      if (!picked) return; // user cancelled the picker
      createPanel(context, extensionPath, null, { agent: picked });
    })
  );

  // v3.11: session-name search. All providers share the same filter so it works
  // in both unified and split modes; the visible view's title shows the active
  // query and the sessionFilterActive context key reveals the ✕ clear button.
  const _sessionProviders = () => [
    state.unifiedTreeProvider,
    state.sessionTreeProvider,
    state.kiroTreeProvider,
    state.antigravityTreeProvider,
    state.codexTreeProvider,
    state.grokTreeProvider,
    state.gjcTreeProvider,
    state.chiefTreeProvider,
  ].filter(Boolean);
  const _sessionViews = () => [
    unifiedTreeView, treeView, kiroTreeView, antigravityTreeView, codexTreeView, grokTreeView, gjcTreeView, chiefTreeView,
  ].filter(Boolean);
  const _setFilterAll = (text) => {
    let normalized = '';
    for (const p of _sessionProviders()) normalized = p.setFilter(text);
    const active = !!normalized;
    vscode.commands.executeCommand('setContext', 'claudeCodeLauncher.sessionFilterActive', active);
    const msg = active ? `🔍 "${String(text).trim()}"` : undefined;
    for (const v of _sessionViews()) v.message = msg;
    return active;
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.searchSessions', async () => {
      const current = (_sessionProviders()[0] && _sessionProviders()[0]._filterText) || '';
      const value = await vscode.window.showInputBox({
        prompt: t('searchSessionsPrompt'),
        placeHolder: t('searchSessionsPlaceholder'),
        value: current,
      });
      if (value === undefined) return; // Esc — keep the current filter
      _setFilterAll(value);
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.clearSessionFilter', () => {
      _setFilterAll('');
    })
  );

  // Re-evaluate the kiroAvailable context key when the enabled agents change
  // so the 'Kiro Sessions' view shows/hides without a window reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('claudeCodeLauncher.enabledAgents')
        || e.affectsConfiguration('claudeCodeLauncher.sessionSaveDisabledAgents')
      ) {
        refreshKiroAvailable();
        refreshAntigravityAvailable();
        refreshCodexAvailable();
        refreshGrokAvailable();
        refreshGjcAvailable();
        refreshChiefAvailable();
        if (state.quickActionsProvider) state.quickActionsProvider.refresh();
        if (state.unifiedTreeProvider) state.unifiedTreeProvider.refresh();
      }
      if (
        e.affectsConfiguration('claudeCodeLauncher.chief.apiKey')
        || e.affectsConfiguration('claudeCodeLauncher.chief.projectId')
        || e.affectsConfiguration('claudeCodeLauncher.chief.baseUrl')
      ) {
        refreshChiefAvailable();
        if (state.quickActionsProvider) state.quickActionsProvider.refresh();
      }
      if (e.affectsConfiguration('claudeCodeLauncher.sessionViewMode')) {
        refreshSessionViewMode();
        if (state.unifiedTreeProvider) state.unifiedTreeProvider.refresh();
      }
    })
  );

  // Sidebar ⚙ — open the global (extension-wide) settings editor panel. This
  // is distinct from the per-panel settings MODAL inside each webview tab
  // (toolbar ⚙); the global panel edits ConfigurationTarget.Global settings
  // (e.g. default agent) in a standalone 2-column editor.
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.openSettings', () => {
      require('./panel/settingsPanel').openGlobalSettings(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.resumeSession', (sessionId, opts) => {
      // Remove from Resume Later list regardless of agent — close-resume saves
      // all agents into claudeSavedSessions, so resuming must always clean up.
      const _saved = sessionStoreGet('claudeSavedSessions', []);
      const _filtered = _saved.filter(s => s.sessionId !== sessionId);
      if (_filtered.length !== _saved.length) {
        sessionStoreUpdate('claudeSavedSessions', _filtered);
        state.refreshSessionTrees();
      }

      // Kiro resume: directory-scoped resume by the real kiro session id.
      // The session MUST spawn in its own cwd (kiro resolves --resume-id
      // relative to the working directory), so opts.cwd is threaded into the
      // panel session as cwd. No claude-side title/savedSessions bookkeeping.
      if (opts && opts.agent === 'kiro') {
        const kiroTitles = sessionStoreGet('kiroSessionTitles', {});
        createPanel(
          context,
          extensionPath,
          { sessionId, cwd: opts.cwd, agent: 'kiro', isKiroResume: true, title: kiroTitles[sessionId] || opts.title },
          {}
        );
        return;
      }
      // Antigravity resume: sessionId is a real agy conversation id, resumed via
      // `agy --conversation <id>` in its own cwd. Like kiro, no claude-side
      // title/savedSessions bookkeeping (antigravity has its own store keys).
      if (opts && opts.agent === 'antigravity') {
        const agyTitles = sessionStoreGet('antigravitySessionTitles', {});
        createPanel(
          context,
          extensionPath,
          { sessionId, cwd: opts.cwd, agent: 'antigravity', isAntigravityResume: true, title: agyTitles[sessionId] || opts.title },
          {}
        );
        return;
      }
      // Codex resume: sessionId is a real codex rollout UUID, resumed via
      // `codex resume <id>` in its own cwd. Like kiro/antigravity, no
      // claude-side title/savedSessions bookkeeping (codex has its own keys).
      if (opts && opts.agent === 'codex') {
        const codexTitles = sessionStoreGet('codexSessionTitles', {});
        createPanel(
          context,
          extensionPath,
          { sessionId, cwd: opts.cwd, agent: 'codex', isCodexResume: true, title: codexTitles[sessionId] || opts.title },
          {}
        );
        return;
      }
      if (opts && opts.agent === 'grok') {
        const grokTitles = sessionStoreGet('grokSessionTitles', {});
        createPanel(
          context,
          extensionPath,
          { sessionId, cwd: opts.cwd, agent: 'grok', isGrokResume: true, title: grokTitles[sessionId] || opts.title },
          {}
        );
        return;
      }
      // gjc resume: sessionId is a real gjc file stem, resumed via `gjc -r <path>`
      // in its own cwd. Like the other non-claude agents, no claude-side
      // title/savedSessions bookkeeping (gjc has its own store keys).
      if (opts && opts.agent === 'gjc') {
        const gjcTitles = sessionStoreGet('gjcSessionTitles', {});
        createPanel(
          context,
          extensionPath,
          { sessionId, cwd: opts.cwd, agent: 'gjc', isGjcResume: true, title: gjcTitles[sessionId] || opts.title },
          {}
        );
        return;
      }
      if (opts && opts.agent === 'chief') {
        const chiefTitles = sessionStoreGet('chiefSessionTitles', {});
        createPanel(
          context,
          extensionPath,
          { sessionId, cwd: opts.cwd, agent: 'chief', isChiefResume: true, title: chiefTitles[sessionId] || opts.title },
          {}
        );
        return;
      }
      const titleMap = sessionStoreGet('claudeSessionTitles', {});
      const title = titleMap[sessionId] || undefined;
      const backend = (opts && opts.backend) || vscode.workspace
        .getConfiguration('claudeCodeLauncher')
        .get('terminal.defaultBackend', 'webview');
      // Claude resume: tag the session as 'claude' explicitly so it spawns
      // Claude regardless of the configured default agent (a gjc/codex/etc.
      // default must not hijack a Claude session). Mirrors the agent-tagged
      // branches above.
      createPanel(context, extensionPath, { sessionId, title, agent: 'claude' }, { backend });
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
    }),
    // v3.22.0 — session deep links. copySessionLink takes a tree item (context
    // menu); copyActiveSessionLink uses the focused panel (toolbar / palette).
    // Clicking the copied link routes back through uri/sessionUriHandler, which
    // lands on resumeSession above.
    vscode.commands.registerCommand('claudeCodeLauncher.copySessionLink', (item) =>
      copySessionLinkFromTreeItem(context, item)
    ),
    vscode.commands.registerCommand('claudeCodeLauncher.copyActiveSessionLink', (tabId) =>
      copySessionLinkFromPanel(context, typeof tabId === 'string' ? tabId : undefined)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.moveToGroup', async (item) => {
      const sessionId = item?._sessionId;
      if (!sessionId) return;
      const prov = providerForItem(item);
      const groupsKey = prov._storeKey('groups');
      const isClaude = prov === state.sessionTreeProvider;
      const groups = sessionStoreGet(groupsKey, {});
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
      // Remove from all existing groups first.
      // Phase 13 hotfix-2: do NOT delete an empty group key when it still
      // anchors a sub-group path. Otherwise moving the last session out of
      // 'Foo' into 'Foo/Bar' nukes 'Foo' and the renderer (which only emits
      // depth-1 paths at root) loses both 'Foo' AND 'Foo/Bar' from the tree.
      const hasDescendants = (g) =>
        Object.keys(groups).some(k => k !== g && k.startsWith(g + '/'));
      for (const g of Object.keys(groups)) {
        groups[g] = groups[g].filter(id => id !== sessionId);
        if (groups[g].length === 0 && !hasDescendants(g)) delete groups[g];
      }
      // Also remove from legacy saved/archived (claude-only concepts).
      if (isClaude) {
        const saved = sessionStoreGet('claudeSavedSessions', []);
        sessionStoreUpdate('claudeSavedSessions', saved.filter(s => s.sessionId !== sessionId));
        const archived = sessionStoreGet('claudeArchivedSessions', []);
        sessionStoreUpdate('claudeArchivedSessions', archived.filter(s => s.sessionId !== sessionId));
      }
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
      sessionStoreUpdate(groupsKey, groups);
      prov.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.deleteGroup', async (item) => {
      const prov = providerForItem(item);
      const groupsKey = prov._storeKey('groups');
      const groups = sessionStoreGet(groupsKey, {});
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
      sessionStoreUpdate(groupsKey, groups);
      prov.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.renameSessionTitle', async (item) => {
      // Per-session rename for the sidebar (claude + kiro). Writes to the
      // agent-scoped title store (_storeKey('titles') = claudeSessionTitles /
      // kiroSessionTitles), which the tree reads as the label. Works for closed
      // sessions too — kiro has no auto-title, so this is the way to name them.
      const prov = providerForItem(item);
      const id = item && item._sessionId;
      if (!prov || !id) return;
      const titlesKey = prov._storeKey('titles');
      const titles = sessionStoreGet(titlesKey, {});
      const cfg = vscode.workspace.getConfiguration('claudeCodeLauncher');
      const prefill = buildRenamePrefill({
        enabled: cfg.get('renamePrefix.enabled', false),
        format: cfg.get('renamePrefix.format', 'YYMMDD_'),
        existing: titles[id] || ''
      });
      const name = await vscode.window.showInputBox({
        prompt: 'Session name (leave empty to clear)',
        value: prefill.value,
        valueSelection: prefill.valueSelection
      });
      if (name === undefined) return; // cancelled
      const trimmed = name.trim();
      if (trimmed) titles[id] = trimmed; else delete titles[id];
      sessionStoreUpdate(titlesKey, titles);
      prov.refresh();
      // Keep an open tab for this session in sync with the new name.
      for (const [, entry] of state.panels) {
        if (entry.sessionId === id && trimmed) {
          entry.title = trimmed;
          try { entry.panel.title = trimmed; } catch (_) {}
          try { entry.panel.webview.postMessage({ type: 'title-updated', title: trimmed }); } catch (_) {}
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.renameGroup', async (item) => {
      const prov = providerForItem(item);
      const groupsKey = prov._storeKey('groups');
      const groups = sessionStoreGet(groupsKey, {});
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
      const exp = prov._expandedGroups;
      for (const old of toRename) {
        if (exp.has(old)) {
          exp.delete(old);
          exp.add(newFullPath + old.substring(oldFullPath.length));
        }
      }
      sessionStoreUpdate(groupsKey, rebuilt);
      prov.refresh();
    })
  );

  // Trash: delete session (move .jsonl to trash/)
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.trashSession', async (item) => {
      const sessionId = item?._sessionId;
      if (!sessionId) return;
      // v3.20.10: unified view shows trash for all agents — delegate to
      // the agent-specific trash command when the item is non-claude.
      if (item._agent && item._agent === 'kiro') {
        return vscode.commands.executeCommand('claudeCodeLauncher.trashKiroSession', item);
      }
      if (item._agent && item._agent !== 'claude') {
        return vscode.commands.executeCommand('claudeCodeLauncher.trashAgentSession', item);
      }
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
      state.refreshSessionTrees();
    })
  );

  // Trash: restore session
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.restoreSession', async (item) => {
      const sessionId = item?._sessionId;
      if (!sessionId) return;
      // v3.10: defensive — restores into the claude project dir only (see trashSession).
      if (item._unified && item._agent && item._agent !== 'claude') return;
      const projDir = state.sessionTreeProvider._getProjectDir();
      if (!projDir) return;
      const trashDir = path.join(projDir, 'trash');
      const src = path.join(trashDir, sessionId + '.jsonl');
      if (!fs.existsSync(src)) return;
      fs.renameSync(src, path.join(projDir, sessionId + '.jsonl'));
      state.refreshSessionTrees();
    })
  );

  // Kiro Trash: move a kiro session (meta .json + transcript .jsonl) into
  // <kiro cli>/trash so listKiroSessions / kiro-cli --resume-id no longer see
  // it. Also drop it from kiro groups. Mirrors claude's trashSession.
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.trashKiroSession', async (item) => {
      const sessionId = item && item._sessionId;
      if (!sessionId) return;
      const cwd = item._cwd || vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      const cliDir = getKiroSessionsDir(cwd);
      const trashDir = path.join(cliDir, 'trash');
      try { if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir, { recursive: true }); } catch (_) {}
      for (const ext of ['.json', '.jsonl']) {
        const src = path.join(cliDir, sessionId + ext);
        if (fs.existsSync(src)) { try { fs.renameSync(src, path.join(trashDir, sessionId + ext)); } catch (_) {} }
      }
      const groups = sessionStoreGet('kiroSessionGroups', {});
      let changed = false;
      for (const g of Object.keys(groups)) {
        const next = groups[g].filter((id) => id !== sessionId);
        if (next.length !== groups[g].length) { groups[g] = next; changed = true; }
        if (groups[g].length === 0) delete groups[g];
      }
      if (changed) sessionStoreUpdate('kiroSessionGroups', groups);
      state.refreshSessionTrees();
    })
  );

  // Kiro Trash: restore — move the session files back to the cli dir.
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.restoreKiroSession', async (item) => {
      const sessionId = item && item._sessionId;
      if (!sessionId) return;
      const cwd = item._cwd || vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      const cliDir = getKiroSessionsDir(cwd);
      const trashDir = path.join(cliDir, 'trash');
      for (const ext of ['.json', '.jsonl']) {
        const src = path.join(trashDir, sessionId + ext);
        if (fs.existsSync(src)) { try { fs.renameSync(src, path.join(cliDir, sessionId + ext)); } catch (_) {} }
      }
      state.refreshSessionTrees();
    })
  );

  // Kiro Trash: empty — permanently delete every file under <kiro cli>/trash.
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.emptyKiroTrash', async () => {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      const trashDir = path.join(getKiroSessionsDir(cwd), 'trash');
      if (!fs.existsSync(trashDir)) return;
      const files = fs.readdirSync(trashDir).filter((f) => f.endsWith('.json') || f.endsWith('.jsonl'));
      if (files.length === 0) return;
      const count = files.filter((f) => f.endsWith('.jsonl')).length;
      const confirm = await vscode.window.showWarningMessage(
        `Permanently delete ${count} trashed Kiro session(s)? This cannot be undone.`,
        { modal: true }, 'Delete'
      );
      if (confirm !== 'Delete') return;
      for (const f of files) { try { fs.unlinkSync(path.join(trashDir, f)); } catch (_) {} }
      state.refreshSessionTrees();
    })
  );

  // Trash agent session: generic delete for non-claude/non-kiro agents
  // (codex, grok, gjc, antigravity, chief). Moves the session file to a
  // trash/ dir inside the agent's sessions folder and removes from groups/saved.
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.trashAgentSession', async (item) => {
      const sessionId = item && item._sessionId;
      if (!sessionId) return;
      const agent = item._agent;
      if (!agent || agent === 'claude' || agent === 'kiro') return;
      const cwd = item._cwd || vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;

      // Attempt to move the session file to a trash subdir
      try {
        let sessionFile = null;
        let sessionsDir = null;
        if (agent === 'codex') {
          sessionFile = findCodexSessionPath(sessionId, null, cwd);
          sessionsDir = getCodexPaths(cwd).sessionsDir;
        } else if (agent === 'grok') {
          sessionFile = findGrokSessionPath(sessionId, null, cwd);
          sessionsDir = getGrokPaths(cwd).sessionsDir;
        } else if (agent === 'gjc') {
          sessionFile = findGjcSessionPath(sessionId, null, cwd);
          sessionsDir = getGjcPaths(cwd).sessionsDir;
        } else if (agent === 'antigravity') {
          const baseDir = getAntigravityBaseDir(cwd);
          const convDir = path.join(baseDir, 'conversations');
          const dbFile = path.join(convDir, sessionId + '.db');
          if (fs.existsSync(dbFile)) sessionFile = dbFile;
          sessionsDir = convDir;
        } else if (agent === 'chief') {
          // Chief sessions are directories: sessionsDir/<id>/updates.jsonl
          sessionsDir = getChiefPaths(cwd).sessionsDir;
          const sessionDir = path.join(sessionsDir, sessionId);
          if (fs.existsSync(sessionDir)) {
            const trashDir = path.join(sessionsDir, 'trash');
            if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir, { recursive: true });
            fs.renameSync(sessionDir, path.join(trashDir, sessionId));
          }
        }
        if (agent !== 'chief' && sessionFile && fs.existsSync(sessionFile)) {
          const trashDir = path.join(sessionsDir || path.dirname(sessionFile), 'trash');
          if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir, { recursive: true });
          fs.renameSync(sessionFile, path.join(trashDir, path.basename(sessionFile)));
        }
      } catch (_) { /* best-effort file move */ }

      // Remove from agent's store keys (groups + saved)
      const AGENT_KEYS = {
        codex: { groups: 'codexSessionGroups', saved: 'codexSavedSessions' },
        grok: { groups: 'grokSessionGroups', saved: 'grokSavedSessions' },
        gjc: { groups: 'gjcSessionGroups', saved: 'gjcSavedSessions' },
        antigravity: { groups: 'antigravitySessionGroups', saved: 'antigravitySavedSessions' },
        chief: { groups: 'chiefSessionGroups', saved: 'chiefSavedSessions' },
      };
      const keys = AGENT_KEYS[agent];
      if (keys) {
        const groups = sessionStoreGet(keys.groups, {});
        let changed = false;
        for (const g of Object.keys(groups)) {
          const next = groups[g].filter(id => id !== sessionId);
          if (next.length !== groups[g].length) { groups[g] = next; changed = true; }
          if (groups[g].length === 0) delete groups[g];
        }
        if (changed) sessionStoreUpdate(keys.groups, groups);
        const saved = sessionStoreGet(keys.saved, []);
        const filteredSaved = saved.filter(s => s.sessionId !== sessionId);
        if (filteredSaved.length !== saved.length) sessionStoreUpdate(keys.saved, filteredSaved);
      }
      // Also remove from claudeSavedSessions (close-resume stores all agents there)
      const claudeSaved = sessionStoreGet('claudeSavedSessions', []);
      const claudeFiltered = claudeSaved.filter(s => s.sessionId !== sessionId);
      if (claudeFiltered.length !== claudeSaved.length) sessionStoreUpdate('claudeSavedSessions', claudeFiltered);
      // Remove from unified groups (claude groups store)
      const uGroups = sessionStoreGet('claudeSessionGroups', {});
      let uChanged = false;
      for (const g of Object.keys(uGroups)) {
        const next = uGroups[g].filter(id => id !== sessionId);
        if (next.length !== uGroups[g].length) { uGroups[g] = next; uChanged = true; }
        if (uGroups[g].length === 0) delete uGroups[g];
      }
      if (uChanged) sessionStoreUpdate('claudeSessionGroups', uGroups);
      state.refreshSessionTrees();
    })
  );

  // v2.6.0: sort + nesting commands
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.moveSessionUp', (item) => {
      const sid = item?._sessionId;
      if (sid) providerForItem(item).moveSessionUp(sid);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.moveSessionDown', (item) => {
      const sid = item?._sessionId;
      if (sid) providerForItem(item).moveSessionDown(sid);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.moveUnderSession', async (item) => {
      const sid = item?._sessionId;
      if (!sid) return;
      // v3.10: in the unified view, sub-session nesting is claude-only. A
      // non-claude leaf (kiro/codex/grok/agy) routes to the unified provider whose
      // store is claude's, so nesting it would (a) write the foreign id into
      // claudeSessionParent, (b) list claude's project dir as nest candidates,
      // and (c) flip its contextValue to subSession — which exposes claude-only
      // trash/restore that silently no-op the real foreign file. Block at source.
      if (item._unified && item._agent && item._agent !== 'claude') {
        vscode.window.showInformationMessage(
          t('nestUnifiedClaudeOnly')
        );
        return;
      }
      const prov = providerForItem(item);
      const isKiro = prov === state.kiroTreeProvider;
      const isAntigravity = prov === state.antigravityTreeProvider;
      const isCodex = prov === state.codexTreeProvider;
      const isGrok = prov === state.grokTreeProvider;
      const isGjc = prov === state.gjcTreeProvider;
      // Build candidate list: top-level sessions only (parent empty), not self.
      const parents = sessionStoreGet(prov._storeKey('parent'), {});
      const titleMap = sessionStoreGet(prov._storeKey('titles'), {});
      const hasChildrenOfMe = Object.values(parents).some(p => p === sid);
      if (hasChildrenOfMe) {
        vscode.window.showWarningMessage(t('nestDepthErr'));
        return;
      }
      // Candidate id list comes from each agent's own session source.
      let candidateIds;
      if (isKiro) {
        const kiroCwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
        const kiroList = kiroCwd ? listKiroSessions(kiroCwd) : [];
        candidateIds = kiroList.map(s => ({ id: s.sessionId, title: s.title }));
      } else if (isAntigravity) {
        const agyCwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
        const agyList = agyCwd ? listAntigravitySessions(agyCwd) : [];
        candidateIds = agyList.map(s => ({ id: s.sessionId, title: s.title }));
      } else if (isCodex) {
        const codexCwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
        const codexList = codexCwd ? listCodexSessions(codexCwd) : [];
        candidateIds = codexList.map(s => ({ id: s.sessionId, title: s.title }));
      } else if (isGrok) {
        const grokCwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
        const grokList = grokCwd ? listGrokSessions(grokCwd) : [];
        candidateIds = grokList.map(s => ({ id: s.sessionId, title: s.title }));
      } else if (isGjc) {
        const gjcCwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
        const gjcList = gjcCwd ? listGjcSessions(gjcCwd) : [];
        candidateIds = gjcList.map(s => ({ id: s.sessionId, title: s.title }));
      } else {
        const projDir = state.sessionTreeProvider._getProjectDir();
        if (!projDir) return;
        candidateIds = fs.readdirSync(projDir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => ({ id: f.replace('.jsonl', ''), title: null }));
      }
      const candidates = [];
      for (const c of candidateIds) {
        const cid = c.id;
        if (cid === sid) continue;
        if (parents[cid]) continue; // can't nest under a sub-session
        const label = titleMap[cid] || c.title || cid.substring(0, 8);
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
      const result = prov.setSessionParent(sid, pick.sessionId);
      if (!result.ok) {
        const reasons = { self: t('nestSelfErr'), depth: t('nestDepthErr'), hasChildren: t('nestHasChildrenErr') };
        vscode.window.showWarningMessage(reasons[result.reason] || 'Failed to nest');
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.removeSessionParent', (item) => {
      const sid = item?._sessionId;
      if (sid) providerForItem(item).removeSessionParent(sid);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.moveGroupUp', (item) => {
      const name = item?._groupName;
      if (name) providerForItem(item).moveGroupUp(name);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.moveGroupDown', (item) => {
      const name = item?._groupName;
      if (name) providerForItem(item).moveGroupDown(name);
    })
  );

  // v3.6.9: toggle archive flag on a custom group. Archive groups skip
  // title/firstMsg parsing on tree load (cheap at scale for stash-style
  // buckets of big jsonls) and bypass the 100-member soft cap that applies
  // to regular groups.
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.toggleGroupArchive', async (item) => {
      const groupName = item?._groupName;
      if (!groupName) return;
      const groups = sessionStoreGet('claudeSessionGroups', {});
      if (!(groupName in groups)) {
        vscode.window.showWarningMessage(t('archiveGroupNotFound') + groupName);
        return;
      }
      const archived = sessionStoreGet('claudeSessionGroupArchived', []);
      const set = new Set(Array.isArray(archived) ? archived : []);
      const wasOn = set.has(groupName);
      if (wasOn) set.delete(groupName);
      else set.add(groupName);
      sessionStoreUpdate('claudeSessionGroupArchived', Array.from(set));
      state.refreshSessionTrees();
      vscode.window.showInformationMessage(wasOn ? t('archiveModeOff') : t('archiveModeOn'));
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
      const prov = providerForItem(item);
      const groupsKey = prov._storeKey('groups');
      const groups = sessionStoreGet(groupsKey, {});
      if (!groups[newPath]) groups[newPath] = [];
      sessionStoreUpdate(groupsKey, groups);
      prov.refresh();
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
        state.refreshSessionTrees();
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

  // Sprint 0+1 — repo sync (file watcher + auto-commit + push, all gated on
  // claudeCodeLauncher.repoSync.enabled / autoCommit). Wrapped in try/catch so
  // a missing chokidar or a throw inside start() never breaks activate().
  try {
    const sync = require('./sync');
    sync.start(context);
    context.subscriptions.push(
      vscode.commands.registerCommand('claudeCodeLauncher.repoSync.setDeviceName', () => sync.setDeviceName()),
      vscode.commands.registerCommand('claudeCodeLauncher.repoSync.openSettings', () =>
        vscode.commands.executeCommand('workbench.action.openSettings', 'claudeCodeLauncher.repoSync')
      ),
    );
    state.syncModule = sync;
  } catch (err) {
    console.log(`[sync] failed to start: ${err && err.message ? err.message : err}`);
  }

  // Account switcher — multi-account switching, lifted from
  // rockuen/claude-account-switcher v0.1.1 into src/account/. The
  // module compiles to out/account/index.js via tsc.
  const account = require('../out/account');
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.switchAccount', () =>
      account.openAccountSwitcher(context)
    ),
    vscode.commands.registerCommand('claudeCodeLauncher.saveAccount', () =>
      account.promptSaveCurrentAccount(context)
    ),
  );

  // v3.6.1: left-aligned status bar item showing the active Claude
  // account. Click → switchAccount QuickPick. Hides itself when no
  // credentials exist; refreshes automatically after every save/swap
  // via switcher.ts:refreshActiveProfile().
  account.createAccountStatusBar(context);

  // v3.21.5: keep the ACTIVE profile's saved tokens byte-current with the
  // live ones. Anthropic rotates refresh tokens single-use, so a snapshot
  // taken before a rotation holds a token the server has already revoked.
  // profiles.ts was built expecting a sync on every credentials change but
  // nothing ever drove it, so a slot only stayed fresh while the user kept
  // switching through the launcher — leave an account via `claude /login`,
  // or just let the CLI rotate in the background, and switching back to it
  // later restored dead credentials.
  account.startAccountAutoSync(context);

  // v3.6.2: opt-in diagnostics for freeze investigation. The toggle is
  // off by default — when on, an OutputChannel named "CLI Launcher —
  // Diagnostics" gets a memory + per-panel chunk-stats dump every 10
  // minutes (and a baseline at startup). Reactive to config changes so
  // the user can toggle without reloading the window.
  const { Diagnostics } = require('./lib/diagnostics');
  function applyDiagnosticsToggle() {
    const enabled = vscode.workspace
      .getConfiguration('claudeCodeLauncher')
      .get('diagnostics.enabled', false);
    if (enabled && !state.diagnostics) {
      state.diagnostics = new Diagnostics();
      state.diagnostics.start();
    } else if (!enabled && state.diagnostics) {
      state.diagnostics.dispose();
      state.diagnostics = null;
    }
  }
  applyDiagnosticsToggle();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeCodeLauncher.diagnostics.enabled')) {
        applyDiagnosticsToggle();
      }
    }),
    vscode.commands.registerCommand(
      'claudeCodeLauncher.diagnostics.dumpNow',
      () => {
        if (!state.diagnostics) {
          vscode.window.showInformationMessage(
            'Diagnostics are disabled. Enable claudeCodeLauncher.diagnostics.enabled in settings first.',
          );
          return;
        }
        state.diagnostics.dumpNow();
      },
    ),
    {
      dispose: () => {
        if (state.diagnostics) {
          state.diagnostics.dispose();
          state.diagnostics = null;
        }
      },
    },
  );

  // v3.22.0 — `<scheme>://rockuen.cli-launcher-for-claude/resume?…` deep links.
  // Registered last: the handler resumes sessions through createPanel, which
  // needs the tree providers wired up above.
  registerSessionUriHandler(context);
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
        agent: entry.agent || 'claude',
        ...(entry.isKiroResume ? { isKiroResume: true } : {}),
        ...(entry.isAntigravityResume ? { isAntigravityResume: true } : {}),
        ...(entry.isCodexResume ? { isCodexResume: true } : {}),
        ...(entry.isGrokResume ? { isGrokResume: true } : {}),
        ...(entry.isGjcResume ? { isGjcResume: true } : {}),
        ...(entry.isChiefResume ? { isChiefResume: true } : {}),
        order: order++,
        viewColumn: entry.panel.viewColumn || 1
      });
    }
    deviceLocalSet('claudeSessions', sessions);
  }

  for (const [, entry] of state.panels) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    killPtyProcess(entry.pty);
  }
  state.panels.clear();

  // Best-effort synchronous force-commit on shutdown so changes from the last
  // few minutes don't get stranded waiting for the debounce timer.
  if (state.syncModule && typeof state.syncModule.flushSyncSync === 'function') {
    try { state.syncModule.flushSyncSync(); } catch (_) {}
  }
}

module.exports = { activate, deactivate };
