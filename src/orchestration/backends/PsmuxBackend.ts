// PsmuxBackend — IMultiplexerBackend implementation for psmux (Windows native).
//
// psmux is a tmux-compatible Windows port. Its CLI surface mirrors tmux
// exactly, so this class simply inherits TmuxBackend and overrides the
// binary name and id. Windows-specific quirks (e.g. session names with
// spaces, ConPTY scroll defaults) can be added here as overrides without
// touching TmuxBackend.

import { TmuxBackend } from './TmuxBackend';

export class PsmuxBackend extends TmuxBackend {
  override readonly id: string = 'psmux';
  // On Windows, child_process resolves `psmux` to `psmux.exe` automatically.
  protected override readonly bin: string = 'psmux';
}
