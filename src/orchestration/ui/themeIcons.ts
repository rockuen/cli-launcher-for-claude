// vscode-dependent theme icon helpers split out of `colors.ts`.
//
// `colors.ts` stays vscode-free so unit tests can import it under
// node:test without a vscode shim. UI-side code that actually renders
// VSCode tree items / status bar items imports from this module.

import * as vscode from 'vscode';
import {
  AgentKind,
  COLOR_IDS,
  LauncherStatus,
  agentColorId,
  agentIconId,
} from './colors';

export function agentThemeIcon(kind: AgentKind): vscode.ThemeIcon {
  const id = agentIconId(kind);
  const colorId = agentColorId(kind);
  return colorId
    ? new vscode.ThemeIcon(id, new vscode.ThemeColor(colorId))
    : new vscode.ThemeIcon(id);
}

export function statusThemeIcon(status: LauncherStatus | undefined): vscode.ThemeIcon {
  switch (status) {
    case 'running':
      return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(COLOR_IDS.statusRunning));
    case 'done':
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor(COLOR_IDS.statusDone));
    case 'failed':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor(COLOR_IDS.statusFailed));
    case 'cancelled':
      return new vscode.ThemeIcon(
        'circle-slash',
        new vscode.ThemeColor(COLOR_IDS.statusCancelled),
      );
    default:
      return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor(COLOR_IDS.statusIdle));
  }
}
