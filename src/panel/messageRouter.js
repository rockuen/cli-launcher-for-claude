// @module panel/messageRouter — single dispatch for 19 webview→extension message types.
// ctx carries: { entry, panel, context, extensionPath, createPanel, pickAgent, onWebviewReady }.
// createPanel/pickAgent are injected (callbacks) to avoid circular imports.
//
// Message protocol (18 webview→ext):
//   webview-ready, input, submit-input, resize, toolbar, paste-image, check-clipboard-image,
//   drop-files, open-link, rename-tab, save-setting, export-settings, import-settings,
//   close-resume, open-file, open-folder, open-reader, restart-session,
//   request-edit-memo

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const state = require('../state');
const { t } = require('../i18n');
const { sessionStoreGet, sessionStoreUpdate } = require('../store/sessionStore');
const { saveSessions } = require('../store/sessionManager');
const { listAntigravitySessions } = require('../lib/sessionJsonl');
const { writePtyChunked } = require('../pty/write');
const { handleToolbar } = require('../handlers/toolbar');
const { pickAgent } = require('../handlers/pickAgent');
const { handlePasteImage, readClipboardImageFromSystem } = require('../handlers/pasteImage');
const { handleDropFiles } = require('../handlers/dropFiles');
const { handleOpenFile } = require('../handlers/openFile');
const { handleOpenFolder } = require('../handlers/openFolder');
const readerView = require('./readerView');
const { handlePasteLargeText } = require('../handlers/pasteLargeText');
const { restartPty } = require('./restartPty');
const { buildSubmitInputWrites } = require('../pty/submitInput');

// Pure cursor-navigation keystrokes (arrows / page / home / end) — the keys
// used to move WITHIN a menu without answering it. The input handler keeps the
// affordance tail intact on these so navigating an open menu isn't mistaken for
// an answer (Ink re-renders a navigated menu only partially, without re-emitting
// the footer the detector keys on).
function isNavKey(data) {
  if (!data) return false;
  return /^(?:\x1b(?:\[|O)[ABCDHF]|\x1b\[[0-9;]*~)+$/.test(data);
}

function routeWebviewMessage(msg, ctx) {
  const { entry, panel, context, extensionPath, createPanel, onWebviewReady } = ctx;

  switch (msg.type) {
    case 'webview-ready':
      onWebviewReady();
      return;

    case 'input':
      if (entry.pty) writePtyChunked(entry, msg.data);
      // A menu ANSWER (digit / Enter / Esc / typing) closes the menu, so drop
      // the rolling affordance tail — otherwise the just-answered menu's footer
      // lingers in the 6KB tail (because /model et al. emit little on close) and
      // keeps the affordance "present", blocking the terminal-restore. But do
      // NOT drop it on pure NAVIGATION keys (arrows / page / home / end): Ink
      // re-renders a navigated menu only PARTIALLY (changed rows, no footer), so
      // clearing mid-navigation would lose the footer and falsely restore the
      // terminal as if the menu had been answered. _promptSig isn't cleared here
      // either, so a re-detected menu doesn't re-notify.
      if (!isNavKey(msg.data)) entry._recentTail = '';
      return;

    case 'submit-input': {
      if (!entry.pty) return;
      const writes = buildSubmitInputWrites(msg.text || '', { agent: entry.agent });
      let delay = 0;
      for (const w of writes) {
        delay += w.delayMs || 0;
        if (delay > 0) {
          setTimeout(() => {
            if (entry.pty && !entry._disposed) writePtyChunked(entry, w.data);
          }, delay);
        } else {
          writePtyChunked(entry, w.data);
        }
      }
      entry._recentTail = '';
      return;
    }

    case 'resize':
      entry._lastCols = msg.cols;
      entry._lastRows = msg.rows;
      // Resize the pty to the ACTUAL visible rows so the pty and xterm stay in
      // sync — Claude's input then sits at the pane bottom naturally. (The old
      // 40-row floor, for the removed choice-bar detector, forced a pty/xterm
      // row mismatch that bottom-anchoring tried to hide, which mispositioned
      // short content. Idle prompt detection is byte-based on the PTY footer,
      // which Claude emits even when a tall menu is windowed into a short pane.)
      if (entry.pty) try { entry.pty.resize(msg.cols, msg.rows || 24); } catch (_) {}
      return;

    // v2.6.4: force TUI full redraw without touching session or scrollback.
    // Useful when fullscreen rendering gets corrupted (overlapping text,
    // ghost lines) after wheel scrolling. We toggle the PTY size by 1 column
    // and back so the TUI receives two SIGWINCH signals and redraws from
    // scratch. No SIGINT, no /clear, no /compact — just a visual refresh.
    case 'redraw-screen':
      if (!entry.pty) return;
      try {
        const cols = entry._lastCols || 80;
        const rows = entry._lastRows || 24;
        const tmpCols = Math.max(2, cols - 1);
        entry.pty.resize(tmpCols, rows);
        setTimeout(() => {
          try { entry.pty && entry.pty.resize(cols, rows); } catch (_) {}
        }, 40);
      } catch (_) {}
      return;

    case 'toolbar':
      handleToolbar(msg.action, entry, context, extensionPath, createPanel, pickAgent);
      return;

    case 'paste-image':
      if (entry.pty) handlePasteImage(msg.data, entry, panel);
      return;

    case 'check-clipboard-image':
      if (entry.pty) readClipboardImageFromSystem(entry, panel);
      return;

    case 'drop-files':
      if (entry.pty) handleDropFiles(msg.paths, entry);
      return;

    case 'open-link':
      if (/^https?:\/\//i.test(msg.url)) {
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
      }
      return;

    case 'rename-tab':
      vscode.window.showInputBox({ prompt: t('enterTabName'), value: entry.title }).then(newName => {
        if (newName) {
          entry.title = newName;
          panel.title = newName;
          // Antigravity fresh/--continue sessions carry a placeholder UUID that
          // never matches the real conversation id in the tree. Resolve it now
          // so the rename persists in the correct titleMap slot.
          if (entry.agent === 'antigravity' && !entry.isAntigravityResume && entry.cwd) {
            const sessions = listAntigravitySessions(entry.cwd);
            if (sessions.length > 0) {
              entry.sessionId = sessions[0].sessionId;
              entry.isAntigravityResume = true;
            }
          }
          panel.webview.postMessage({ type: 'title-updated', title: newName });
          saveSessions();
        }
      });
      return;

    case 'save-setting': {
      const cfg = vscode.workspace.getConfiguration('claudeCodeLauncher');
      cfg.update(msg.key, msg.value, true);
      return;
    }

    case 'invoke-command': {
      // Allowlist gates which commands the webview can trigger so a
      // compromised message channel can't fire arbitrary vscode commands.
      // Add command IDs here only when a webview-side surface (settings
      // modal button, toolbar) needs to invoke them.
      const ALLOWED_INVOKES = new Set([
        'claudeCodeLauncher.switchAccount',
        'claudeCodeLauncher.saveAccount',
        'claudeCodeLauncher.handoffToOther',
      ]);
      if (typeof msg.command === 'string' && ALLOWED_INVOKES.has(msg.command)) {
        vscode.commands.executeCommand(msg.command);
      }
      return;
    }

    case 'webview-memory': {
      // v3.6.3: webview-side memory probe report. The webview's V8 context
      // is separate from the extension host's, so its heap usage isn't
      // visible to process.memoryUsage() — this report fills that gap.
      // When diagnostics is off the message is dropped here, keeping the
      // disabled-state cost to one map lookup per minute per panel.
      if (state.diagnostics) {
        state.diagnostics.recordWebviewMemory(entry.tabId, msg);
      }
      return;
    }

    // Phase 3 split layout: persist reader/terminal ratio across reloads.
    // Stored in extension globalState (not user settings) so the value is
    // per-machine without polluting settings.json. Webview clamps before
    // sending, but clamp again here as a defensive belt.
    case 'save-split-ratio': {
      const r = Number(msg.ratio);
      if (Number.isFinite(r)) {
        const clamped = Math.max(0.15, Math.min(0.85, r));
        try { context.globalState.update('claudeCodeLauncher.splitRatio', clamped); } catch (_) {}
      }
      return;
    }

    case 'export-settings': {
      const cfg = vscode.workspace.getConfiguration('claudeCodeLauncher');
      const exportData = {
        defaultTheme: cfg.get('defaultTheme'),
        defaultFontSize: cfg.get('defaultFontSize'),
        defaultFontFamily: cfg.get('defaultFontFamily'),
        soundEnabled: cfg.get('soundEnabled'),
        particlesEnabled: cfg.get('particlesEnabled'),
        customButtons: cfg.get('customButtons'),
        customSlashCommands: cfg.get('customSlashCommands'),
      };
      const json = JSON.stringify(exportData, null, 2);
      vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), 'claude-launcher-settings.json')),
        filters: { 'JSON': ['json'] }
      }).then(uri => {
        if (uri) {
          fs.writeFileSync(uri.fsPath, json, 'utf8');
          vscode.window.showInformationMessage('Settings exported: ' + path.basename(uri.fsPath));
        }
      });
      return;
    }

    case 'import-settings':
      vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectMany: false,
        filters: { 'JSON': ['json'] }
      }).then(uris => {
        if (!uris || uris.length === 0) return;
        try {
          const text = fs.readFileSync(uris[0].fsPath, 'utf8');
          const data = JSON.parse(text);
          const cfg = vscode.workspace.getConfiguration('claudeCodeLauncher');
          const keys = ['defaultTheme','defaultFontSize','defaultFontFamily','soundEnabled','particlesEnabled','customButtons','customSlashCommands'];
          for (const k of keys) {
            if (data[k] !== undefined) cfg.update(k, data[k], true);
          }
          vscode.window.showInformationMessage('Settings imported from ' + path.basename(uris[0].fsPath) + '. Reload window to apply.');
        } catch (e) {
          vscode.window.showErrorMessage('Invalid settings file: ' + e.message);
        }
      });
      return;

    case 'close-resume': {
      const titleMap = sessionStoreGet('claudeSessionTitles', {});
      if (entry.sessionId && entry.title && !/^Claude Code( \(\d+\))?$/.test(entry.title)) {
        titleMap[entry.sessionId] = entry.title;
      }
      sessionStoreUpdate('claudeSessionTitles', titleMap);
      if (entry.sessionId) {
        const saved = sessionStoreGet('claudeSavedSessions', []);
        if (!saved.some(s => s.sessionId === entry.sessionId)) {
          saved.unshift({ sessionId: entry.sessionId, title: entry.title, savedAt: Date.now() });
          sessionStoreUpdate('claudeSavedSessions', saved);
        }
      }
      panel.dispose();
      state.refreshSessionTrees();
      return;
    }

    case 'open-file':
      handleOpenFile(msg.filePath, msg.line, entry);
      return;

    case 'open-folder':
      handleOpenFolder(msg.filePath, entry);
      return;

    // Phase 4 reader: anchor href that isn't an http(s) URL is forwarded here.
    // Common shapes from marked output and user pastes:
    //   /Users/foo/bar.txt        → file
    //   /Users/foo/bar.txt:42     → file at line 42
    //   /Users/foo/                → folder
    //   ~/Projects/x              → home-relative
    //   file:///Users/foo/bar.txt → URL-encoded file scheme
    //   C:\Users\foo or C:/Users/foo → Windows
    // We stat the resolved path and dispatch to file vs folder helpers so
    // reader-side single click reaches the same handlers as xterm right-click.
    case 'open-path': {
      if (!msg.path) return;
      let p = String(msg.path).trim();
      // Strip surrounding quotes/backticks (marked escapes are already done,
      // but a user-pasted markdown link target sometimes includes them).
      p = p.replace(/^['"`]+|['"`]+$/g, '');
      // file://… — decode and drop the scheme. Tolerate file:/// and file://host.
      if (/^file:\/\//i.test(p)) {
        try {
          let stripped = p.replace(/^file:\/\/[^/]*/i, '');
          p = decodeURIComponent(stripped);
        } catch (_) { /* fall through with raw */ }
      }
      // Trailing :LINE for files. Don't apply to Windows drive prefixes (C:\).
      let line = 0;
      const lineMatch = p.match(/:(\d+)$/);
      if (lineMatch && !/^[A-Za-z]:[\\/]?$/.test(p.slice(0, p.length - lineMatch[0].length + 1))) {
        line = parseInt(lineMatch[1], 10);
        p = p.replace(/:\d+$/, '');
      }
      // ~ expansion
      if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
        p = path.join(os.homedir(), p.slice(1));
      }
      // v3.4.5: bare filenames (`README.md`, `src/foo.ts`) and other relative
      // paths from the reader autolink resolve against the Claude session's
      // cwd. Without this, fs.statSync uses the extension host's cwd and
      // almost always returns ENOENT. handleOpenFile / handleOpenFolder both
      // honor fileAssociations once we hand them an absolute path, so a `.md`
      // resolved this way still routes to Obsidian (or whatever the user
      // configured) instead of the IDE.
      // Preserve the pre-absolutize fragment so the fallback chain (incl. the
      // OS file index) can search by basename when the cwd-resolved path misses.
      const fragment = p;
      if (!path.isAbsolute(p) && entry && entry.cwd) {
        try { p = path.resolve(entry.cwd, p); } catch (_) {}
      }
      let isDir = false;
      let found = true;
      try {
        const stat = fs.statSync(p);
        isDir = stat.isDirectory();
      } catch (_) {
        found = false;
      }
      if (!found) {
        // Not at the cwd-resolved location — hand off to handleOpenFile, which
        // runs ancestors + cwd basename walk + the Everything/mdfind/locate
        // fallback before giving up with a not-found message.
        handleOpenFile(fragment, line, entry);
        return;
      }
      if (isDir) handleOpenFolder(p, entry);
      else handleOpenFile(p, line, entry);
      return;
    }

    case 'open-reader':
      readerView.show(entry, context);
      return;

    case 'paste-large-text':
      handlePasteLargeText(msg, entry, panel);
      return;

    case 'open-paste-file':
      if (msg.path) {
        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.path));
      }
      return;

    case 'inject-paste-file':
      // Deferred image paste (kiro): inject the path only when the user confirms
      // from the toast, so [취소] truly cancels (nothing was injected). kiro's
      // TUI doesn't honor the client-side backspaces claude uses to undo an
      // upfront injection.
      if (entry.pty && msg.path) entry.pty.write(String(msg.path).replace(/\\/g, '/') + ' ');
      return;

    case 'cancel-paste-file':
      // v2.5.7: user clicked [취소] on a paste/image attachment toast. PTY
      // backspaces are sent client-side via an 'input' message; here we just
      // remove the temp file so it doesn't linger past its purpose.
      if (msg.path) {
        try { fs.unlinkSync(msg.path); } catch (_) {}
      }
      return;

    case 'restart-session':
      restartPty(entry, panel, context, extensionPath);
      return;

    case 'request-edit-memo':
      vscode.window.showInputBox({
        prompt: t('enterMemo'),
        value: entry.memo || ''
      }).then(value => {
        if (value !== undefined) {
          entry.memo = value;
          saveSessions();
          panel.webview.postMessage({ type: 'memo-updated', memo: value });
        }
      });
      return;

    default:
      console.warn('[Claude Launcher] [router] unknown message type:', msg.type);
  }
}

module.exports = { routeWebviewMessage };
