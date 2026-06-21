/**
 * Usage status bar — a right-aligned bottom-bar item showing, for the
 * currently focused launcher session:
 *
 *   $(sparkle) <model>  $(clock) 5h NN%  $(calendar) wk NN%
 *
 * with a tooltip that breaks out the 5-hour and weekly (7-day) windows plus
 * the per-model weekly windows (Opus / Sonnet) and their reset date+time in
 * local time. This is the launcher-side equivalent of the model + usage line
 * Gajae Code prints in its TUI footer.
 *
 * Data sources:
 *   - usage  → {@link refreshUsage} (Anthropic OAuth usage endpoint, account-wide)
 *   - model  → pushed in by the panel layer via {@link setActiveSessionModel}
 *              whenever the active tab / its session model changes.
 *
 * The item hides itself when no Claude OAuth credentials exist (same rule as
 * the account status bar) so non-Claude-logged-in users see nothing.
 */
import * as vscode from "vscode";
import {
  refreshUsage,
  getCachedUsage,
  hasClaudeCredentials,
  formatModelLabel,
  type ClaudeUsage,
  type UsageBucket,
} from "./usage";

let bar: vscode.StatusBarItem | null = null;
let activeModel: string | null = null;
let timer: NodeJS.Timeout | null = null;

const REFRESH_INTERVAL_MS = 60_000;

/** Create the item, kick off the first fetch, and start the refresh timer. */
export function createUsageStatusBar(ctx: vscode.ExtensionContext): vscode.StatusBarItem {
  if (bar) return bar;
  // Right side, priority 101 — just left of the OMC HUD (right/99) so the two
  // never overlap, and right of most third-party right items.
  bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  bar.command = "claudeCodeLauncher.refreshUsage";
  ctx.subscriptions.push(bar);
  ctx.subscriptions.push({ dispose: disposeUsageStatusBar });
  render();
  // First fetch + periodic refresh. Errors are swallowed inside refreshUsage.
  void refreshUsageStatusBar(true);
  timer = setInterval(() => void refreshUsageStatusBar(false), REFRESH_INTERVAL_MS);
  return bar;
}

export function disposeUsageStatusBar(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Push the model name of the currently focused session (or null when no
 *  launcher tab is focused). Re-renders immediately from cached usage. */
export function setActiveSessionModel(model: string | null): void {
  const next = model && model.trim() ? model.trim() : null;
  if (next === activeModel) return;
  activeModel = next;
  render();
}

/** Re-fetch usage (TTL-gated unless `force`) then re-render. */
export async function refreshUsageStatusBar(force = false): Promise<void> {
  if (!bar) return;
  if (!hasClaudeCredentials()) {
    render();
    return;
  }
  await refreshUsage(force);
  render();
}

function render(): void {
  if (!bar) return;
  if (!hasClaudeCredentials()) {
    bar.hide();
    return;
  }
  const usage = getCachedUsage();
  const parts: string[] = [];

  const modelLabel = activeModel ? formatModelLabel(activeModel) : null;
  if (modelLabel) parts.push(`$(sparkle) ${modelLabel}`);

  if (usage?.fiveHour) {
    parts.push(`$(clock) 5h ${pct(usage.fiveHour.utilization)}${resetTag(usage.fiveHour, "time")}`);
  }
  // Weekly: when the plan exposes per-model windows (Opus / Sonnet) show each
  // one ("which model at what %"); otherwise show the single account weekly.
  for (const w of collectWeeklies(usage)) {
    parts.push(`$(calendar) ${w.label} ${pct(w.bucket.utilization)}${resetTag(w.bucket, "date")}`);
  }

  if (parts.length === 0) {
    // Credentials exist but no usage yet (first fetch in flight / failed) and
    // no focused model — show a neutral placeholder so the item stays present.
    bar.text = "$(graph) Usage";
  } else {
    bar.text = parts.join("  ");
  }
  bar.tooltip = buildTooltip(usage, modelLabel);
  bar.color = usageColor(usage);
  bar.show();
}

function pct(v: number): string {
  return `${Math.round(v)}%`;
}

/** Compact "resets at" suffix for the bar text. `time` → clock only (5-hour
 *  window); `date` → weekday + clock (weekly window). Empty when unknown. */
function resetTag(bucket: UsageBucket, kind: "time" | "date"): string {
  if (!bucket.resetsAt) return "";
  const d = new Date(bucket.resetsAt);
  const clock = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (kind === "time") return ` \u21BA${clock}`;
  const dow = d.toLocaleDateString([], { weekday: "short" });
  return ` \u21BA${dow} ${clock}`;
}

/** Weekly windows to display: the per-model windows (Opus / Sonnet) when the
 *  plan exposes them, else the single aggregate account weekly. */
function collectWeeklies(
  usage: ClaudeUsage | null,
): Array<{ label: string; bucket: UsageBucket }> {
  if (!usage) return [];
  const perModel: Array<{ label: string; bucket: UsageBucket }> = [];
  if (usage.sevenDayOpus) perModel.push({ label: "wk·Opus", bucket: usage.sevenDayOpus });
  if (usage.sevenDaySonnet) perModel.push({ label: "wk·Sonnet", bucket: usage.sevenDaySonnet });
  if (perModel.length > 0) return perModel;
  if (usage.sevenDay) return [{ label: "wk", bucket: usage.sevenDay }];
  return [];
}

function usageColor(usage: ClaudeUsage | null): vscode.ThemeColor | undefined {
  if (!usage) return undefined;
  const max = Math.max(
    usage.fiveHour?.utilization ?? 0,
    usage.sevenDay?.utilization ?? 0,
    usage.sevenDayOpus?.utilization ?? 0,
    usage.sevenDaySonnet?.utilization ?? 0,
  );
  if (max >= 90) return new vscode.ThemeColor("statusBarItem.errorBackground");
  if (max >= 75) return new vscode.ThemeColor("statusBarItem.warningBackground");
  return undefined;
}

function buildTooltip(usage: ClaudeUsage | null, modelLabel: string | null): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown("**Claude usage** (active account)\n\n");
  if (modelLabel) {
    md.appendMarkdown(`$(sparkle) Current session model: **${modelLabel}**\n\n`);
  }
  if (!usage) {
    md.appendMarkdown("_Fetching usage…_\n\n");
  } else {
    md.appendMarkdown(tooltipRow("$(clock)", "5-hour", usage.fiveHour, "time"));
    md.appendMarkdown(tooltipRow("$(calendar)", "Weekly (7d)", usage.sevenDay, "date"));
    md.appendMarkdown(tooltipRow("$(star)", "Weekly · Opus", usage.sevenDayOpus, "date"));
    md.appendMarkdown(tooltipRow("$(star)", "Weekly · Sonnet", usage.sevenDaySonnet, "date"));
    if (usage.fetchedAt) {
      md.appendMarkdown(`\n_Updated ${new Date(usage.fetchedAt).toLocaleTimeString()}_\n`);
    }
  }
  md.appendMarkdown("\nClick to refresh.");
  return md;
}

function tooltipRow(
  icon: string,
  label: string,
  bucket: UsageBucket | null,
  kind: "time" | "date",
): string {
  if (!bucket) return "";
  let line = `- ${icon} ${label}: **${pct(bucket.utilization)}**`;
  if (bucket.resetsAt) {
    const when = kind === "date" ? formatResetDateTime(bucket.resetsAt) : formatResetTime(bucket.resetsAt);
    line += ` — resets ${when} (${formatRelative(bucket.resetsAt - Date.now())})`;
  }
  return line + "\n";
}

function formatResetTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatResetDateTime(ms: number): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${date}, ${time}`;
}

function formatRelative(deltaMs: number): string {
  if (deltaMs <= 0) return "now";
  const mins = Math.round(deltaMs / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins ? `in ${hours}h ${remMins}m` : `in ${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `in ${days}d ${remHours}h` : `in ${days}d`;
}