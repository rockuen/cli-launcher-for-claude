// Orchestration layer entry point.
//
// Phase 0 stub — toolchain bootstrap only. Real activation logic lands
// in Phase 4 (OMC mode toggle) and Phase 5 (CCG wiring).
//
// Wiring contract: extension.js (root) does
//   const { activate } = require('./out/orchestration');
// once Phase 4 lights up the OMC mode entry point.

import * as vscode from 'vscode';

export function activate(
  _ctx: vscode.ExtensionContext,
  _output: vscode.OutputChannel,
): void {
  // No-op. Phase 4 will populate this with OMC mode lifecycle wiring.
}
