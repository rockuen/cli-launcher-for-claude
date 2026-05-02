// omcMode — OMC mode lifecycle.
//
// Manages the `claudeCodeLauncher.omcModeActive` VS Code context key.
// v3.0.4: always active by default. The dedicated status-bar indicator and
// onboarding prompt were removed — surfacing CCG / HUD without the toggle UI.
// `omc.enter` / `omc.exit` commands stay registered (callers in index.ts) so
// power users can still flip the mode off via the command palette.

import * as vscode from 'vscode';
import { detectOMC } from './OMCRuntime';

const _onDidChangeEmitter = new vscode.EventEmitter<boolean>();
/** Fires with `true` when OMC mode becomes active, `false` when inactive. */
export const onDidChangeOMCMode: vscode.Event<boolean> = _onDidChangeEmitter.event;

// Re-export pure types so callers only need to import from omcMode.
export type {
  InitialModeInputs,
  InitialModeDecision,
} from './omcModeLogic';
export { decideInitialMode } from './omcModeLogic';

export const OMC_MODE_CONTEXT_KEY = 'claudeCodeLauncher.omcModeActive';
export const OMC_ONBOARDING_KEY = 'claudeCodeLauncher.omcOnboardingShown';
export const OMC_MODE_PREF_KEY = 'claudeCodeLauncher.omcModeManuallyEnabled';

export interface OMCModeController {
  isActive(): boolean;
  enable(): Promise<void>;
  disable(): Promise<void>;
  dispose(): void;
}

export async function activateOMCMode(
  ctx: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<OMCModeController> {
  const detection = await detectOMC();
  output.appendLine(
    `[omc] detection: installed=${detection.installed} signals=${JSON.stringify(detection.signals)}`,
  );

  let _active = false;

  async function setActive(next: boolean, persistPref: boolean): Promise<void> {
    _active = next;
    await vscode.commands.executeCommand('setContext', OMC_MODE_CONTEXT_KEY, next);
    if (persistPref) {
      await ctx.globalState.update(OMC_MODE_PREF_KEY, next);
    }
    _onDidChangeEmitter.fire(next);
  }

  await setActive(true, false);

  const controller: OMCModeController = {
    isActive(): boolean {
      return _active;
    },

    async enable(): Promise<void> {
      await setActive(true, true);
      output.appendLine('[omc] mode enabled');
    },

    async disable(): Promise<void> {
      await setActive(false, true);
      output.appendLine('[omc] mode disabled');
    },

    dispose(): void {
      _onDidChangeEmitter.dispose();
    },
  };

  return controller;
}
