// @module handlers/gjcModel — model, profile + OAuth-subscription selection for
// the gjc agent.
//
// gjc (Gajae Code) is multi-model: one binary routes to whichever OAuth
// subscription / provider is logged in (Claude Pro/Max, ChatGPT/Codex, Google
// Antigravity, xAI Grok, …). Two levers reach it, and the launcher persists
// both for FRESH sessions (a resume restores the session's own choice):
//   - a model PROFILE (`gjc --mpreset <id>`, `claudeCodeLauncher.gjc.profile`)
//     binds every role at once — default/executor/architect/planner/critic.
//   - a single fuzzy MODEL (`gjc --model <string>`, `claudeCodeLauncher.gjc.model`)
//     — "opus", "gpt-5.2-codex", "gemini-3-pro", or a full "provider/model".
// This picker is the hub for both: pick a profile from gjc's signed registry
// (with what it binds and whether its providers are logged in), pick or type a
// single model, clear either back to gjc's default, see the live model list, or
// log in / import subscriptions.
//
// Why the profile is worth surfacing: a profile is what a launcher session
// actually starts on, and picking one blind is how a session dies before it
// begins. A project-scoped home stuck on "Codex Pro" resolves to
// `openai-codex/gpt-5.6-sol`, which a ChatGPT Plus account cannot serve, and
// gjc raises that from its model registry before the session exists — the pane
// stops at "warming workspace" (fixed in 3.22.1, which keeps the project home's
// config in step with the real one).
//
// Login model (verified against gjc 0.6.3):
//   - `gjc setup credentials` auto-imports existing Claude Code + Codex CLI
//     credentials (covers Claude + Codex subscriptions).
//   - Other subscriptions (Antigravity, Grok, …) log in via `/login` INSIDE a
//     running gjc session (interactive OAuth) — gjc's own subscription picker.

const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const vscode = require('vscode');
const { resolveGjcCli } = require('../pty/resolveCli');
const { gjcAgentDir } = require('../lib/projectSessions');
const { readProfiles, providerStatusFromAccounts, describeProfileProviders } = require('../lib/gjcProfiles');
const { t } = require('../i18n');

// Curated fuzzy models grouped by the common OAuth subscriptions. Fuzzy strings
// (not pinned full ids) keep the list robust against version drift — gjc
// resolves each to the best match among the logged-in provider's models. The
// "Custom…" action covers anything not listed (e.g. GLM / MiniMax coding plans).
const GJC_MODEL_CATALOG = [
  { group: 'Claude (Anthropic Pro/Max)', model: 'opus',             label: 'Claude Opus' },
  { group: 'Claude (Anthropic Pro/Max)', model: 'sonnet',           label: 'Claude Sonnet' },
  { group: 'Claude (Anthropic Pro/Max)', model: 'haiku',            label: 'Claude Haiku' },
  { group: 'Codex (ChatGPT Plus/Pro)',   model: 'gpt-5.2-codex',    label: 'GPT-5.2 Codex' },
  { group: 'Codex (ChatGPT Plus/Pro)',   model: 'gpt-5.2',          label: 'GPT-5.2' },
  { group: 'Codex (ChatGPT Plus/Pro)',   model: 'gpt-5-codex',      label: 'GPT-5 Codex' },
  { group: 'Antigravity (Google)',       model: 'gemini-3-pro',     label: 'Gemini 3 Pro' },
  { group: 'Antigravity (Google)',       model: 'gemini-3-flash',   label: 'Gemini 3 Flash' },
  { group: 'Antigravity (Google)',       model: 'gemini-3.1-pro',   label: 'Gemini 3.1 Pro' },
  { group: 'Grok (xAI)',                 model: 'grok-4',           label: 'Grok 4' },
  { group: 'Grok (xAI)',                 model: 'grok-code-fast-1', label: 'Grok Code Fast' },
];

// Build a terminal command that runs the resolved gjc binary with the given
// args, quoting the absolute path. Windows VS Code defaults to PowerShell (needs
// the `&` call operator for a quoted path); POSIX shells run the quoted path
// directly.
function _gjcTerminalCommand(gjcPath, args) {
  const quotedArgs = args.map((a) => `"${a}"`).join(' ');
  return process.platform === 'win32'
    ? `& "${gjcPath}" ${quotedArgs}`
    : `"${gjcPath}" ${quotedArgs}`;
}

function _runGjcInTerminal(name, args) {
  const resolved = resolveGjcCli();
  if (!resolved) {
    vscode.window.showErrorMessage('Gajae Code CLI (gjc) not found. Install with: bun add -g gajae-code (requires Bun ≥ 1.3.14).');
    return false;
  }
  const term = vscode.window.createTerminal({ name });
  term.sendText(_gjcTerminalCommand(resolved.shell, args));
  term.show();
  return true;
}

// Open a terminal that imports existing Claude/Codex credentials, then point the
// user at `/login` for the OAuth-only subscriptions (Antigravity / Grok / …).
function setupGjcCredentials() {
  if (!_runGjcInTerminal('gjc setup credentials', ['setup', 'credentials'])) return;
  vscode.window.showInformationMessage(
    t('gjcSetupCredentials')
  );
}

// The agent dir a launcher-spawned gjc would use for this window, so the picker
// reads the same registry + accounts the session will. Project-scoped storage
// gives each workspace its own gjc home, and its account state genuinely
// differs from the user-global one.
function _gjcAgentDirForWindow() {
  let cwd = process.cwd();
  try {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length) cwd = folders[0].uri.fsPath;
  } catch (_) {}
  return gjcAgentDir(cwd);
}

// `gjc accounts list --json` for the given agent dir. Best-effort: an old gjc,
// a missing binary or a slow probe degrades to "no account state known", which
// only costs the picker its provider annotations.
function _readAccounts(agentDir) {
  return new Promise((resolve) => {
    const resolved = resolveGjcCli();
    if (!resolved || !resolved.shell) { resolve(null); return; }
    execFile(
      resolved.shell,
      [...(resolved.args || []), 'accounts', 'list', '--json'],
      {
        timeout: 10000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GJC_CODING_AGENT_DIR: agentDir },
      },
      (err, stdout) => resolve(err ? null : (stdout || '').toString()),
    );
  });
}

// Persist the chosen fuzzy model to gjc.model (Global) and confirm. Empty string
// clears it (gjc falls back to its own default/last model).
async function _saveGjcModel(model) {
  const value = (model || '').trim();
  await vscode.workspace
    .getConfiguration('claudeCodeLauncher')
    .update('gjc.model', value, vscode.ConfigurationTarget.Global);
  if (value) {
    vscode.window.showInformationMessage(
      t('gjcModelSet').replace('{0}', value)
    );
  } else {
    vscode.window.showInformationMessage(t('gjcModelCleared'));
  }
}

// Persist the chosen profile id to gjc.profile (Global). Empty string clears it
// (gjc then uses its own configured modelProfile.default).
async function _saveGjcProfile(profileId) {
  const value = (profileId || '').trim();
  await vscode.workspace
    .getConfiguration('claudeCodeLauncher')
    .update('gjc.profile', value, vscode.ConfigurationTarget.Global);
  if (value) {
    vscode.window.showInformationMessage(
      t('gjcProfileSet').replace('{0}', value)
    );
  } else {
    vscode.window.showInformationMessage(t('gjcProfileCleared'));
  }
}

// One profile's detail line: what it binds for the default role, then each
// required provider with the only account state that can be asserted from a
// row — usable, present-but-disabled, or never logged in.
function _profileDetail(profile, report) {
  const parts = [];
  if (profile.defaultBinding) parts.push(t('gjcProfileDefaultRole').replace('{0}', profile.defaultBinding));
  if (report.providers.length) {
    const marks = report.providers
      .map((p) => `${p.id} ${p.status === 'available' ? '✓' : p.status === 'disabled' ? '⊘' : '✗'}`)
      .join(', ');
    parts.push(marks);
  }
  if (report.noCredentials) {
    parts.push(t('gjcProfileNoCredentials'));
  }
  return parts.join(' · ');
}

// Profiles worth showing first: the ones whose providers this machine has an
// account row for (whatever its state), plus provider-agnostic ones. gjc's
// registry carries 60+ profiles across every provider it supports, and a list
// of subscriptions the user does not have buries the ones they do.
function _relevantProfiles(profiles, statusMap) {
  // No account state at all (an old gjc, a failed probe) is not evidence that
  // the user has no subscriptions — filtering on it would leave only the
  // provider-agnostic handful.
  if (!statusMap || !statusMap.size) return profiles;
  const relevant = profiles.filter((profile) => {
    if (!profile.providerGroups.length) return true;
    return profile.providerGroups.some((group) => group.some((p) => statusMap.has(p)));
  });
  return relevant.length ? relevant : profiles;
}

function _profileItems(profiles, statusMap, currentProfile) {
  const items = [];
  let lastGroup = null;
  for (const profile of profiles) {
    if (profile.group !== lastGroup) {
      items.push({ label: profile.group, kind: vscode.QuickPickItemKind.Separator });
      lastGroup = profile.group;
    }
    const report = describeProfileProviders(profile, statusMap);
    items.push({
      label: (profile.id === currentProfile ? '$(check) ' : '') + profile.displayName,
      description: profile.id,
      detail: _profileDetail(profile, report),
      _profile: profile.id,
    });
  }
  return items;
}

// Model picker hub. gjc's model profiles + curated single models + Custom /
// Clear / Show-all / Login actions. Saves to gjc.profile / gjc.model.
async function pickGjcModel(opts = {}) {
  const cfg = vscode.workspace.getConfiguration('claudeCodeLauncher');
  const current = (cfg.get('gjc.model', '') || '').trim();
  const currentProfile = (cfg.get('gjc.profile', '') || '').trim();

  const agentDir = _gjcAgentDirForWindow();
  const profiles = readProfiles(agentDir, path.join(os.homedir(), '.gjc', 'agent'));
  const statusMap = providerStatusFromAccounts(await _readAccounts(agentDir));
  const shownProfiles = opts.allProfiles ? profiles : _relevantProfiles(profiles, statusMap);

  const items = [];
  if (shownProfiles.length) {
    items.push({ label: t('gjcProfileSection'), kind: vscode.QuickPickItemKind.Separator });
    items.push(..._profileItems(shownProfiles, statusMap, currentProfile));
  }

  items.push({ label: t('gjcModelSection'), kind: vscode.QuickPickItemKind.Separator });
  let lastGroup = null;
  for (const entry of GJC_MODEL_CATALOG) {
    if (entry.group !== lastGroup) {
      items.push({ label: entry.group, kind: vscode.QuickPickItemKind.Separator });
      lastGroup = entry.group;
    }
    items.push({
      label: (entry.model === current ? '$(check) ' : '') + entry.label,
      description: entry.model,
      detail: entry.model === current ? t('gjcModelCurrentSelected') : undefined,
      _model: entry.model,
    });
  }
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: '$(edit) Custom model…', description: t('gjcCustomDesc'), _action: 'custom' });
  items.push({ label: '$(clear-all) Clear (use gjc default)', description: current ? t('gjcClearCurrent').replace('{0}', current) : t('gjcClearAlready'), _action: 'clear' });
  if (currentProfile) {
    items.push({ label: '$(clear-all) Clear profile (use gjc default)', description: t('gjcClearCurrent').replace('{0}', currentProfile), _action: 'clearProfile' });
  }
  if (profiles.length && !opts.allProfiles && shownProfiles.length < profiles.length) {
    items.push({ label: '$(list-selection) Show all profiles…', description: t('gjcAllProfilesDesc').replace('{0}', String(profiles.length)), _action: 'allProfiles' });
  }
  items.push({ label: '$(list-unordered) Show all available models…', description: t('gjcListDesc'), _action: 'list' });
  items.push({ label: '$(key) Log in / import subscriptions…', description: t('gjcSetupDesc'), _action: 'setup' });

  const placeHolder = currentProfile
    ? t('gjcPickCurrentProfile').replace('{0}', currentProfile).replace('{1}', current || '—')
    : (current ? t('gjcPickCurrent').replace('{0}', current) : t('gjcPickDefault'));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;

  if (picked._action === 'custom') {
    const value = await vscode.window.showInputBox({
      prompt: t('gjcCustomPrompt'),
      value: current,
      placeHolder: 'opus',
    });
    if (value === undefined) return; // Esc
    await _saveGjcModel(value);
    return;
  }
  if (picked._action === 'clear') { await _saveGjcModel(''); return; }
  if (picked._action === 'clearProfile') { await _saveGjcProfile(''); return; }
  if (picked._action === 'allProfiles') { await pickGjcModel({ allProfiles: true }); return; }
  if (picked._action === 'list') { _runGjcInTerminal('gjc --list-models', ['--list-models']); return; }
  if (picked._action === 'setup') { setupGjcCredentials(); return; }
  if (picked._profile) { await _saveGjcProfile(picked._profile); return; }
  if (picked._model) { await _saveGjcModel(picked._model); return; }
}

module.exports = { pickGjcModel, setupGjcCredentials, GJC_MODEL_CATALOG, _profileDetail, _relevantProfiles, _profileItems };
