// @module panel/panelTitle — sets a launcher tab's editor-tab title.
//
// Every tab title goes through here so the claudeCodeLauncher.tabTitle.* rules
// (lib/tabLabel) apply in one place. What surrounds the name — the ⚠ of a
// stuck tab, the done / exit suffix after exit — is kept on the entry, so a
// settings change can redraw each open tab as it is now.
//
// The compact rule depends on how many launcher tabs are open, so a tab
// opening or closing redraws the others too (refreshPanelTitles from
// createPanel).

const vscode = require('vscode');
const state = require('../state');
const { formatTabLabel } = require('../lib/tabLabel');

// Launcher tabs open in this window, in every editor group. Not per group: a
// split editor shares one window width among its tab bars, and a panel's
// viewColumn cannot be trusted for it — after a tab is moved to an earlier
// group the editor keeps reporting the old column until the next tab switch
// (seen in VSCodium: the titles of both groups stayed wrong for seconds).
function openTabCount() {
  let n = 0;
  for (const [, entry] of state.panels) {
    if (!entry._disposed) n++;
  }
  return n;
}

// tabCount: open launcher tabs; omitted = not counted, so the compact rule
// stays off (a tab being created, before it is in state.panels).
function tabLabel(title, tabCount) {
  const cfg = vscode.workspace.getConfiguration('claudeCodeLauncher');
  return formatTabLabel(title, {
    hideDatePrefix: cfg.get('tabTitle.hideDatePrefix', false),
    datePrefixFormat: cfg.get('renamePrefix.format', 'YYMMDD_'),
    maxLength: cfg.get('tabTitle.maxLength', 0),
    compactTabCount: cfg.get('tabTitle.compactTabCount', 0),
    compactLength: cfg.get('tabTitle.compactLength', 5),
    tabCount: tabCount || 0,
  });
}

// decor: { prefix, suffix } around the label; omitted = the bare name.
// tabCount: the open tabs, when the caller already counted them.
function setPanelTitle(entry, decor, tabCount) {
  const d = decor || {};
  entry._titleDecor = { prefix: d.prefix || '', suffix: d.suffix || '' };
  try {
    entry.panel.title = entry._titleDecor.prefix
      + tabLabel(entry.title, tabCount === undefined ? openTabCount() : tabCount)
      + entry._titleDecor.suffix;
  } catch (_) {}
}

function refreshPanelTitles(panels) {
  const tabCount = openTabCount();
  for (const [, entry] of panels) {
    if (!entry._disposed) setPanelTitle(entry, entry._titleDecor, tabCount);
  }
}

module.exports = { tabLabel, openTabCount, setPanelTitle, refreshPanelTitles };
