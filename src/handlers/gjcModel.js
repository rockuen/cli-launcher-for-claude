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
    'gjc: Claude·Codex 구독 로그인을 자동 임포트합니다. Antigravity·Grok 등 다른 구독은 gjc 세션 안에서 /login 으로 추가하세요.'
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
      `gjc 기본 모델: ${value} — 새 gjc 세션에 적용됩니다(실행 중 세션은 재시작 시 적용).`
    );
  } else {
    vscode.window.showInformationMessage('gjc 기본 모델을 초기화했습니다 (gjc 기본값 사용).');
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
      detail: entry.model === current ? '현재 선택됨' : undefined,
      _model: entry.model,
    });
  }
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: '$(edit) Custom model…', description: '직접 입력 (예: provider/model, glm-4.6 …)', _action: 'custom' });
  items.push({ label: '$(clear-all) Clear (use gjc default)', description: current ? `현재: ${current}` : '이미 기본값', _action: 'clear' });
  items.push({ label: '$(list-unordered) Show all available models…', description: 'gjc --list-models (로그인된 구독 기준)', _action: 'list' });
  items.push({ label: '$(key) Log in / import subscriptions…', description: 'gjc setup credentials + /login 안내', _action: 'setup' });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: current ? `현재 gjc 모델: ${current} — 변경하거나 작업을 선택하세요` : 'gjc 기본 모델을 선택하세요 (OAuth 구독 기준)',
    matchOnDescription: true,
  });
  if (!picked) return;

  if (picked._action === 'custom') {
    const value = await vscode.window.showInputBox({
      prompt: 'gjc 모델 (퍼지 매칭: opus, gpt-5.2-codex, gemini-3-pro, grok-code-fast-1, 또는 provider/model)',
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
