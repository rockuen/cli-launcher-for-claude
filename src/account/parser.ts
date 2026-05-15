/**
 * Account data parser — reads the minimum profile fields we display
 * (email, organization, subscription) plus the saved-profile list +
 * active-slug from `./profiles.ts`.
 *
 * Security: profile metadata is read from ~/.claude.json's
 * `oauthAccount` block only. OAuth tokens stay inside `profiles.ts` —
 * they never cross the extension/webview boundary.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  listProfiles,
  getActiveProfileSlug,
  type SavedProfile,
} from "./profiles";

const CLAUDE_JSON = path.join(os.homedir(), ".claude.json");

/** Public payload sent to the webview. No tokens, no usage data. */
export interface AccountData {
  profile: {
    email: string;
    organizationName: string;
    subscriptionType: string;
  };
  savedProfiles: SavedProfile[];
  activeProfileSlug: string | null;
}

/**
 * Parse the bare-minimum profile fields from ~/.claude.json. Each
 * field is optional and defaults to an empty string so the webview
 * always receives a well-shaped object even when the file is missing,
 * empty, or corrupt.
 */
function parseProfile(): AccountData["profile"] {
  const profile = { email: "", organizationName: "", subscriptionType: "" };
  let raw: string;
  try {
    raw = fs.readFileSync(CLAUDE_JSON, "utf-8");
  } catch {
    return profile;
  }
  if (!raw.trim()) return profile;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return profile;
  }
  const oauth = data.oauthAccount as Record<string, unknown> | undefined;
  if (!oauth) return profile;
  if (typeof oauth.emailAddress === "string") profile.email = oauth.emailAddress;
  if (typeof oauth.organizationName === "string") {
    profile.organizationName = oauth.organizationName;
  }
  if (typeof oauth.subscriptionType === "string") {
    profile.subscriptionType = oauth.subscriptionType;
  }
  return profile;
}

/**
 * Parse the full account payload. Safe to call often — reads one
 * small JSON file plus the saved-profile metadata files.
 */
export function parseAccountData(): AccountData {
  return {
    profile: parseProfile(),
    savedProfiles: listProfiles(),
    activeProfileSlug: getActiveProfileSlug(),
  };
}
