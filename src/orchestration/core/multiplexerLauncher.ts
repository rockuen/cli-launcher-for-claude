// Phase 6 — open Claude Code inside an external multiplexer session.
//
// Provides a single command body: spawn a fresh tmux/psmux session, run
// `claude` (or whatever the user configured) inside it, then either
// surface a notification or attach the user's preferred terminal client.
//
// Stays opt-in. The default `Open Claude Code` action keeps the v2.6.6
// webview behavior — this command only fires when the user picks the
// multiplexer entry, so multiplexer-less hosts are unaffected.

import { IMultiplexerBackend } from '../backends/IMultiplexerBackend';

export interface MultiplexerLaunchDeps {
  backend: IMultiplexerBackend;
  /** Working directory to seed the new session with. */
  cwd: string;
  /** Command to run as the session's first window. Defaults to `claude`. */
  command?: string;
  /** Notification surface — caller injects vscode.window.showInformationMessage. */
  showInfo: (message: string) => Thenable<string | undefined>;
}

/**
 * Generate a unique session name. Multiplexers reject duplicate names —
 * the timestamp suffix avoids collisions when a user spawns multiple
 * sessions in the same minute.
 */
export function buildSessionName(prefix = 'cli-launcher'): string {
  const ts = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14); // YYYYMMDDHHmmss
  return `${prefix}-${ts}`;
}

/**
 * Spawn a new multiplexer session with `claude` and surface an attach hint.
 *
 * The launcher does NOT auto-attach the multiplexer client to the user's
 * terminal — VSCode webview cannot host a tmux client cleanly across all
 * platforms. Instead we spawn detached, then show a copyable attach hint.
 * Power users can wire up their own keybinding or external terminal.
 */
export async function openClaudeInMultiplexer(
  deps: MultiplexerLaunchDeps,
): Promise<{ name: string }> {
  const command = deps.command ?? 'claude';
  const name = buildSessionName();

  await deps.backend.newSession({
    name,
    cwd: deps.cwd,
    command,
  });

  // Surface attach instruction. Mac/Linux: `tmux attach -t <name>`.
  // Windows / psmux: `psmux attach -t <name>`.
  const attachCmd = `${deps.backend.id} attach -t ${name}`;
  deps.showInfo(
    `CLI Launcher: started ${deps.backend.id} session "${name}" running ${command}. Attach from any terminal with:  ${attachCmd}`,
  );

  return { name };
}
