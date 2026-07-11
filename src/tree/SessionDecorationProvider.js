// @module tree/SessionDecorationProvider — colors session tree labels by jsonl size.
//
// Goal: surface oversized sessions visually so the user knows when to start
// a fresh session instead of letting one grow into 18+ MB territory (where
// it becomes a contributor to the background-task freeze pattern fixed in
// v3.5.7). The pure size readout already shows on the metadata row from
// v3.5.6, but the row only appears when expanded — a glance at the tree
// should already hint "this one's getting big."
//
// Thresholds + tooltip wording live in sessionDecorationCore.js (vscode-free
// so they can be unit-tested). This file only contains the vscode-runtime
// pieces: Uri builder, EventEmitter, FileDecorationProvider class.

const vscode = require('vscode');
const { t } = require('../i18n');
const {
  SCHEME,
  WARN_THRESHOLD,
  ERROR_THRESHOLD,
  formatMB,
  formatQuery,
  parseQuery,
  encodeSessionPath,
  getDecoration,
} = require('./sessionDecorationCore');

// Localized tooltip wording (English default) passed into the vscode-free
// getDecoration. Built per-call so a display-language change is picked up.
function _sizeLabels() {
  return {
    veryLargeTrash: t('sizeVeryLargeTrash'),
    veryLargeSplit: t('sizeVeryLargeSplit'),
    largeTrash: t('sizeLargeTrash'),
    largeSplit: t('sizeLargeSplit'),
  };
}

function buildUri(sessionId, size, trashed) {
  return vscode.Uri.parse(`${SCHEME}://${encodeSessionPath(sessionId)}?${formatQuery(size, trashed)}`);
}

class SessionDecorationProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeFileDecorations = this._emitter.event;
  }

  provideFileDecoration(uri) {
    if (!uri || uri.scheme !== SCHEME) return undefined;
    const { size, trashed } = parseQuery(uri.query);
    const dec = getDecoration(size, trashed, _sizeLabels());
    if (!dec) return undefined;
    return {
      color: new vscode.ThemeColor(dec.colorId),
      tooltip: dec.tooltip,
      propagate: false,
    };
  }

  // Tell VSCode to re-query decorations. Pass a specific uri to refresh just
  // that one, or omit to refresh all session items.
  refresh(uri) {
    this._emitter.fire(uri || undefined);
  }

  dispose() {
    this._emitter.dispose();
  }
}

module.exports = {
  SessionDecorationProvider,
  buildUri,
  // Re-export core helpers + constants so consumers don't need two import
  // paths just to access the thresholds.
  SCHEME,
  WARN_THRESHOLD,
  ERROR_THRESHOLD,
  formatMB,
  getDecoration,
};
