// Orchestration layer entry point — Phase 6: optional multiplexer terminal.
//
// Wiring contract: activation.js does
//   const orchestration = require('./out/orchestration');
//   orchestration.activate(context, outputChannel).catch(...)

import * as vscode from 'vscode';
import { activateOMCMode, OMCModeController } from './core/omcMode';
import { CcgArtifactWatcher } from './core/CcgArtifactWatcher';
import { CcgTreeProvider } from './ui/CcgTreeProvider';
import { CcgViewerPanel } from './ui/CcgViewerPanel';
import type { CcgPair, CcgSnapshot } from './types/ccg';
import {
  detectMultiplexer,
  MultiplexerPreference,
} from './backends/detectMultiplexer';
import { IMultiplexerBackend } from './backends/IMultiplexerBackend';
import { openClaudeInMultiplexer } from './core/multiplexerLauncher';

const MULTIPLEXER_AVAILABLE_KEY = 'claudeCodeLauncher.multiplexerAvailable';

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

  // --- CCG tri-model viewer ---
  const ccgProvider = new CcgTreeProvider();
  const ccgView = vscode.window.createTreeView('claudeCodeLauncher.ccgPanel', {
    treeDataProvider: ccgProvider,
  });
  ctx.subscriptions.push(ccgView);

  const ccgWatcher = new CcgArtifactWatcher((msg) => output.appendLine(msg));
  ccgWatcher.on('snapshot', (snap: CcgSnapshot) => {
    ccgProvider.update(snap);
    CcgViewerPanel.refreshIfOpen();
  });
  ctx.subscriptions.push({ dispose: () => ccgWatcher.stop() });

  const initialRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  ccgWatcher.start(initialRoot);

  const ccgDeps = {
    getPair: (id: string): CcgPair | null => ccgProvider.findPair(id),
    onRerun: async (pair: CcgPair) => {
      const promptText =
        pair.codex?.originalTask ?? pair.gemini?.originalTask ?? pair.title;
      const text = promptText.replace(/\s+/g, ' ').trim().slice(0, 600);
      await vscode.env.clipboard.writeText(`/ccg "${text}"`);
      vscode.window.showInformationMessage(
        'CLI Launcher: /ccg command copied. Paste it into a Claude Code terminal to re-run.',
      );
    },
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.ccg.focus', async () => {
      await vscode.commands.executeCommand('claudeCodeLauncher.ccgPanel.focus');
      const snap = ccgProvider.getSnapshot();
      if (snap && snap.pairs[0]) {
        CcgViewerPanel.show(ctx, ccgDeps, output, snap.pairs[0].id);
      }
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.ccg.refresh', () =>
      ccgWatcher.forceRefresh(),
    ),
    vscode.commands.registerCommand('claudeCodeLauncher.ccg.openPair', (id: unknown) => {
      if (typeof id !== 'string') return;
      CcgViewerPanel.show(ctx, ccgDeps, output, id);
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.ccg.rerun', async () => {
      const snap = ccgProvider.getSnapshot();
      if (!snap || snap.pairs.length === 0) {
        vscode.window.showInformationMessage(
          'CLI Launcher: no CCG sessions to re-run yet.',
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        snap.pairs.map((p) => ({
          label: p.title,
          description: new Date(p.createdAt).toLocaleString(),
          id: p.id,
        })),
        { placeHolder: 'Pick a CCG session to re-run' },
      );
      if (!picked) return;
      const pair = ccgProvider.findPair(picked.id);
      if (pair) await ccgDeps.onRerun(pair);
    }),
  );

  // --- Phase 6: optional multiplexer terminal ---
  // Detect tmux/psmux availability up-front and reflect it in a context
  // key so package.json can hide the multiplexer command on hosts where
  // it would never work.
  const multiplexerPref = vscode.workspace
    .getConfiguration('claudeCodeLauncher')
    .get<MultiplexerPreference>('multiplexer.preferred', 'auto');
  let multiplexerBackend: IMultiplexerBackend | null = null;
  try {
    multiplexerBackend = await detectMultiplexer(multiplexerPref);
  } catch (err) {
    output.appendLine(`[multiplexer] detect failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const multiplexerAvailable = multiplexerBackend !== null;
  await vscode.commands.executeCommand('setContext', MULTIPLEXER_AVAILABLE_KEY, multiplexerAvailable);
  output.appendLine(
    `[multiplexer] preference=${multiplexerPref} available=${multiplexerAvailable}` +
      (multiplexerBackend ? ` backend=${multiplexerBackend.id}` : ''),
  );

  if (multiplexerBackend) {
    const backend = multiplexerBackend;
    ctx.subscriptions.push({ dispose: () => backend.dispose() });
    ctx.subscriptions.push(
      vscode.commands.registerCommand(
        'claudeCodeLauncher.openInMultiplexer',
        async () => {
          const cwd =
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
          try {
            await openClaudeInMultiplexer({
              backend,
              cwd,
              showInfo: (m) => vscode.window.showInformationMessage(m),
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(
              `CLI Launcher: failed to start ${backend.id} session — ${msg}`,
            );
            output.appendLine(`[multiplexer] launch failed: ${msg}`);
          }
        },
      ),
    );
  }
}
