// detectMultiplexer — selects the appropriate multiplexer backend based on
// user preference and OS. Returns a ready-to-use IMultiplexerBackend, or
// null if no backend is available (or the user explicitly chose 'none').
//
// This function does NOT read VS Code configuration directly; the caller
// reads `claudeCodeLauncher.multiplexer.preferred` and passes it in.

import type { IMultiplexerBackend } from './IMultiplexerBackend';
import { TmuxBackend } from './TmuxBackend';
import { PsmuxBackend } from './PsmuxBackend';

export type MultiplexerPreference = 'auto' | 'tmux' | 'psmux' | 'none';

/**
 * Detect and return an available multiplexer backend.
 *
 * @param preference  User-configured preference (from VS Code settings).
 * @returns           A backend whose `available()` returned true, or null.
 */
export async function detectMultiplexer(
  preference: MultiplexerPreference,
): Promise<IMultiplexerBackend | null> {
  switch (preference) {
    case 'none':
      return null;

    case 'tmux': {
      const backend = new TmuxBackend();
      if (await backend.available()) {
        return backend;
      }
      backend.dispose();
      return null;
    }

    case 'psmux': {
      const backend = new PsmuxBackend();
      if (await backend.available()) {
        return backend;
      }
      backend.dispose();
      return null;
    }

    case 'auto': {
      if (process.platform === 'win32') {
        // Windows: prefer psmux (native), fall back to tmux (WSL-hosted).
        const psmux = new PsmuxBackend();
        if (await psmux.available()) {
          return psmux;
        }
        psmux.dispose();

        const tmux = new TmuxBackend();
        if (await tmux.available()) {
          return tmux;
        }
        tmux.dispose();
        return null;
      } else {
        // Mac / Linux: tmux only.
        const tmux = new TmuxBackend();
        if (await tmux.available()) {
          return tmux;
        }
        tmux.dispose();
        return null;
      }
    }
  }
}
