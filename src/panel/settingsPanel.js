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
  { id: 'general', label: 'General' },
  { id: 'sync', label: 'Sync' },
  { id: 'account', label: 'Account' },
  { id: 'slash', label: 'Slash Commands' },
  { id: 'files', label: 'File Associations' },
];

function getHtml(currentAgent, agents, enabledAgents, globals) {
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

    /* Generic global-settings controls (General/Sync/Account/Slash/Files). */
    input[type="text"].g-input {
      height: 30px;
      padding: 0 8px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,0.4)));
      border-radius: 5px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground, var(--vscode-foreground));
      font-size: 13px;
      outline: none;
    }
    input[type="text"].g-input:focus { border-color: var(--accent); }
    .g-toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      user-select: none;
      font-size: 12px;
    }
    .g-toggle .track {
      width: 38px; height: 20px;
      border-radius: 10px;
      background: var(--vscode-input-background, rgba(128,128,128,0.3));
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.4));
      position: relative;
      transition: background 0.15s;
      flex: 0 0 auto;
    }
    .g-toggle .track::after {
      content: '';
      position: absolute;
      top: 1px; left: 1px;
      width: 16px; height: 16px;
      border-radius: 50%;
      background: var(--vscode-foreground);
      opacity: 0.6;
      transition: left 0.15s, opacity 0.15s;
    }
    .g-toggle.on .track { background: var(--accent); border-color: var(--accent); }
    .g-toggle.on .track::after { left: 19px; opacity: 1; background: #fff; }
    .g-btn {
      height: 30px;
      padding: 0 14px;
      border: 1px solid var(--accent);
      border-radius: 5px;
      background: transparent;
      color: var(--accent);
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
    }
    .g-btn:hover { background: var(--vscode-list-hoverBackground, rgba(217,119,87,0.12)); }
    .g-add-btn {
      width: 30px; height: 30px;
      border: 1px solid var(--accent);
      border-radius: 5px;
      background: transparent;
      color: var(--accent);
      font-size: 16px;
      cursor: pointer;
      flex: 0 0 auto;
    }
    .g-list { margin-bottom: 10px; max-width: 560px; }
    .g-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      margin-bottom: 6px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      border-radius: 6px;
      background: var(--vscode-editorWidget-background, rgba(128,128,128,0.04));
      font-size: 12px;
    }
    .g-item .g-item-key { font-weight: 600; }
    .g-item .g-item-val { color: var(--vscode-descriptionForeground, #999); flex: 1; }
    .g-item .g-item-del {
      cursor: pointer;
      opacity: 0.6;
      font-size: 13px;
      padding: 2px 4px;
    }
    .g-item .g-item-del:hover { opacity: 1; color: #e05252; }
    .g-add-row { display: flex; gap: 6px; align-items: center; max-width: 560px; }
    .g-add-row .g-input { flex: 1; }
    .g-empty { font-size: 12px; opacity: 0.6; padding: 6px 2px; }
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

      <div class="panel" data-cat="general">
        <h2>General</h2>
        <div class="field">
          <div class="field-label">Default Terminal</div>
          <div class="field-desc">Backend used by the default "Open Claude Code" action. Webview keeps the rich xterm.js terminal; tmux/psmux runs Claude inside an external multiplexer session.</div>
          <select id="set-default-backend">
            <option value="webview">Webview (default)</option>
            <option value="multiplexer">tmux / psmux</option>
          </select>
        </div>
        <div class="field">
          <div class="field-label">Multiplexer Lifecycle</div>
          <div class="field-desc">What to do with the tmux/psmux session when the launcher tab closes. "Kill on close" avoids zombie sessions. "Detached" leaves the session running so you can re-attach from an external terminal.</div>
          <select id="set-mux-lifecycle">
            <option value="kill-on-close">Kill on close (default)</option>
            <option value="detached">Leave detached</option>
          </select>
        </div>
      </div>

      <div class="panel" data-cat="sync">
        <h2>Sync</h2>
        <div class="field">
          <div class="field-label">Repo Sync</div>
          <div class="field-desc">chokidar file watcher on the repo path. Reload Window after toggling to apply.</div>
          <label class="g-toggle" id="set-repo-sync-enabled"><span class="track"></span><span>Enabled</span></label>
        </div>
        <div class="field">
          <div class="field-label">Repo Path</div>
          <div class="field-desc">Path to the git repo to watch. Empty = current IDE workspace folder. Supports <code>\${workspaceFolder}</code>, <code>\${userHome}</code>, and <code>\${env:VAR}</code>. Reload Window to apply.</div>
          <input type="text" class="g-input" id="set-repo-sync-path" placeholder="/Users/..." style="width:100%;max-width:420px;">
        </div>
        <div class="field">
          <div class="field-label">Device Name</div>
          <div class="field-desc">Name embedded in auto-commit messages for this device.</div>
          <button class="g-btn" id="set-device-name">Set Device Name</button>
        </div>
      </div>

      <div class="panel" data-cat="account">
        <h2>Account</h2>
        <div class="field">
          <div class="field-label">Claude Account</div>
          <div class="field-desc">Switch between saved Claude accounts, or save the currently active account.</div>
          <div style="display:flex;gap:8px;">
            <button class="g-btn" id="set-switch-account">Switch Account</button>
            <button class="g-btn" id="set-save-account">Save Account</button>
          </div>
        </div>
      </div>

      <div class="panel" data-cat="slash">
        <h2>Slash Commands</h2>
        <div class="field-desc" style="margin-bottom:14px;max-width:560px;">
          Custom slash commands offered in the input panel's slash menu.
        </div>
        <div class="g-list" id="set-slash-list"></div>
        <div class="g-add-row">
          <input type="text" class="g-input" id="set-slash-cmd" placeholder="/command">
          <input type="text" class="g-input" id="set-slash-desc" placeholder="Description">
          <button class="g-add-btn" id="set-slash-add" title="Add">+</button>
        </div>
      </div>

      <div class="panel" data-cat="files">
        <h2>File Associations</h2>
        <div class="field-desc" style="margin-bottom:14px;max-width:560px;">
          Map a file extension to the method used to open it from the terminal.
        </div>
        <div class="g-list" id="set-fileassoc-list"></div>
        <div class="g-add-row">
          <input type="text" class="g-input" id="set-fa-ext" placeholder=".csv" style="flex:0 0 90px;">
          <select id="set-fa-method" style="flex:1;">
            <option value="excel">Excel</option>
            <option value="system">System Default</option>
            <option value="browser">Browser</option>
            <option value="obsidian">Obsidian</option>
            <option value="editor">IDE Editor</option>
            <option value="auto">Auto</option>
          </select>
          <button class="g-add-btn" id="set-fa-add" title="Add">+</button>
        </div>
      </div>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const AGENTS = ${JSON.stringify(agents)};
    let enabledAgents = ${JSON.stringify(enabledAgents)};
    let defaultAgent = ${JSON.stringify(currentAgent)} || 'claude';
    const GLOBALS = ${JSON.stringify(globals)};

    function escapeHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
    function setGlobal(key, value) {
      vscode.postMessage({ type: 'set-global', key, value });
    }
    function runCommand(command) {
      vscode.postMessage({ type: 'run-command', command });
    }

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

        // Kiro-only: --trust-all-tools toggle (skip per-tool permission prompts).
        // Bound to the global claudeCodeLauncher.kiro.trustAllTools; applies to
        // newly opened and restarted Kiro sessions.
        if (a.id === 'kiro') {
          const trust = document.createElement('label');
          trust.className = 'agent-default' + (enabled && a.installed ? '' : ' hidden');
          trust.title = 'Run Kiro with --trust-all-tools so it can use any tool without asking for confirmation each time. Applies to newly opened and restarted Kiro sessions.';
          const tcb = document.createElement('input');
          tcb.type = 'checkbox';
          tcb.checked = !!GLOBALS.kiroTrustAllTools;
          tcb.addEventListener('change', () => {
            vscode.postMessage({ type: 'set-global', key: 'kiro.trustAllTools', value: tcb.checked });
          });
          const trustText = document.createElement('span');
          trustText.textContent = 'Trust all tools (--trust-all-tools)';
          trust.appendChild(tcb);
          trust.appendChild(trustText);
          main.appendChild(trust);
        }

        // Claude-only: startup flags — Effort max (--effort max) + Bypass
        // permissions (--dangerously-skip-permissions). Bound to globals;
        // applied to newly opened and restarted Claude sessions.
        if (a.id === 'claude') {
          const addClaudeFlag = (checked, text, title, key) => {
            const lab = document.createElement('label');
            lab.className = 'agent-default' + (enabled && a.installed ? '' : ' hidden');
            lab.title = title;
            const cbx = document.createElement('input');
            cbx.type = 'checkbox';
            cbx.checked = !!checked;
            cbx.addEventListener('change', () => {
              vscode.postMessage({ type: 'set-global', key, value: cbx.checked });
            });
            const txt = document.createElement('span');
            txt.textContent = text;
            lab.appendChild(cbx);
            lab.appendChild(txt);
            main.appendChild(lab);
          };
          addClaudeFlag(GLOBALS.autoEffortMax, 'Effort max (--effort max)', 'Start Claude sessions at maximum effort (--effort max). Applies to newly opened and restarted Claude sessions.', 'autoEffortMax');
          addClaudeFlag(GLOBALS.claudeBypassPermissions, 'Bypass permissions (--dangerously-skip-permissions)', 'Start Claude sessions in bypass-permissions mode (--dangerously-skip-permissions), skipping tool/permission prompts. Use with care. Applies to newly opened and restarted Claude sessions.', 'claude.bypassPermissions');
        }

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

    // ---- General ----
    const setDefaultBackend = document.getElementById('set-default-backend');
    if (setDefaultBackend) {
      setDefaultBackend.value = GLOBALS.defaultBackend || 'webview';
      setDefaultBackend.addEventListener('change', () => {
        setGlobal('terminal.defaultBackend', setDefaultBackend.value);
      });
    }

    const setMuxLifecycle = document.getElementById('set-mux-lifecycle');
    if (setMuxLifecycle) {
      setMuxLifecycle.value = GLOBALS.multiplexerLifecycle || 'kill-on-close';
      setMuxLifecycle.addEventListener('change', () => {
        setGlobal('terminal.multiplexerLifecycle', setMuxLifecycle.value);
      });
    }

    function wireToggle(id, key, initial) {
      const el = document.getElementById(id);
      if (!el) return;
      let on = initial === true;
      el.classList.toggle('on', on);
      el.addEventListener('click', () => {
        on = !on;
        el.classList.toggle('on', on);
        setGlobal(key, on);
      });
    }
    // ---- Sync ----
    wireToggle('set-repo-sync-enabled', 'repoSync.enabled', GLOBALS.repoSyncEnabled);

    const setRepoSyncPath = document.getElementById('set-repo-sync-path');
    if (setRepoSyncPath) {
      setRepoSyncPath.value = GLOBALS.repoSyncPath || '';
      let pathTimer = null;
      setRepoSyncPath.addEventListener('input', () => {
        clearTimeout(pathTimer);
        pathTimer = setTimeout(() => {
          setGlobal('repoSync.path', setRepoSyncPath.value);
        }, 500);
      });
    }

    const setDeviceName = document.getElementById('set-device-name');
    if (setDeviceName) {
      setDeviceName.addEventListener('click', () => {
        runCommand('claudeCodeLauncher.repoSync.setDeviceName');
      });
    }

    // ---- Account ----
    const setSwitchAccount = document.getElementById('set-switch-account');
    if (setSwitchAccount) {
      setSwitchAccount.addEventListener('click', () => {
        runCommand('claudeCodeLauncher.switchAccount');
      });
    }
    const setSaveAccount = document.getElementById('set-save-account');
    if (setSaveAccount) {
      setSaveAccount.addEventListener('click', () => {
        runCommand('claudeCodeLauncher.saveAccount');
      });
    }

    // ---- Slash Commands ----
    let localSlash = (GLOBALS.customSlashCommands || []).slice();
    const slashListEl = document.getElementById('set-slash-list');
    function renderSlashList() {
      if (!slashListEl) return;
      if (!localSlash.length) {
        slashListEl.innerHTML = '<div class="g-empty">No custom slash commands.</div>';
        return;
      }
      slashListEl.innerHTML = localSlash.map((s, i) =>
        '<div class="g-item">' +
          '<span class="g-item-key">' + escapeHtml(s.cmd) + '</span>' +
          '<span class="g-item-val">' + escapeHtml(s.desc) + '</span>' +
          '<span class="g-item-del" data-si="' + i + '" title="Delete">&#x2715;</span>' +
        '</div>'
      ).join('');
    }
    renderSlashList();
    if (slashListEl) {
      slashListEl.addEventListener('click', (e) => {
        const del = e.target.closest('.g-item-del');
        if (!del) return;
        localSlash.splice(parseInt(del.dataset.si), 1);
        renderSlashList();
        setGlobal('customSlashCommands', localSlash);
      });
    }
    const slashAdd = document.getElementById('set-slash-add');
    if (slashAdd) {
      slashAdd.addEventListener('click', () => {
        const cmd = document.getElementById('set-slash-cmd').value.trim();
        const desc = document.getElementById('set-slash-desc').value.trim();
        if (!cmd || !desc) return;
        localSlash.push({ cmd, desc });
        document.getElementById('set-slash-cmd').value = '';
        document.getElementById('set-slash-desc').value = '';
        renderSlashList();
        setGlobal('customSlashCommands', localSlash);
      });
    }

    // ---- File Associations ----
    const FA_LABELS = { excel: 'Excel', system: 'System Default', browser: 'Browser', obsidian: 'Obsidian', editor: 'IDE Editor', auto: 'Auto' };
    let localFileAssoc = Object.assign({}, GLOBALS.fileAssociations || {});
    const faListEl = document.getElementById('set-fileassoc-list');
    function renderFaList() {
      if (!faListEl) return;
      const entries = Object.entries(localFileAssoc).sort((a, b) => a[0].localeCompare(b[0]));
      if (!entries.length) {
        faListEl.innerHTML = '<div class="g-empty">No file associations.</div>';
        return;
      }
      faListEl.innerHTML = entries.map(([ext, method]) =>
        '<div class="g-item">' +
          '<span class="g-item-key">' + escapeHtml(ext) + '</span>' +
          '<span class="g-item-val">' + escapeHtml(FA_LABELS[method] || method) + '</span>' +
          '<span class="g-item-del" data-faext="' + escapeHtml(ext) + '" title="Delete">&#x2715;</span>' +
        '</div>'
      ).join('');
    }
    renderFaList();
    if (faListEl) {
      faListEl.addEventListener('click', (e) => {
        const del = e.target.closest('.g-item-del');
        if (!del) return;
        delete localFileAssoc[del.dataset.faext];
        renderFaList();
        setGlobal('fileAssociations', localFileAssoc);
      });
    }
    const faAdd = document.getElementById('set-fa-add');
    if (faAdd) {
      faAdd.addEventListener('click', () => {
        let ext = document.getElementById('set-fa-ext').value.trim().toLowerCase();
        const method = document.getElementById('set-fa-method').value;
        if (!ext) return;
        if (!ext.startsWith('.')) ext = '.' + ext;
        localFileAssoc[ext] = method;
        document.getElementById('set-fa-ext').value = '';
        renderFaList();
        setGlobal('fileAssociations', localFileAssoc);
      });
    }
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
  const enabledAgents = cfg.get('enabledAgents', ['claude']);
  const globals = {
    defaultBackend: cfg.get('terminal.defaultBackend', 'webview'),
    multiplexerLifecycle: cfg.get('terminal.multiplexerLifecycle', 'kill-on-close'),
    autoEffortMax: cfg.get('autoEffortMax', false),
    claudeBypassPermissions: cfg.get('claude.bypassPermissions', false),
    kiroTrustAllTools: cfg.get('kiro.trustAllTools', false),
    repoSyncEnabled: cfg.get('repoSync.enabled', false),
    repoSyncPath: cfg.get('repoSync.path', ''),
    customSlashCommands: cfg.get('customSlashCommands', []),
    fileAssociations: cfg.get('fileAssociations', {}),
  };
  panel.webview.html = getHtml(currentAgent, listAgents(), enabledAgents, globals);

  // Keys the webview may write to ConfigurationTarget.Global. Gated so a
  // compromised message channel can't write arbitrary config keys.
  const ALLOWED_GLOBAL_KEYS = new Set([
    'agent',
    'enabledAgents',
    'terminal.defaultBackend',
    'terminal.multiplexerLifecycle',
    'autoEffortMax',
    'claude.bypassPermissions',
    'kiro.trustAllTools',
    'repoSync.enabled',
    'repoSync.path',
    'customSlashCommands',
    'fileAssociations',
  ]);

  // Commands the webview may trigger from settings buttons. Allowlisted for
  // the same reason as the keys above.
  const ALLOWED_COMMANDS = new Set([
    'claudeCodeLauncher.repoSync.setDeviceName',
    'claudeCodeLauncher.switchAccount',
    'claudeCodeLauncher.saveAccount',
  ]);

  panel.webview.onDidReceiveMessage((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'set-global') {
      if (typeof msg.key === 'string' && ALLOWED_GLOBAL_KEYS.has(msg.key)) {
        vscode.workspace
          .getConfiguration('claudeCodeLauncher')
          .update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
      }
      return;
    }
    if (msg.type === 'run-command') {
      if (typeof msg.command === 'string' && ALLOWED_COMMANDS.has(msg.command)) {
        vscode.commands.executeCommand(msg.command);
      }
      return;
    }
  }, undefined, context.subscriptions);

  panel.onDidDispose(() => { panel = null; }, undefined, context.subscriptions);

  return panel;
}

module.exports = { openGlobalSettings };
