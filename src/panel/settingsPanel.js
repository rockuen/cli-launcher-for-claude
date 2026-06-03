// @module panel/settingsPanel — global (extension-wide) settings editor.
//
// Distinct from the per-panel settings MODAL (webviewContent.js #settings-modal),
// which holds per-tab/per-session display prefs. This is a standalone editor
// PANEL (vscode.window.createWebviewPanel) opened from the sidebar ⚙ for
// settings that apply globally to the extension and persist via
// ConfigurationTarget.Global.
//
// Layout: Claudix-style 2-column — left category nav, right content pane.
// Categories are data-driven (CATEGORIES array) so new ones can be added by
// extending the array + adding a render branch in the webview script. Today
// the only category is "Agent".
//
// Single-instance: the panel is cached in a module-scoped variable; a second
// invocation reveals the existing panel instead of creating a duplicate.

const vscode = require('vscode');
const { listAgents } = require('../agents/registry');

// Module-scoped single-instance cache.
let panel = null;

// Category catalog — extend this array (+ a render branch in the client script
// below) to add more global-settings categories later.
const CATEGORIES = [
  { id: 'agent', label: 'Agent' },
];

function getHtml(currentAgent, agents, enabledAgents) {
  const navItems = CATEGORIES.map((c, i) =>
    `<div class="nav-item${i === 0 ? ' active' : ''}" data-cat="${c.id}">${c.label}</div>`
  ).join('\n        ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root { --accent: #D97757; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--vscode-font-family, -apple-system, "Segoe UI", sans-serif);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-size: 13px;
    }
    .layout { display: flex; height: 100vh; }
    .nav {
      flex: 0 0 200px;
      border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
      padding: 16px 8px;
      overflow-y: auto;
    }
    .nav-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      opacity: 0.6;
      margin: 0 8px 10px;
    }
    .nav-item {
      padding: 7px 12px;
      border-radius: 6px;
      cursor: pointer;
      margin-bottom: 2px;
      user-select: none;
    }
    .nav-item:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15)); }
    .nav-item.active {
      background: var(--vscode-list-activeSelectionBackground, rgba(217,119,87,0.18));
      color: var(--vscode-list-activeSelectionForeground, inherit);
    }
    .content { flex: 1; padding: 24px 28px; overflow-y: auto; }
    .panel { display: none; }
    .panel.active { display: block; }
    h2 { font-size: 16px; margin: 0 0 18px; font-weight: 600; }
    .field { margin-bottom: 18px; max-width: 480px; }
    .field-label { font-size: 13px; font-weight: 600; margin-bottom: 6px; }
    .field-desc { font-size: 12px; opacity: 0.75; margin-bottom: 10px; line-height: 1.5; }
    select {
      height: 30px;
      min-width: 180px;
      padding: 0 8px;
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border, rgba(128,128,128,0.4)));
      border-radius: 5px;
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
      font-size: 13px;
      outline: none;
    }
    select:focus { border-color: var(--accent); }
    .note {
      margin-top: 14px;
      padding: 12px 14px;
      border-left: 3px solid var(--accent);
      background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.08));
      border-radius: 0 6px 6px 0;
      font-size: 12px;
      line-height: 1.6;
    }
    code {
      font-family: var(--vscode-editor-font-family, monospace);
      background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.18));
      padding: 1px 5px;
      border-radius: 4px;
    }
    .agent-row {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 14px 16px;
      margin-bottom: 12px;
      max-width: 560px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      border-radius: 8px;
      background: var(--vscode-editorWidget-background, rgba(128,128,128,0.04));
    }
    .agent-row.disabled { opacity: 0.7; }
    .agent-main { flex: 1; min-width: 0; }
    .agent-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .agent-name { font-size: 13px; font-weight: 600; }
    .badge {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 2px 7px;
      border-radius: 10px;
    }
    .badge.installed { color: #fff; background: #2e7d32; }
    .badge.missing {
      color: var(--vscode-descriptionForeground, #999);
      background: var(--vscode-badge-background, rgba(128,128,128,0.22));
    }
    .agent-hint { font-size: 11px; opacity: 0.7; margin-top: 6px; line-height: 1.5; }
    .agent-default { font-size: 11px; margin-top: 8px; display: flex; align-items: center; gap: 6px; }
    .agent-default input { accent-color: var(--accent); }
    .agent-default.hidden { display: none; }
    .switch { display: flex; align-items: center; gap: 6px; font-size: 11px; user-select: none; }
    .switch input { width: 15px; height: 15px; accent-color: var(--accent); cursor: pointer; }
    .switch input:disabled { cursor: not-allowed; }
    .switch.disabled { opacity: 0.55; }
  </style>
</head>
<body>
  <div class="layout">
    <div class="nav">
      <div class="nav-title">Settings</div>
      ${navItems}
    </div>
    <div class="content">
      <div class="panel active" data-cat="agent">
        <h2>Agent</h2>
        <div class="field-desc" style="margin-bottom:18px;max-width:560px;">
          Enable the agents you want offered when creating a new session. Only
          enabled <em>and</em> installed agents appear in the picker. The
          <strong>default</strong> agent is pre-selected. Existing tabs keep their agent.
        </div>
        <div id="agent-list"></div>
      </div>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const AGENTS = ${JSON.stringify(agents)};
    let enabledAgents = ${JSON.stringify(enabledAgents)};
    let defaultAgent = ${JSON.stringify(currentAgent)} || 'claude';

    // Category navigation: clicking a left item shows the matching right panel.
    const navItems = document.querySelectorAll('.nav-item');
    const panels = document.querySelectorAll('.panel');
    navItems.forEach(item => {
      item.addEventListener('click', () => {
        const cat = item.getAttribute('data-cat');
        navItems.forEach(n => n.classList.toggle('active', n === item));
        panels.forEach(p => p.classList.toggle('active', p.getAttribute('data-cat') === cat));
      });
    });

    const INSTALL_HINTS = {
      claude: 'Install the Claude Code CLI — see https://docs.anthropic.com/claude/docs/claude-code',
      kiro: 'Install with the kiro-cli CLI, then authenticate via kiro-cli login. Sessions resume by working directory.',
    };

    const listEl = document.getElementById('agent-list');

    function render() {
      listEl.innerHTML = '';
      AGENTS.forEach(a => {
        const enabled = enabledAgents.includes(a.id);
        const row = document.createElement('div');
        row.className = 'agent-row' + (a.installed ? '' : ' disabled');

        const main = document.createElement('div');
        main.className = 'agent-main';

        const head = document.createElement('div');
        head.className = 'agent-head';
        const name = document.createElement('span');
        name.className = 'agent-name';
        name.textContent = a.label;
        const badge = document.createElement('span');
        badge.className = 'badge ' + (a.installed ? 'installed' : 'missing');
        badge.textContent = a.installed ? '✓ installed' : 'not found';
        head.appendChild(name);
        head.appendChild(badge);
        main.appendChild(head);

        if (!a.installed) {
          const hint = document.createElement('div');
          hint.className = 'agent-hint';
          hint.textContent = INSTALL_HINTS[a.id] || ('Install the ' + a.cliName + ' CLI to enable this agent.');
          main.appendChild(hint);
        }

        // Default radio — only shown for enabled + installed agents.
        const def = document.createElement('label');
        def.className = 'agent-default' + (enabled && a.installed ? '' : ' hidden');
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'default-agent';
        radio.checked = defaultAgent === a.id;
        radio.addEventListener('change', () => {
          if (!radio.checked) return;
          defaultAgent = a.id;
          vscode.postMessage({ type: 'set-global', key: 'agent', value: a.id });
          render();
        });
        const defText = document.createElement('span');
        defText.textContent = 'Default for new sessions';
        def.appendChild(radio);
        def.appendChild(defText);
        main.appendChild(def);

        // Enable toggle — disabled when not installed.
        const sw = document.createElement('label');
        sw.className = 'switch' + (a.installed ? '' : ' disabled');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = enabled;
        cb.disabled = !a.installed;
        cb.addEventListener('change', () => {
          if (cb.checked) {
            if (!enabledAgents.includes(a.id)) enabledAgents = [...enabledAgents, a.id];
          } else {
            enabledAgents = enabledAgents.filter(id => id !== a.id);
          }
          vscode.postMessage({ type: 'set-global', key: 'enabledAgents', value: enabledAgents });
          render();
        });
        const swText = document.createElement('span');
        swText.textContent = 'Enabled';
        sw.appendChild(cb);
        sw.appendChild(swText);

        row.appendChild(main);
        row.appendChild(sw);
        listEl.appendChild(row);
      });
    }

    render();
  </script>
</body>
</html>`;
}

function openGlobalSettings(context) {
  // Single-instance: reveal the existing panel instead of opening a duplicate.
  if (panel) {
    try { panel.reveal(vscode.ViewColumn.Active); } catch (_) {}
    return panel;
  }

  panel = vscode.window.createWebviewPanel(
    'cclGlobalSettings',
    'CLI Launcher — Settings',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  const cfg = vscode.workspace.getConfiguration('claudeCodeLauncher');
  const currentAgent = cfg.get('agent') || 'claude';
  const enabledAgents = cfg.get('enabledAgents', ['claude', 'kiro']);
  panel.webview.html = getHtml(currentAgent, listAgents(), enabledAgents);

  panel.webview.onDidReceiveMessage((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type !== 'set-global') return;
    if (msg.key === 'agent' || msg.key === 'enabledAgents') {
      vscode.workspace
        .getConfiguration('claudeCodeLauncher')
        .update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
    }
  }, undefined, context.subscriptions);

  panel.onDidDispose(() => { panel = null; }, undefined, context.subscriptions);

  return panel;
}

module.exports = { openGlobalSettings };
