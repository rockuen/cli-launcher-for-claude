// @module panel/panelTitle — sets a launcher tab's editor-tab title.
//
// Every tab title goes through here so the claudeCodeLauncher.tabTitle.* rules
// (lib/tabLabel) apply in one place. What surrounds the name — the ⚠ while
// blinking or stuck, the done / error suffix after exit — is kept on the entry,
// so a settings change can redraw each open tab as it is now.

const vscode = require('vscode');
const { formatTabLabel } = require('../lib/tabLabel');

function tabLabel(title) {
  const cfg = vscode.workspace.getConfiguration('claudeCodeLauncher');
  return formatTabLabel(title, {
    hideDatePrefix: cfg.get('tabTitle.hideDatePrefix', false),
    datePrefixFormat: cfg.get('renamePrefix.format', 'YYMMDD_'),
    maxLength: cfg.get('tabTitle.maxLength', 0),
  });
}

// decor: { prefix, suffix } around the label; omitted = the bare name.
function setPanelTitle(entry, decor) {
  const d = decor || {};
  entry._titleDecor = { prefix: d.prefix || '', suffix: d.suffix || '' };
  try {
    entry.panel.title = entry._titleDecor.prefix + tabLabel(entry.title) + entry._titleDecor.suffix;
  } catch (_) {}
}

function refreshPanelTitles(panels) {
  for (const [, entry] of panels) {
    if (!entry._disposed) setPanelTitle(entry, entry._titleDecor);
  }
}

module.exports = { tabLabel, setPanelTitle, refreshPanelTitles };
