// omcMode — OMC mode lifecycle + UX logic.
//
// Manages the `claudeCodeLauncher.omcModeActive` VS Code context key,
// a status-bar indicator, and a one-shot onboarding prompt.
//
// Command *registration* is intentionally NOT done here — callers (Phase 5
// and above) register `claudeCodeLauncher.omc.enter` / `.omc.exit` so that
// this module stays testable without a running extension host.

import * as vscode from 'vscode';
import { detectOMC } from './OMCRuntime';
import { decideInitialMode } from './omcModeLogic';

// ---------------------------------------------------------------------------
// onDidChange event — notifies listeners when OMC mode active state changes.
// Used by Phase 7 HUD wiring to show/hide the HUD status bar item.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Controller interface exposed to callers.
// ---------------------------------------------------------------------------

export interface OMCModeController {
  isActive(): boolean;
  enable(): Promise<void>;
  disable(): Promise<void>;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

function applyStatusBar(
  item: vscode.StatusBarItem,
  active: boolean,
): void {
  if (active) {
    item.text = '$(organization) OMC';
    item.tooltip = 'OMC mode active — click to exit';
    item.command = 'claudeCodeLauncher.omc.exit';
  } else {
    item.text = '$(organization) OMC OFF';
    item.tooltip = 'OMC mode inactive — click to enter';
    item.command = 'claudeCodeLauncher.omc.enter';
  }
}

// ---------------------------------------------------------------------------
// Main entry point.
// ---------------------------------------------------------------------------

export async function activateOMCMode(
  ctx: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<OMCModeController> {
  // 1. Status bar item — always visible.
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.show();

  // 2. Probe OMC installation.
  const detection = await detectOMC();
  output.appendLine(
    `[omc] detection: installed=${detection.installed} signals=${JSON.stringify(detection.signals)}`,
  );

  // 3. Determine initial active state.
  const manualPreference = ctx.globalState.get<boolean>(OMC_MODE_PREF_KEY);
  const onboardingShown = ctx.globalState.get<boolean>(OMC_ONBOARDING_KEY) ?? false;

  const decision = decideInitialMode({
    manualPreference,
    onboardingShown,
    omcInstalled: detection.installed,
  });

  let _active = false;

  // Internal setter — updates context key, globalState, status bar, and fires onDidChange.
  async function setActive(next: boolean, persistPref: boolean): Promise<void> {
    _active = next;
    await vscode.commands.executeCommand('setContext', OMC_MODE_CONTEXT_KEY, next);
    if (persistPref) {
      await ctx.globalState.update(OMC_MODE_PREF_KEY, next);
    }
    applyStatusBar(statusBar, next);
    _onDidChangeEmitter.fire(next);
  }

  if (decision.state === 'active') {
    await setActive(true, false);
  } else if (decision.state === 'inactive') {
    await setActive(false, false);
  } else {
    // show-onboarding
    await setActive(false, false);
    // Fire-and-forget — onboarding prompt is async, controller returns immediately.
    vscode.window
      .showInformationMessage(
        'OMC detected. Enable OMC mode to surface CCG and other OMC-dependent features?',
        'Enable',
        'Not now',
      )
      .then(async (choice) => {
        await ctx.globalState.update(OMC_ONBOARDING_KEY, true);
        if (choice === 'Enable') {
          await controller.enable();
        }
      });
  }

  // 4. Build the controller.
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
      statusBar.dispose();
      _onDidChangeEmitter.dispose();
    },
  };

  return controller;
}
