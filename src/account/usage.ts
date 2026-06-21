/**
 * Claude usage fetcher — mirrors what Gajae Code (gjc) does internally to
 * surface the active Claude account's rate-limit windows:
 *
 *   GET https://api.anthropic.com/api/oauth/usage   (Bearer OAuth token)
 *     → { five_hour, seven_day, seven_day_opus, seven_day_sonnet }
 *       each: { utilization: 0..100, resets_at: ISO-8601 }
 *
 * The same OAuth token Claude Code stores in `.credentials.json` (or the
 * macOS Keychain) is reused via {@link readLiveCredsRaw}. Access tokens
 * rotate ~hourly, so an expired token is refreshed against
 *   POST https://api.anthropic.com/v1/oauth/token  (grant_type=refresh_token)
 * and the rotated tokens are written straight back into the live credential
 * store — exactly what Claude Code itself does — so we never strand a
 * rotated refresh token and the user stays logged in.
 *
 * Network + cache: `fetch` is the Electron/Node global VS Code ships. The
 * last successful report is cached for {@link CACHE_TTL_MS}; callers hit the
 * cache and trigger at most one in-flight refresh.
 *
 * Security: tokens never leave this process — they go from the credential
 * store into the Authorization header and (when rotated) back to the store.
 * Nothing here logs token bytes.
 */
import { readLiveCredsRaw, writeLiveCredsRaw } from "./liveCreds";

// Claude Code's public OAuth client id (base64-decoded in gjc; inlined here).
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

// Headers Anthropic's OAuth endpoints expect from a Claude-Code-class client.
const USAGE_HEADERS: Record<string, string> = {
  accept: "application/json, text/plain, */*",
  "anthropic-beta": "oauth-2025-04-20",
  "content-type": "application/json",
  "user-agent": "claude-cli/2.1.63 (external, cli)",
};

const TOKEN_SKEW_MS = 60_000; // refresh a minute before the token actually expires
const CACHE_TTL_MS = 60_000; // reuse a usage report for this long
const FETCH_TIMEOUT_MS = 15_000;

/** A single normalized rate-limit window. */
export interface UsageBucket {
  /** Percent used, 0..100. */
  utilization: number;
  /** Absolute reset time (ms since epoch), or null when unknown. */
  resetsAt: number | null;
}

/** Normalized Claude usage snapshot. */
export interface ClaudeUsage {
  fetchedAt: number;
  fiveHour: UsageBucket | null;
  sevenDay: UsageBucket | null;
  /** Per-model weekly window — present on plans with Opus/Sonnet tiers. */
  sevenDayOpus: UsageBucket | null;
  sevenDaySonnet: UsageBucket | null;
}

interface OAuthCreds {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Read + parse the live OAuth credential blob. Returns the raw object too
 *  so a refreshed token can be written back without dropping sibling keys. */
function readCreds(): { creds: OAuthCreds; raw: Record<string, unknown> } | null {
  const rawStr = readLiveCredsRaw();
  if (!rawStr) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawStr);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const oauth = parsed.claudeAiOauth;
  if (!isRecord(oauth)) return null;
  const accessToken = typeof oauth.accessToken === "string" ? oauth.accessToken : "";
  const refreshToken = typeof oauth.refreshToken === "string" ? oauth.refreshToken : "";
  const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0;
  if (!accessToken && !refreshToken) return null;
  return { creds: { accessToken, refreshToken, expiresAt }, raw: parsed };
}

/** Write rotated tokens back into the live store, preserving every other
 *  field (organizationUuid, scopes, subscriptionType, rateLimitTier, …). */
function persistCreds(
  raw: Record<string, unknown>,
  next: { accessToken: string; refreshToken: string; expiresAt: number },
): void {
  const oauth = isRecord(raw.claudeAiOauth) ? raw.claudeAiOauth : {};
  oauth.accessToken = next.accessToken;
  oauth.refreshToken = next.refreshToken;
  oauth.expiresAt = next.expiresAt;
  raw.claudeAiOauth = oauth;
  try {
    writeLiveCredsRaw(JSON.stringify(raw));
  } catch {
    // Persisting is best-effort: the in-memory token still works for this
    // run even if the write fails (e.g. read-only fs / locked keychain).
  }
}

/** Refresh an expired access token; returns the rotated credentials or null. */
async function refreshToken(refresh: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: number } | null> {
  if (!refresh) return null;
  let resp: Response;
  try {
    resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refresh }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    return null;
  }
  if (!isRecord(data) || typeof data.access_token !== "string" || typeof data.expires_in !== "number") {
    return null;
  }
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : refresh,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

/** Return a valid (refreshed if needed) access token, or null when there are
 *  no usable credentials. Rotated tokens are persisted back to the store. */
async function ensureAccessToken(): Promise<string | null> {
  const read = readCreds();
  if (!read) return null;
  const { creds, raw } = read;
  if (creds.accessToken && creds.expiresAt > Date.now() + TOKEN_SKEW_MS) {
    return creds.accessToken;
  }
  const refreshed = await refreshToken(creds.refreshToken);
  if (!refreshed) {
    // Refresh failed (no refresh token / network / revoked). Fall back to the
    // existing access token — it may still work, or the caller gets a 401.
    return creds.accessToken || null;
  }
  persistCreds(raw, refreshed);
  return refreshed.accessToken;
}

/** Pure: normalize one Anthropic usage bucket. Exported for tests. */
export function parseBucket(bucket: unknown): UsageBucket | null {
  if (!isRecord(bucket)) return null;
  const util = typeof bucket.utilization === "number" ? bucket.utilization : undefined;
  if (util === undefined) return null;
  let resetsAt: number | null = null;
  if (typeof bucket.resets_at === "string") {
    const parsed = Date.parse(bucket.resets_at);
    if (Number.isFinite(parsed)) resetsAt = parsed;
  }
  return { utilization: Math.min(Math.max(util, 0), 100), resetsAt };
}

/** Pure: turn the raw `/api/oauth/usage` payload into a {@link ClaudeUsage}.
 *  Exported so tests can exercise it without the network. Returns null when
 *  the payload carries no recognizable usage window. */
export function parseUsagePayload(payload: unknown): ClaudeUsage | null {
  if (!isRecord(payload)) return null;
  const usage: ClaudeUsage = {
    fetchedAt: Date.now(),
    fiveHour: parseBucket(payload.five_hour),
    sevenDay: parseBucket(payload.seven_day),
    sevenDayOpus: parseBucket(payload.seven_day_opus),
    sevenDaySonnet: parseBucket(payload.seven_day_sonnet),
  };
  if (!usage.fiveHour && !usage.sevenDay && !usage.sevenDayOpus && !usage.sevenDaySonnet) {
    return null;
  }
  return usage;
}

/** One network round-trip: ensure a token, then GET the usage endpoint. */
async function fetchClaudeUsage(): Promise<ClaudeUsage | null> {
  const token = await ensureAccessToken();
  if (!token) return null;
  let resp: Response;
  try {
    resp = await fetch(USAGE_URL, {
      headers: { ...USAGE_HEADERS, authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  let payload: unknown;
  try {
    payload = await resp.json();
  } catch {
    return null;
  }
  return parseUsagePayload(payload);
}

let cached: ClaudeUsage | null = null;
let inflight: Promise<ClaudeUsage | null> | null = null;

/** Last successfully fetched usage report (no network). */
export function getCachedUsage(): ClaudeUsage | null {
  return cached;
}

/** True when usable Claude OAuth credentials exist on this machine. */
export function hasClaudeCredentials(): boolean {
  return readCreds() !== null;
}

/**
 * Return a fresh-enough usage report. Within {@link CACHE_TTL_MS} of the last
 * success this resolves from cache; otherwise it triggers (and de-dupes) a
 * single network refresh. `force` bypasses the TTL.
 */
export async function refreshUsage(force = false): Promise<ClaudeUsage | null> {
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }
  if (inflight) return inflight;
  inflight = fetchClaudeUsage()
    .then((report) => {
      if (report) cached = report;
      return report ?? cached;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Turn a raw model id into a short human label. Pure + vscode-free so it is
 * unit-testable and reusable by the status bar:
 *   claude-opus-4-7              → Opus 4.7
 *   claude-sonnet-4-5-20250929   → Sonnet 4.5
 *   claude-3-5-haiku-20241022    → Haiku 3.5
 *   anthropic/claude-opus-4-8    → Opus 4.8   (provider/ prefix stripped)
 *   gpt-5.2-codex                → GPT 5.2 Codex
 *   gemini-3-pro                 → Gemini 3 Pro
 * Falls back to the (provider-stripped) raw id when no pattern matches.
 */
export function formatModelLabel(raw: string): string {
  const id = raw.trim();
  if (!id) return id;
  // "provider/model" → keep only the model segment for matching/display.
  const core = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  const lower = core.toLowerCase();

  // Anthropic Claude family: family word + first two version segments,
  // ignoring a trailing yyyymmdd date stamp.
  const fam = lower.match(/(opus|sonnet|haiku)/);
  if (fam) {
    const family = fam[1][0].toUpperCase() + fam[1].slice(1);
    const nums = lower.replace(/\d{8}$/, "").match(/(\d+)-(\d+)/);
    if (nums) return `${family} ${nums[1]}.${nums[2]}`;
    const single = lower.match(/(opus|sonnet|haiku)-?(\d+)/);
    if (single) return `${family} ${single[2]}`;
    return family;
  }

  // OpenAI GPT / Codex.
  if (lower.startsWith("gpt")) {
    return core
      .split("-")
      .map((seg) => (/^gpt/i.test(seg) ? seg.toUpperCase() : seg.charAt(0).toUpperCase() + seg.slice(1)))
      .join(" ");
  }

  // Gemini / Grok / other coding-plan families: title-case the dash segments.
  if (/^(gemini|grok|glm|qwen|kimi|minimax)/.test(lower)) {
    return core
      .split("-")
      .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
      .join(" ");
  }

  return core;
}
