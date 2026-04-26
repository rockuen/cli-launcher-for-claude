// Phase 8 — smart `openTerminal` wrapper.
//
// Drives the keybinding (`cmd+shift+;`) and the editor/title icon. Reads the
// `claudeCodeLauncher.terminal.defaultBackend` setting and delegates to either
// the v2.6.6 webview command or the Phase 6 multiplexer command. Falls back
// to the webview when the user picked `multiplexer` but no multiplexer is
// available on the host.

export type TerminalBackend = 'webview' | 'multiplexer';

export interface PickBackendInput {
  /** User's preferred default — value of `claudeCodeLauncher.terminal.defaultBackend`. */
  preference: TerminalBackend;
  /** Whether tmux/psmux was successfully detected on this host. */
  multiplexerAvailable: boolean;
}

/**
 * Decide which backend to use for the smart "open" command.
 *
 * Rules:
 *   - preference=webview        -> always webview
 *   - preference=multiplexer:
 *       multiplexerAvailable=true  -> multiplexer
 *       multiplexerAvailable=false -> webview (silent fallback)
 *
 * Pure function; no vscode dependency, fully unit-testable.
 */
export function pickBackend(input: PickBackendInput): TerminalBackend {
  if (input.preference === 'multiplexer' && input.multiplexerAvailable) {
    return 'multiplexer';
  }
  return 'webview';
}
