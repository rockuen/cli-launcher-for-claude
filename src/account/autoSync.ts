/**
 * Keep the active profile's saved tokens current.
 *
 * Anthropic rotates OAuth refresh tokens single-use: when Claude CLI
 * refreshes an expired access token it receives a NEW refresh token and
 * the previous one is revoked server-side. `profiles.ts` already has the
 * countermeasure — `syncActiveProfile()` re-snapshots the live pair into
 * whichever slot they belong to — and its docstring says it should run
 * "on every `~/.claude/.credentials.json` change". Nothing ever called
 * it that way: the only callers were the switcher's own UI actions.
 *
 * So a slot stayed byte-current only for as long as the user kept
 * driving switches through the launcher. Leave an account any other way
 * — `claude /login` in a terminal, or simply enough time passing that
 * the CLI rotates in the background — and that account's snapshot keeps
 * a refresh token the server has already revoked. Switching back to it
 * later restores dead credentials: the profile is still listed, still
 * switchable, and simply will not authenticate. Given long enough, one
 * account keeps working (the live one) and the other cannot be loaded
 * at all.
 *
 * Polling rather than watching, deliberately:
 *   - `fs.watch` on a single file is unreliable on Windows, and on
 *     macOS the credentials live in the Keychain with no file to watch.
 *   - Firing on the instant of a credentials write is actively WRONG.
 *     During `/login`, Claude CLI rewrites `.credentials.json` for the
 *     new account BEFORE `.claude.json` catches up, so an immediate
 *     sync reads the previous account's identity and would try to file
 *     the new tokens under the old account. Sampling on a slow cadence
 *     lets the pair settle first, and `updateProfile`'s identity guard
 *     refuses the write if it somehow does not.
 *
 * Rotation happens on the access token's ~8 h cycle, so a 5-minute
 * sample is far finer than it needs to be. Steady-state cost is two
 * stat calls (hashes are mtime-cached) and no writes.
 */
import * as vscode from "vscode";
import { syncActiveProfile } from "./profiles";

/** How often to re-check the live credentials against the active slot. */
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Delay before the first sync so activation stays cheap and a `/login`
 * that is still mid-flight has settled.
 */
const FIRST_SYNC_DELAY_MS = 20 * 1000;

/** Best-effort; a failure here must never surface or block anything. */
function syncQuietly(): void {
  try {
    syncActiveProfile();
  } catch {
    /* housekeeping only — the switcher still works without it */
  }
}

/**
 * Start the background sync. Registers its own disposal on `context`,
 * so callers need only invoke it once during activation.
 */
export function startAccountAutoSync(context: vscode.ExtensionContext): void {
  const first = setTimeout(syncQuietly, FIRST_SYNC_DELAY_MS);
  const timer = setInterval(syncQuietly, SYNC_INTERVAL_MS);

  // Returning to the window is the moment a `/login` run in an external
  // terminal is most likely to have just finished, and the point right
  // before the user reaches for the switcher. Sampling here means the
  // outgoing account's slot is current before they switch away from it.
  const focus = vscode.window.onDidChangeWindowState((e) => {
    if (e.focused) syncQuietly();
  });

  context.subscriptions.push({
    dispose() {
      clearTimeout(first);
      clearInterval(timer);
      focus.dispose();
    },
  });
}
