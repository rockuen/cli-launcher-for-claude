/**
 * Account switcher UI — native QuickPick + Save Account input modal.
 *
 * Lifted from `rockuen/claude-account-switcher` v0.1.1
 * (`src/features/account/viewProvider.ts:openAccountSwitcher` and
 * `promptSaveCurrentAccount`). The sidebar webview view-provider shell
 * is dropped here; cli-launcher exposes the two flows only through the
 * Command Palette + a button in its existing settings modal, so no
 * `WebviewViewProvider` plumbing is needed.
 *
 * Change vs upstream: `this.globalState` (Memento on the class) is
 * replaced by `ctx: vscode.ExtensionContext` passed into each entry
 * point, and `pushAccountUpdate()` collapses to `syncActiveProfile()`
 * since there is no webview to repaint.
 */
import * as vscode from "vscode";
import {
  saveProfile as saveProfileSnapshot,
  switchProfile as switchProfileSnapshot,
  updateProfile as updateProfileSnapshot,
  removeProfile as removeProfileSnapshot,
  syncActiveProfile,
  type SavedProfile,
} from "./profiles";
import { parseAccountData } from "./parser";

/**
 * Build the modal body shown before a profile switch. The base
 * message always warns about running Claude terminals; when the
 * snapshot's access token is already past its `expiresAt`, we prepend
 * a stale-token notice so the user knows a `/login` may be required
 * after the swap (refresh tokens rotate on use, so a long-stale
 * snapshot may have no valid refresh path left).
 */
function buildSwitchConfirmDetail(profile: SavedProfile | undefined): string {
  const base =
    "Your home-dir credentials will be overwritten with this saved profile. Close any running Claude terminals first — in-flight sessions may fail mid-task.";
  if (!profile || !profile.tokenExpiresAt) return base;
  const ageMs = Date.now() - profile.tokenExpiresAt;
  if (ageMs <= 0) return base;
  const days = Math.floor(ageMs / 86_400_000);
  const when =
    days >= 2 ? `${days} days ago` : days === 1 ? "yesterday" : "recently";
  return `⚠ The saved access token expired ${when}. Claude CLI will try to refresh in the background; if the refresh token has also rotated since you saved this profile, you'll need to /login after switching.\n\n${base}`;
}

/** Best-effort housekeeping after any mutation. Never throws. */
function refreshActiveProfile(): void {
  try {
    syncActiveProfile();
  } catch {
    /* best-effort housekeeping; never block UI */
  }
}

/**
 * One-time security disclaimer modal. Saving copies the OAuth token
 * into `~/.claude/account-switcher/`. We surface that exactly once via
 * globalState so users give informed consent on first save, then never
 * see it again. Refusing the prompt aborts the save entirely.
 */
const DISCLAIMER_KEY = "claudeAccountSwitcher.disclaimerAck";

async function ensureDisclaimerAcked(
  ctx: vscode.ExtensionContext,
): Promise<boolean> {
  const seen = ctx.globalState.get<boolean>(DISCLAIMER_KEY) ?? false;
  if (seen) return true;
  const choice = await vscode.window.showWarningMessage(
    "Save Claude account as a profile?",
    {
      modal: true,
      detail:
        "CLI Launcher for Claude will copy your OAuth tokens from ~/.claude.json and ~/.claude/.credentials.json into ~/.claude/account-switcher/ so you can switch back to this account later. Tokens are stored in plain text — same format Claude CLI uses. Treat that folder as sensitive. This notice is shown once.",
    },
    "Understood, save",
  );
  if (choice !== "Understood, save") return false;
  await ctx.globalState.update(DISCLAIMER_KEY, true);
  return true;
}

/**
 * Show the "Save current account" input box. Invoked by the
 * Command Palette command `claudeCodeLauncher.saveAccount`.
 */
export async function promptSaveCurrentAccount(
  ctx: vscode.ExtensionContext,
): Promise<void> {
  const current = parseAccountData();
  const p = current.profile;

  if (!(await ensureDisclaimerAcked(ctx))) return;

  const defaultLabel =
    p.organizationName || (p.email ? p.email.split("@")[0] : "Profile");
  const label = await vscode.window.showInputBox({
    title: "Save account as profile",
    prompt: "Label for this Claude account snapshot",
    value: defaultLabel,
    validateInput: (v: string) =>
      v.trim().length > 0 ? null : "Label cannot be empty",
  });
  if (label === undefined) return;

  const result = saveProfileSnapshot(label);
  if (!result.ok) {
    if (result.error === "already-saved" && result.detail) {
      // Dedupe path — a profile for this identity already exists.
      // Offer to refresh the existing snapshot rather than create a
      // duplicate.
      const existingSlug = result.detail;
      const existing = current.savedProfiles.find(
        (pp) => pp.slug === existingSlug,
      );
      const existingLabel = existing?.label ?? existingSlug;
      const choice = await vscode.window.showInformationMessage(
        `A profile already exists for this account (${existingLabel}).`,
        {
          modal: true,
          detail:
            "Refresh its saved tokens with the current login so it picks up Claude CLI's latest rotated token.",
        },
        "Update existing",
      );
      if (choice === "Update existing") {
        const upd = updateProfileSnapshot(existingSlug);
        if (!upd.ok) {
          vscode.window.showErrorMessage(
            `Couldn't update profile: ${upd.detail ?? upd.error}.`,
          );
        } else {
          vscode.window.showInformationMessage(
            `Profile "${upd.data.label}" refreshed.`,
          );
        }
      }
    } else {
      vscode.window.showErrorMessage(
        `Couldn't save profile: ${result.detail ?? result.error}.`,
      );
    }
  } else {
    vscode.window.showInformationMessage(
      `Profile "${result.data.label}" saved.`,
    );
  }
  refreshActiveProfile();
}

/**
 * Native QuickPick-based account switcher. Invoked by the Command
 * Palette command `claudeCodeLauncher.switchAccount` and the
 * "Switch Account…" button in the settings modal.
 */
export async function openAccountSwitcher(
  ctx: vscode.ExtensionContext,
): Promise<void> {
  const current = parseAccountData();
  // Overlay the active profile's displayed email with the live
  // profile email when it diverges — users who changed their email
  // on claude.ai after saving would otherwise see the snapshot's
  // stale value in the switcher. The overlay only affects display;
  // the stored snapshot stays untouched so Update Profile can
  // re-capture when the user wants.
  const savedProfiles = current.savedProfiles.map((p) => {
    if (
      p.slug === current.activeProfileSlug &&
      current.profile.email &&
      current.profile.email !== p.email
    ) {
      return { ...p, email: current.profile.email };
    }
    return p;
  });
  const activeSlug = current.activeProfileSlug;

  const UPDATE_BUTTON: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("sync"),
    tooltip: "Update snapshot with current credentials",
  };
  const REMOVE_BUTTON: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("trash"),
    tooltip: "Delete saved profile",
  };

  type Item = vscode.QuickPickItem & {
    action: "switch" | "save";
    slug?: string;
  };

  // Active profile first — users see "where am I" without scanning.
  const sortedProfiles = [...savedProfiles].sort((a, b) => {
    if (a.slug === activeSlug) return -1;
    if (b.slug === activeSlug) return 1;
    return 0;
  });

  // ThemeIcon via iconPath aligns consistently across every row
  // regardless of label length — cleaner than `$(…)` prefixes.
  const CHECK_ICON = new vscode.ThemeIcon("check");
  const ACCOUNT_ICON = new vscode.ThemeIcon("account");
  const SAVE_ICON = new vscode.ThemeIcon("save");

  // Pre-scan: identify duplicate profiles so we can mark any row
  // that isn't the freshest saved slot for its identity. Grouping
  // key prefers `accountUuid` (account-distinct); legacy snapshots
  // without it fall back to userID + email — userID alone is
  // device-stable, NOT account-distinct, so the email cross-check
  // is required to avoid collapsing distinct accounts on the same
  // machine.
  const identityGroups = new Map<string, SavedProfile[]>();
  for (const p of savedProfiles) {
    let key: string;
    if (p.accountUuid) {
      key = `uuid:${p.accountUuid}`;
    } else if (p.userID && p.email) {
      key = `${p.userID}|${p.email.toLowerCase()}`;
    } else {
      continue;
    }
    const bucket = identityGroups.get(key) ?? [];
    bucket.push(p);
    identityGroups.set(key, bucket);
  }
  const duplicateSlugs = new Set<string>();
  for (const group of identityGroups.values()) {
    if (group.length <= 1) continue;
    const ranked = [...group].sort((a, b) => {
      const at = Date.parse(a.savedAt || "") || 0;
      const bt = Date.parse(b.savedAt || "") || 0;
      return bt - at;
    });
    for (let i = 1; i < ranked.length; i++) duplicateSlugs.add(ranked[i].slug);
  }

  const items: Item[] = [];
  for (const p of sortedProfiles) {
    const isActive = p.slug === activeSlug;
    const isDuplicate = duplicateSlugs.has(p.slug);
    const metaParts: string[] = [];
    if (p.email) metaParts.push(p.email);
    if (p.subscriptionType) metaParts.push(p.subscriptionType);
    if (p.organizationName) metaParts.push(p.organizationName);
    if (isDuplicate) metaParts.push("duplicate — remove if unused");
    items.push({
      action: "switch",
      slug: p.slug,
      iconPath: isActive ? CHECK_ICON : ACCOUNT_ICON,
      label: p.label || p.email || p.slug,
      description: isActive ? "Active" : isDuplicate ? "Duplicate" : "",
      // Every row keeps a `detail` so native row heights match —
      // prevents the mixed 1-line/2-line hover-overlap glitch.
      detail: metaParts.join(" · ") || "Saved profile",
      buttons: isActive ? [UPDATE_BUTTON, REMOVE_BUTTON] : [REMOVE_BUTTON],
    });
  }

  if (sortedProfiles.length > 0) {
    items.push({
      action: "save",
      label: "",
      kind: vscode.QuickPickItemKind.Separator,
    } as Item);
  }

  items.push({
    action: "save",
    iconPath: SAVE_ICON,
    label: "Save current account as profile",
    detail: "Snapshot current credentials so you can switch back later",
  });

  const picker = vscode.window.createQuickPick<Item>();
  picker.title = "Switch Claude account";
  picker.placeholder = savedProfiles.length
    ? "Pick an account to switch to, or save the current one"
    : "No saved profiles yet — save the current account to get started";
  picker.items = items;
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;

  picker.onDidTriggerItemButton(async (e) => {
    const slug = (e.item as Item).slug;
    if (!slug) return;
    if (e.button === UPDATE_BUTTON) {
      picker.hide();
      const result = updateProfileSnapshot(slug);
      if (!result.ok) {
        vscode.window.showErrorMessage(
          `Couldn't update profile: ${result.detail ?? result.error}.`,
        );
      } else {
        vscode.window.showInformationMessage(
          `Profile "${result.data.label}" updated.`,
        );
      }
      refreshActiveProfile();
    } else if (e.button === REMOVE_BUTTON) {
      picker.hide();
      const confirm = await vscode.window.showWarningMessage(
        "Delete saved profile?",
        {
          modal: true,
          detail:
            "The snapshot (including its OAuth token copy) will be permanently removed from ~/.claude/account-switcher. The live Claude account isn't affected.",
        },
        "Delete",
      );
      if (confirm === "Delete") {
        removeProfileSnapshot(slug);
        refreshActiveProfile();
      }
    }
  });

  picker.onDidAccept(async () => {
    const pick = picker.selectedItems[0];
    picker.hide();
    picker.dispose();
    if (!pick) return;
    if (pick.action === "switch" && pick.slug) {
      if (pick.slug === activeSlug) return;
      const targetProfile = savedProfiles.find((p) => p.slug === pick.slug);
      const confirm = await vscode.window.showWarningMessage(
        "Switch Claude account?",
        {
          modal: true,
          detail: buildSwitchConfirmDetail(targetProfile),
        },
        "Switch",
      );
      if (confirm !== "Switch") return;
      const result = switchProfileSnapshot(pick.slug);
      if (!result.ok) {
        vscode.window.showErrorMessage(
          `Switch failed: ${result.detail ?? result.error}.`,
        );
      } else {
        vscode.window.showInformationMessage(
          `Switched to ${result.data.email || result.data.label}.`,
        );
      }
      refreshActiveProfile();
    } else if (pick.action === "save") {
      await promptSaveCurrentAccount(ctx);
    }
  });

  picker.onDidHide(() => picker.dispose());
  picker.show();
}
