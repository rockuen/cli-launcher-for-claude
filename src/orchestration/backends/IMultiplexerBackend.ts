// IMultiplexerBackend — common interface for terminal multiplexer wrappers.
//
// Phase 1 (Plan v1.0). Implementations:
//   - TmuxBackend  (Mac/Linux/WSL — tmux CLI wrapper)
//   - PsmuxBackend (Windows native — psmux CLI wrapper, tmux-compatible)
//
// Both wrappers shell out to the multiplexer CLI via child_process. They
// stay deliberately thin — no PTY management, no transcript capture. The
// extension's existing webview / node-pty layer keeps that responsibility.
//
// Why two backends instead of one
// -------------------------------
// tmux is unavailable on Windows in any first-class form. psmux is a
// native Windows port that mirrors tmux's command surface but with a
// different binary name and a few subtle differences (e.g. session
// names with spaces, prebuilt scroll/mouse defaults). Wrapping each
// in its own class keeps OS-specific quirks isolated.

export interface MultiplexerSession {
  /** Session name (unique within the multiplexer's running server). */
  readonly name: string;
  /** Working directory the session was created with. */
  readonly cwd: string;
}

export interface NewSessionOptions {
  /** Session name. Backend-specific name validation may apply. */
  name: string;
  /** Working directory for the first window/pane. */
  cwd: string;
  /** Optional command to run as the first window's main process. */
  command?: string;
  /** Optional environment variables. */
  env?: Record<string, string>;
}

export interface SendKeysOptions {
  /** Session name (or `session:window.pane` target). */
  target: string;
  /** Keys to send. Backend may translate special tokens (Enter, etc.). */
  keys: string;
  /** When true, append a literal Enter at the end. */
  enter?: boolean;
}

export interface IMultiplexerBackend {
  /** Stable identifier — `'tmux' | 'psmux'`. */
  readonly id: string;

  /**
   * Quick probe — returns true if the multiplexer binary is on PATH and
   * answers `<bin> -V` within ~500ms.
   *
   * Implementations cache the first result and reuse it. Call dispose()
   * to drop the cache.
   */
  available(): Promise<boolean>;

  /**
   * Spawn a new detached session.
   *
   * Resolves with `{ name, cwd }` on success.
   * Rejects with the underlying child_process error on failure (e.g.
   * binary not found, name collision).
   */
  newSession(opts: NewSessionOptions): Promise<MultiplexerSession>;

  /**
   * Send keystrokes (or a command) to a session/pane. Implementations
   * MUST translate `\n`/`\r` into the multiplexer's Enter token, NOT
   * a literal CR/LF byte (`tmux send-keys -l`-style raw fails for CLIs
   * that interpret bare `\r` as Shift+Enter, e.g. Claude Code on Win32
   * input mode).
   */
  sendKeys(opts: SendKeysOptions): Promise<void>;

  /** Kill a single session by name. No-op if it doesn't exist. */
  killSession(name: string): Promise<void>;

  /** List all running sessions. Empty array if no server is running. */
  listSessions(): Promise<MultiplexerSession[]>;

  /** Drop cached probe results / abort outstanding child_process calls. */
  dispose(): void;
}
