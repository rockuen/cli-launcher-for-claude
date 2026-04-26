// TmuxBackend — IMultiplexerBackend implementation for tmux (Mac/Linux/WSL).
//
// Shells out to the `tmux` CLI via child_process. All I/O is async;
// no PTY management — that remains in the extension's node-pty layer.
//
// Testability: subclasses (and tests) can override the protected `run()`
// method to inject a fake executor without touching real processes.

import * as childProcess from 'node:child_process';
import { promisify } from 'node:util';
import type {
  IMultiplexerBackend,
  MultiplexerSession,
  NewSessionOptions,
  SendKeysOptions,
} from './IMultiplexerBackend';

export interface ExecResult {
  stdout: string;
  stderr: string;
}

// Type alias for the promisified execFile signature we use.
type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { timeout: number; env?: NodeJS.ProcessEnv },
) => Promise<ExecResult>;

const DEFAULT_TIMEOUT_MS = 5_000;
const AVAILABLE_TIMEOUT_MS = 500;

export class TmuxBackend implements IMultiplexerBackend {
  readonly id: string = 'tmux';
  protected readonly bin: string = 'tmux';

  // Cache: undefined = not yet probed, true/false = cached result.
  private _available: boolean | undefined = undefined;

  /**
   * Low-level executor. Tests override this by subclassing or by replacing
   * the underlying child_process.execFile via mock.method before the
   * promisified wrapper is created.
   *
   * We re-promisify on each call so that mock.method replacements on
   * childProcess.execFile are picked up correctly.
   */
  protected exec(
    args: readonly string[],
    opts: { timeout: number; env?: NodeJS.ProcessEnv },
  ): Promise<ExecResult> {
    const execAsync = promisify(childProcess.execFile) as ExecFileFn;
    return execAsync(this.bin, args, opts);
  }

  async available(): Promise<boolean> {
    if (this._available !== undefined) {
      return this._available;
    }
    try {
      await this.exec(['-V'], { timeout: AVAILABLE_TIMEOUT_MS });
      this._available = true;
    } catch {
      this._available = false;
    }
    return this._available;
  }

  async newSession(opts: NewSessionOptions): Promise<MultiplexerSession> {
    const { name, cwd, command, env } = opts;

    // Inject env vars before creating the session so they land in the
    // server's environment table for the new session's processes.
    if (env) {
      for (const [key, value] of Object.entries(env)) {
        // Best-effort; ignore failure (server may not be running yet).
        await this.exec(['set-environment', '-g', key, value], {
          timeout: DEFAULT_TIMEOUT_MS,
        }).catch(() => undefined);
      }
    }

    const args = ['new-session', '-d', '-s', name, '-c', cwd];
    if (command) {
      args.push(command);
    }

    await this.exec(args, {
      timeout: DEFAULT_TIMEOUT_MS,
      env: env ? { ...process.env, ...env } : undefined,
    });

    return { name, cwd };
  }

  async sendKeys(opts: SendKeysOptions): Promise<void> {
    const { target, keys, enter } = opts;

    // Use `-l` (literal mode) so tmux treats every character as a literal
    // keystroke, not a key name. This correctly handles multi-line strings
    // and special characters. The `--` sentinel separates flags from keys.
    await this.exec(
      ['send-keys', '-l', '-t', target, '--', keys],
      { timeout: DEFAULT_TIMEOUT_MS },
    );

    if (enter) {
      // Send Enter as a named key — NOT a literal \r — to avoid
      // bare-CR issues in PTY line editors (e.g. Claude Code Win32 mode).
      await this.exec(
        ['send-keys', '-t', target, 'Enter'],
        { timeout: DEFAULT_TIMEOUT_MS },
      );
    }
  }

  async killSession(name: string): Promise<void> {
    try {
      await this.exec(['kill-session', '-t', name], {
        timeout: DEFAULT_TIMEOUT_MS,
      });
    } catch (err) {
      // Swallow "session not found" (exit code 1); re-throw everything else.
      const stderr: string =
        (err as { stderr?: string }).stderr ?? '';
      const exitCode: unknown = (err as { code?: unknown }).code;
      if (
        exitCode === 1 ||
        stderr.includes('no such session') ||
        stderr.includes("can't find session")
      ) {
        return;
      }
      throw err;
    }
  }

  async listSessions(): Promise<MultiplexerSession[]> {
    try {
      const { stdout } = await this.exec(
        ['list-sessions', '-F', '#{session_name}|#{session_path}'],
        { timeout: DEFAULT_TIMEOUT_MS },
      );
      return stdout
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          const idx = line.indexOf('|');
          if (idx === -1) {
            return { name: line.trim(), cwd: '' };
          }
          return {
            name: line.slice(0, idx),
            cwd: line.slice(idx + 1),
          };
        });
    } catch (err) {
      const stderr: string =
        (err as { stderr?: string }).stderr ?? '';
      // No tmux server running — return empty list, not an error.
      if (
        stderr.includes('no server running') ||
        stderr.includes('No such file or directory') ||
        stderr.includes('error connecting to')
      ) {
        return [];
      }
      throw err;
    }
  }

  dispose(): void {
    this._available = undefined;
  }
}
