# Changelog

## [2.4.1] - 2026-04-12

### Fixed
- **Open Folder — partial/mid-drag selection** — Context menu "Open Folder" now correctly resolves partial paths (e.g., mid-drag of an absolute path selecting `rockuen/obsidian/...`). Introduced `resolvePathFragment` which tries cwd → ancestors (walk-up) → home dir → platform roots (`/Users` on Mac, `/home` on Linux), accepting only paths that actually exist. Previously walked up to any existing parent and silently opened the wrong folder (often cwd).
- **Open Folder — lost selection on right-click** — Some environments (notably Mac Electron + xterm canvas) cleared the selection during `mousedown`/`contextmenu`, causing "Select text first" toasts even with visible selection. Now caches the selection at `contextmenu` time and falls back to it when live selection is empty.
- **`~` expansion** — `~`, `~/foo` now expand to home directory on Mac/Linux.

### Added
- **Open Folder — success toast** — Shows "Open folder: <path>" on success (parity with Open File).
- **Invalid path warning** — Shows "Cannot open folder (invalid or partial path)" instead of silently opening an unrelated ancestor directory.

## [2.4.0] - 2026-04-08

### Security
- **Command injection hardening** — Replaced all `exec()` with `execFile`/`spawn` + argument arrays (`killPtyProcess`, `showDesktopNotification`, `handleOpenFile`, `handleOpenFolder`, `readClipboardImageFromSystem`)
- **URL scheme validation** — `open-link` handler now rejects non-http(s) URLs (prevents `javascript:`, `vscode:` execution)
- **Windows path injection fix** — `openNative` uses `vscode.env.openExternal` instead of `cmd /c start` for untrusted paths

### Fixed
- **Long text paste truncation** — `writePtyChunked()` splits large inputs into 1024-byte chunks with 10ms intervals (ConPTY buffer overflow fix)
- **Stale PTY handler race** — Added `entry.pty !== thisPty` guard on all `onData`/`onExit` handlers to prevent old PTY exit events from corrupting new PTY state
- **Restart PTY robustness** — Kill old PTY before spawn, reset `_disposed` flag, debounce with `_restarting` guard, use stored `cols/rows` instead of hardcoded 120x30
- **Deactivate saves dead sessions** — Filter `!entry.pty` entries to prevent restoring finished conversations on reload
- **Null PTY guards** — `handlePasteImage`, `handleDropFiles` now check `entry.pty` before write
- **File descriptor leak** — `_extractFirstUserMessage` uses `try/finally` for `fs.closeSync`
- **Particle animation** — Skip render loop when particles are disabled (CPU savings)
- **CLI resolve timeout** — `execFileSync` with 1.5s timeout (was `execSync` 3s blocking)

## [2.3.7] - 2026-04-07

### Fixed
- **"Webview is disposed" errors** — Added `_disposed` guard flag and `try/catch` protection to all async `postMessage` calls (PTY `onExit`, `setTimeout` callbacks, clipboard `exec`). Cleared `runningDelayTimer` in `onDidDispose` to prevent stale timer firing.

## [2.3.6] - 2026-04-03

### Fixed
- **Clean copy (trim trailing whitespace)** — `getCleanSelection()` trims trailing spaces from each line when copying terminal text. Applied to Ctrl+C, context menu Copy, Open File, and Open Folder.

## [2.3.1] - 2026-03-26

### Fixed
- **Context usage parsing overhaul** — Comprehensive ANSI strip (CSI, OSC, 2-byte ESC, all control chars including CR/DEL), rolling 300-char buffer for cross-chunk pattern capture, optional colon in keyword regex (`컨텍스트:` format), broad fallback regex for resilient % detection

### Added
- **Inline group management icons** — Rename/Delete icons on custom group headers, Empty Trash icon on trash group header
- **Session group context values** — `customGroup` and `trashGroup` context values for precise menu targeting
- **Group rename command** — Rename groups with expanded state preservation
- **Debug logging** — One-time context buffer sample log for parsing diagnostics

## [2.3.0] - 2026-03-26

### Added
- **Custom session groups** — Unlimited user-defined groups, QuickPick session move, "Remove from Group" to ungroup
- **Trash / Restore** — Delete moves sessions to trash folder, Restore brings them back, Empty Trash with confirmation dialog
- **Group collapse state persistence** — `onDidExpandElement`/`onDidCollapseElement` tracking, restored on refresh
- **i18n nls files** — `package.nls.json` (English) + `package.nls.ko.json` (Korean) for sidebar labels

### Fixed
- **`const projDir` duplicate declaration** — Reused variable in `_buildGroups()` for Trash group

## [2.1.6] - 2026-03-24

### Fixed
- **CLI resolution for npm installs** — Fixed "Cannot create process, error code 2" on Windows when Claude CLI is installed via `npm install -g`. node-pty cannot execute `.cmd` shim files directly; now wraps with `cmd.exe /c` automatically.
- Unified CLI path resolution into `resolveClaudeCli()` function (3-step: `~/.local/bin` → npm global → PATH fallback)

## [2.1.0] - 2026-03-24

### Added
- **i18n support** — English and Korean, auto-detected from IDE language setting
- **Settings modal** — In-extension settings UI (gear icon / right-click menu)
  - Theme, font size, font family, sound, particles toggle
  - Custom buttons and slash commands management
  - Export/Import settings as JSON for sharing
- **Context usage indicator** — Toolbar progress bar showing token usage (click to refresh)
- **Custom slash commands** — User-defined commands in autocomplete dropdown via settings
- **Custom buttons** — Configurable input panel buttons via settings
- **Ctrl+C copy** — Copy selected text with Ctrl+C, send interrupt when no selection
- **CLI not found detection** — Shows install guide when Claude Code CLI is missing

### Changed
- Toolbar simplified — removed zoom, paste image, sound buttons (accessible via settings/shortcuts)
- Queue button unified — single button for add + run
- Slash commands genericized — standard CLI commands only, personal skills via custom settings

## [2.0.0] - 2026-03-22

### Added
- Webview + xterm.js + node-pty based terminal
- Tab icon status display (idle/running/done/error)
- Session save/restore with split view support
- Slash command autocomplete (/ input dropdown)
- Task queue with sequential execution
- Input history (Ctrl+Up/Down)
- Image paste (PowerShell/osascript fallback)
- Windows desktop toast notifications
- 7 background themes with ambient glow effects
- Background particle effects
- Tab color tags, tab memo
- File path click to open (Obsidian/browser/editor)
- Keyboard shortcut overlay (Ctrl+?)
- Search bar (Ctrl+F) with xterm-addon-search
- Conversation export to markdown
- Response timer
- "Close (Resume Later)" with sidebar session grouping
- Cross-platform support (Windows/Mac)
- Install script (install.sh)
