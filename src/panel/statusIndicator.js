// @module panel/statusIndicator — tab icon + status bar updates.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const state = require('../state');
const { t } = require('../i18n');

// v3.5.2: `shell-running` is a tab-icon-only state. entry.state stays as
// 'waiting'/'idle' so the status bar logic in updateStatusBar() is unchanged;
// we only repaint the tab dot blue when a background shell is keeping the
// session warm.
const BG_SHELL_TTL_MS = 30_000;

function setTabIcon(panel, status, extensionPath) {
  if (!panel) return;
  const suffix = {
    idle: 'idle',
    running: 'running',
    done: 'done',
    error: 'error',
    waiting: 'waiting',
    'shell-running': 'shell'
  }[status] || 'idle';

  // Pick a per-agent icon (panel._agent is stamped in createPanel from
  // entry.agent), falling back to the claude icon when an agent has no
  // dedicated set yet (e.g. kiro/antigravity before their svgs land).
  const agent = panel._agent || 'claude';
  try {
    let file = path.join(extensionPath, 'icons', `${agent}-${suffix}.svg`);
    if (agent !== 'claude' && !fs.existsSync(file)) {
      file = path.join(extensionPath, 'icons', `claude-${suffix}.svg`);
    }
    const iconUri = vscode.Uri.file(file);
    panel.iconPath = { light: iconUri, dark: iconUri };
  } catch (_) {}
}

function hasFreshBackgroundShell(entry) {
  if (!entry || !entry._bgShells || entry._bgShells <= 0) return false;
  const at = entry._bgShellsAt;
  if (!at) return false;
  return (Date.now() - at) < BG_SHELL_TTL_MS;
}

// Pick between 'idle' (gray) and 'shell-running' (blue) at the moment a panel
// is about to settle into a non-running state. Caller is anywhere we used to
// hard-code `setTabIcon(panel, 'idle', ...)`.
//
// We also schedule a one-shot timer so the dot fades back to gray after the
// TTL elapses without a new "N shells still running" chunk — Claude Code does
// not always re-emit the line, so without this the dot would stay blue forever
// once the background shell actually finished.
function setIdleIcon(panel, entry, extensionPath) {
  if (!panel || !entry) return;
  if (entry._bgShellsTimer) {
    clearTimeout(entry._bgShellsTimer);
    entry._bgShellsTimer = null;
  }
  const fresh = hasFreshBackgroundShell(entry);
  setTabIcon(panel, fresh ? 'shell-running' : 'idle', extensionPath);
  if (!fresh) return;
  const remaining = BG_SHELL_TTL_MS - (Date.now() - entry._bgShellsAt) + 100;
  if (remaining <= 0) return;
  entry._bgShellsTimer = setTimeout(() => {
    entry._bgShellsTimer = null;
    if (entry._disposed) return;
    // Re-paint based on the freshness check at fire time. If a newer chunk
    // bumped _bgShellsAt while we slept this stays blue and reschedules; if
    // not it falls back to gray idle.
    setIdleIcon(panel, entry, extensionPath);
  }, remaining);
}

function updateStatusBar() {
  let hasRunning = false;
  let hasNeedsAttention = false;
  let hasWaiting = false;

  for (const [, entry] of state.panels) {
    if (entry.state === 'running') hasRunning = true;
    if (entry.state === 'needs-attention') hasNeedsAttention = true;
    if (entry.state === 'waiting') hasWaiting = true;
  }

  if (hasRunning) setStatusBar('running');
  else if (hasNeedsAttention) setStatusBar('needs-attention');
  else if (hasWaiting) setStatusBar('waiting');
  else if (state.panels.size > 0) setStatusBar('done');
  else setStatusBar('idle');
}

// Param renamed from `state` → `nextState` to avoid shadowing the imported state module.
function setStatusBar(nextState) {
  if (!state.statusBar) return;
  const config = {
    idle:              { text: '$(hubot) Agent', bg: undefined },
    waiting:           { text: t('sbIdle'),      bg: undefined },
    running:           { text: t('sbRunning'),   bg: 'statusBarItem.warningBackground' },
    'needs-attention': { text: t('sbAttention'), bg: 'statusBarItem.prominentBackground' },
    done:              { text: t('sbDone'),      bg: undefined },
    error:             { text: t('sbError'),     bg: 'statusBarItem.errorBackground' }
  }[nextState];
  if (!config) return;

  state.statusBar.text = config.text;
  state.statusBar.backgroundColor = config.bg ? new vscode.ThemeColor(config.bg) : undefined;
}

// v3.14: push the focused session's model into the usage status bar (bottom
// IDE bar). The model id is read from the active session's transcript tail;
// the account module owns the actual status bar item. Both requires are lazy
// + guarded so a missing build (out/account) or jsonl read never throws on
// the focus hot path.
function refreshActiveSessionModel() {
  let model = null;
  try {
    const { getSessionModel } = require('../lib/sessionJsonl');
    const id = state.activeTabId;
    const active = id != null ? state.panels.get(id) : null;
    if (active && active.sessionId) {
      model = getSessionModel(active.sessionId, active.cwd, active.agent) || null;
    }
    // Fallback: no focused launcher tab (or it has no model line yet) → use the
    // newest session that DOES report a model, so the bar isn't blank on a cold
    // start / when focus is on a non-launcher editor.
    if (!model) {
      const entries = Array.from(state.panels.values());
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (!e || !e.sessionId) continue;
        const m = getSessionModel(e.sessionId, e.cwd, e.agent);
        if (m) { model = m; break; }
      }
    }
  } catch (_) {}
  try {
    require('../../out/account').setActiveSessionModel(model);
  } catch (_) {}
}

module.exports = {
  setTabIcon,
  setStatusBar,
  updateStatusBar,
  setIdleIcon,
  hasFreshBackgroundShell,
  BG_SHELL_TTL_MS,
  refreshActiveSessionModel
};
