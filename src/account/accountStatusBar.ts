/**
 * Account status bar item — left-aligned indicator showing the active
 * Claude account. Clicking it runs `claudeCodeLauncher.switchAccount`
 * so the user can pick another saved profile or save the current one.
 *
 * Visibility rules:
 *   - Hidden entirely when no Claude credentials exist (Claude CLI
 *     hasn't been logged in yet). A stub label would only confuse —
 *     the user needs to run `claude /login` in a terminal first.
 *   - Otherwise visible with `$(account) <label>`. Label priority is
 *     organizationName → full email — short and identifying. The
 *     tooltip carries email + org + plan + saved-profile name so the
 *     truncated label never hides important context.
 *
 * Refresh trigger: `switcher.ts:refreshActiveProfile()` calls
 * `refreshAccountStatusBar()` after every save/switch/update/remove.
 * No file watcher — Claude CLI's background token rotation doesn't
 * change identity, only credential bytes, so the status bar stays
 * accurate without watching `.credentials.json`.
 */
import * as vscode from "vscode";
import { parseAccountData } from "./parser";

let bar: vscode.StatusBarItem | null = null;

/**
 * Create the status bar item and push it onto the extension's
 * subscription list for automatic disposal. Idempotent — calling
 * twice keeps the same item (defensive against re-activate cycles).
 */
export function createAccountStatusBar(
  ctx: vscode.ExtensionContext,
): vscode.StatusBarItem {
  if (bar) return bar;
  // Priority 100 places us comfortably on the left half. Higher
  // numbers float further left within the alignment group; 100 sits
  // ahead of most third-party left items without monopolizing the
  // far-left slot reserved for things like git branch.
  bar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  bar.command = "claudeCodeLauncher.switchAccount";
  ctx.subscriptions.push(bar);
  refreshAccountStatusBar();
  return bar;
}

/**
 * Re-read the live account state and update the status bar text +
 * tooltip + visibility. Safe to call often — `parseAccountData()`
 * reads two small JSON files plus the saved-profile metadata.
 */
export function refreshAccountStatusBar(): void {
  if (!bar) return;
  let data;
  try {
    data = parseAccountData();
  } catch {
    // parseAccountData is defensive but never let a parse failure
    // crash the status bar — hide and bail.
    bar.hide();
    return;
  }
  const p = data.profile;

  // No Claude account logged in → completely hide. A stub label
  // would just confuse users who haven't run `claude /login` yet.
  if (!p.email && !p.organizationName) {
    bar.hide();
    return;
  }

  // Label: show the full email directly (user preference — surface the
  // account email so it's obvious which account is active). Fall back to
  // organizationName, then a stub. We do NOT use the email local-part —
  // same-domain multi-account users would see indistinguishable labels.
  const label = p.email || p.organizationName || "Claude";

  const activeProfile = data.savedProfiles.find(
    (sp) => sp.slug === data.activeProfileSlug,
  );

  bar.text = `$(account) ${label}`;

  // Tooltip carries everything the label hides. MarkdownString gives
  // us the codicon parsing + multi-line layout that plain strings
  // can't.
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown("**Claude account**\n\n");
  if (p.email) md.appendMarkdown(`Email: \`${p.email}\`  \n`);
  if (p.organizationName) {
    md.appendMarkdown(`Org: ${p.organizationName}  \n`);
  }
  if (p.subscriptionType) {
    md.appendMarkdown(`Plan: ${p.subscriptionType}  \n`);
  }
  if (activeProfile) {
    md.appendMarkdown(`Profile: **${activeProfile.label}** (saved)  \n`);
  } else {
    md.appendMarkdown("_Not saved as a profile yet._  \n");
  }
  md.appendMarkdown("\nClick to switch / save accounts.");
  bar.tooltip = md;

  bar.show();
}
