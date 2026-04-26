// Orchestration layer entry point — Phase 4: OMC mode toggle.
//
// Wiring contract: activation.js does
//   const orchestration = require('./out/orchestration');
//   orchestration.activate(context, outputChannel).catch(...)

import * as vscode from 'vscode';
import { activateOMCMode, OMCModeController } from './core/omcMode';

export async function activate(
  ctx: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<void> {
  const controller: OMCModeController = await activateOMCMode(ctx, output);

  ctx.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.omc.enter', () => controller.enable()),
    vscode.commands.registerCommand('claudeCodeLauncher.omc.exit', () => controller.disable()),
    { dispose: () => controller.dispose() },
  );
}
