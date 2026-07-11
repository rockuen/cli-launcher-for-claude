// @module handlers/gjcModel — model + OAuth-subscription selection for the gjc agent.
//
// gjc (Gajae Code) is multi-model: one binary routes to whichever OAuth
// subscription / provider is logged in (Claude Pro/Max, ChatGPT/Codex, Google
// Antigravity, xAI Grok, …). The model is chosen with a FUZZY `--model` string
// ("opus", "gpt-5.2-codex", "gemini-3-pro", "grok-code-fast-1", or a full
// "provider/model"), which the launcher persists to `claudeCodeLauncher.gjc.model`
// and passes when spawning a FRESH gjc session (resume restores the session's
// own model). This picker is the hub: pick a curated subscription model, type a
// custom one, clear back to gjc's default, see the live model list, or log in /
// import subscriptions.
//
// Login model (verified against gjc 0.6.3):
//   - `gjc setup credentials` auto-imports existing Claude Code + Codex CLI
//     credentials (covers Claude + Codex subscriptions).
//   - Other subscriptions (Antigravity, Grok, …) log in via `/login` INSIDE a
//     running gjc session (interactive OAuth) — gjc's own subscription picker.

const vscode = require('vscode');
const { resolveGjcCli } = require('../pty/resolveCli');
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

// Model picker hub. Curated subscription models + Custom / Clear / Show-all /
// Login actions. Saves the selection to claudeCodeLauncher.gjc.model.
async function pickGjcModel() {
  const cfg = vscode.workspace.getConfiguration('claudeCodeLauncher');
  const current = (cfg.get('gjc.model', '') || '').trim();

  const items = [];
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
  items.push({ label: '$(list-unordered) Show all available models…', description: t('gjcListDesc'), _action: 'list' });
  items.push({ label: '$(key) Log in / import subscriptions…', description: t('gjcSetupDesc'), _action: 'setup' });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: current ? t('gjcPickCurrent').replace('{0}', current) : t('gjcPickDefault'),
    matchOnDescription: true,
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
  if (picked._action === 'list') { _runGjcInTerminal('gjc --list-models', ['--list-models']); return; }
  if (picked._action === 'setup') { setupGjcCredentials(); return; }
  if (picked._model) { await _saveGjcModel(picked._model); return; }
}

module.exports = { pickGjcModel, setupGjcCredentials, GJC_MODEL_CATALOG };
