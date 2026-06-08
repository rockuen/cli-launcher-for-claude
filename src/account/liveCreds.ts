/**
 * Live-credentials backend — where the *active* Claude account's OAuth
 * tokens physically live, abstracted over the OS difference.
 *
 *   - Windows / Linux: Claude CLI writes `~/.claude/.credentials.json`
 *     as a plain file. The account-switcher reads/writes that file.
 *   - macOS: Claude CLI stores the same JSON in the login **Keychain**
 *     (service `Claude Code-credentials`), NOT as a file — so the file
 *     never exists and a file-only switcher silently reports
 *     "no active account". This module reads/writes the Keychain item
 *     via the `security` CLI instead.
 *
 * The Keychain item's secret is byte-identical to what the file backend
 * stores: a JSON string `{"claudeAiOauth":{accessToken,refreshToken,
 * expiresAt,scopes,subscriptionType,rateLimitTier}}`. So every parser in
 * `profiles.ts` (identity extraction, snapshot metadata) works on the
 * raw string unchanged — only the read/write transport differs.
 *
 * Snapshot slots under `~/.claude/account-switcher/<slug>/` stay plain
 * files on every OS; only the *live* side is backend-aware. Switching
 * therefore means: copy the slot file's bytes into the live backend
 * (file write on Win/Linux, Keychain write on macOS) and vice-versa.
 *
 * Security: the secret is passed to `security add-generic-password` as
 * an argv element (`-w <raw>`). We use `execFileSync` (no shell) so the
 * value is never interpreted by a shell, and the exposure window is a
 * single short-lived process whose argv is only visible to the same
 * user — the same trust boundary under which the token already sits in
 * the Keychain / on disk. We never log the secret.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { CLAUDE_DIR } from "./config";

const CREDENTIALS_FILE = path.join(CLAUDE_DIR, ".credentials.json");

/** Keychain service name Claude Code stores its credentials under (macOS). */
const KEYCHAIN_SERVICE = "Claude Code-credentials";

export type CredsBackend = "file" | "keychain";

/**
 * Which backend holds the live credentials on this machine.
 *
 * Defaults to the Keychain on macOS and a file elsewhere. The
 * `CLI_LAUNCHER_CREDS_BACKEND` env var force-overrides this — primarily
 * so the file-based unit tests stay on the file path even when they run
 * on a darwin host (where the default would otherwise reach for a real
 * Keychain). Accepts `"file"` or `"keychain"`; anything else is ignored.
 */
export function credsBackend(): CredsBackend {
  const forced = process.env.CLI_LAUNCHER_CREDS_BACKEND;
  if (forced === "file" || forced === "keychain") return forced;
  return process.platform === "darwin" ? "keychain" : "file";
}

/**
 * macOS only: the account name (`-a`) the Keychain item is stored under.
 * Claude CLI typically uses the OS username, but we read it back from
 * the existing item rather than assume, so an in-place update (`-U`)
 * targets the exact same item instead of creating a duplicate. Returns
 * null when no item exists yet (first-ever save on a fresh machine).
 */
function keychainAccount(): string | null {
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE],
      { encoding: "utf-8" },
    );
    // `security` prints the attributes block with a line like:
    //   "acct"<blob>="rockuen"
    const m = out.match(/"acct"<blob>="((?:[^"\\]|\\.)*)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Read the live credentials as a raw JSON string, or null when none
 * exist. On macOS this fetches the Keychain secret; elsewhere it reads
 * the file. Never throws — callers treat null as "no active account".
 */
export function readLiveCredsRaw(): string | null {
  if (credsBackend() === "keychain") {
    try {
      const raw = execFileSync(
        "security",
        ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
        { encoding: "utf-8" },
      );
      const trimmed = raw.trim();
      return trimmed ? trimmed : null;
    } catch {
      // No item / locked keychain / security unavailable.
      return null;
    }
  }
  try {
    return fs.readFileSync(CREDENTIALS_FILE, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Write the live credentials from a raw JSON string. On macOS this
 * updates the Keychain item in place (`-U`, reusing the existing
 * account name so we never fork a duplicate item); elsewhere it
 * overwrites the file. Throws on failure so the caller's swap logic can
 * roll back the paired `.claude.json` write.
 */
export function writeLiveCredsRaw(raw: string): void {
  if (credsBackend() === "keychain") {
    const acct = keychainAccount() || os.userInfo().username;
    execFileSync("security", [
      "add-generic-password",
      "-U", // update the existing item instead of failing on duplicate
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      acct,
      "-w",
      raw,
    ]);
    return;
  }
  fs.writeFileSync(CREDENTIALS_FILE, raw);
}

/** True when live credentials exist on this machine (file or Keychain). */
export function liveCredsExist(): boolean {
  if (credsBackend() === "keychain") return keychainAccount() !== null;
  return fs.existsSync(CREDENTIALS_FILE);
}
