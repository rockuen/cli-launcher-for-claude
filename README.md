<p align="center">
  <img src="icons/icon-128.png" alt="CLI Launcher for Claude" width="96" height="96"/>
</p>

<h1 align="center">CLI Launcher for Claude</h1>

<p align="center">
  <strong>Run Claude Code inside a rich Webview tab — with status icons, session management,
  themes, optional tmux/psmux backend, and OMC integration.</strong>
</p>

<p align="center">
  <em>VSCode / Antigravity extension for the
  <a href="https://docs.anthropic.com/en/docs/claude-code/overview">Claude Code CLI</a>.</em>
</p>

---

## Why this exists

Claude Code is great in a plain terminal, but a terminal is a thin host: no per-session
status, no save/restore, no themes, no quick way to switch backends, no place to surface
OMC artifacts. **CLI Launcher** wraps the CLI in a Webview tab so each session has its
own icon-aware lifecycle, lives in a sidebar tree you can group and re-attach to, and can
optionally run inside a tmux/psmux session for power-user workflows. OMC integration is
gated behind a single mode toggle so non-OMC users never see the extra surface.

## Install

Three ways to install:

1. **Open VSX**: search for *CLI Launcher for Claude* in the Extensions view (Antigravity)
   or VSCode (with the [Open VSX gallery](https://open-vsx.org/extension/rockuen/cli-launcher-for-claude)).
2. **VSIX**: download the latest `cli-launcher-for-claude-<platform>-<version>.vsix` from
   [GitHub Releases](https://github.com/rockuen/cli-launcher-for-claude/releases) and
   install via `Extensions: Install from VSIX...`.
3. **Build from source**:
   ```bash
   git clone https://github.com/rockuen/cli-launcher-for-claude.git
   cd cli-launcher-for-claude
   npm install && npm run build && npm run package
   ```

Requires `claude` on `PATH` (`npm install -g @anthropic-ai/claude-code` or the
official standalone install).

## Quick start

- **Open a session**: `Cmd/Ctrl+Shift+;` or click the Claude icon in the editor title bar.
- **Resume a session**: click any entry in the **Sessions** sidebar (sidebar → Claude Code activity).
- **Settings**: gear icon (⚙) at the top of the launcher panel.

## Features

### Terminal with status awareness
- Tab icon flips through **idle / running / done / error / needs-attention** based on the PTY stream.
- Ambient glow border + response timer mirror the same state.
- **Interactive prompt fast-path**: `[Y/n]`, `Press Enter to continue…`, etc. trigger
  `needs-attention` immediately instead of waiting out the 7-second running threshold.
- Title blinks while a tab needs attention but isn't focused.

### Session management
- **Save / restore** across IDE restarts (sessions live in `sessions.json`, no workspaceState lock-in).
- **Resume Later** group + **Recent Sessions** + **Trash** built-ins.
- **Custom groups** with drag-and-drop, rename, delete, reorder.
- **Nested sub-folders up to 3 levels** (`Work → Backend → API`). Right-click a group → *Add Sub-Group*.
- **Sub-sessions**: nest one session under another with *Nest Under Session…*.

### Context usage indicator
- Toolbar progress bar reads Claude Code's `ctx:XX%` status line and color-codes
  green → orange → red as the window fills.
- Click the bar to manually refresh via `/context`.

### Input panel
- Slash command autocomplete (type `/` → suggestions).
- Task queue (queue multiple prompts, run sequentially).
- Custom buttons (label + slash command), configurable in Settings.
- Ctrl/Cmd+Up/Down input history.
- Drag-and-drop files / paste images / paste large text → file (configurable threshold).

### Themes & customization
- 7 themes: Default / Midnight / Ocean / Forest / Sunset / Aurora / Warm.
- Background particle effects with state-based animation.
- Configurable font size and family.
- In-extension Settings UI; Export/Import as JSON.

### Brace-expanded path opening
- File/folder click handlers expand `worker-{1,2,3}/answer.md` style patterns (common
  in OMC team artifacts) and open every match at once.

## OMC mode

OMC-dependent features are **gated behind a single context key**. When you don't have
OMC installed (or simply don't want it), nothing extra is surfaced.

Toggle: command palette → *Enter OMC Mode* / *Exit OMC Mode*. The first time the
extension detects a local OMC install (`~/.omc/` + `omc` CLI + valid config), it asks
once whether to enable OMC mode automatically.

### What lights up under OMC mode

- **CCG (Claude-Codex-Gemini) viewer** — sidebar tree of every `/ccg` artifact pair
  (`.omc/artifacts/ask/codex-*.md` ↔ `gemini-*.md`) with a per-pair Webview comparison.
  Commands: *Show CCG*, *Refresh CCG*, *Open CCG Pair*, *Rerun CCG*.
- **HUD status bar item** — bottom-right pill showing model / context % / total cost /
  5-hour rate-limit %, driven by `<workspace>/.omc/state/hud-stdin-cache.json`.
- **HUD snapshot command** — *Show HUD Snapshot* dumps the current HUD JSON to the
  output panel.

## Optional tmux/psmux backend

The launcher can wrap claude inside an attached tmux (Mac/Linux) or psmux (Windows)
session, all inside the same Webview tab. The Webview UI is identical — only the
underlying pty changes — so power users get external attach + multi-machine workflows
without giving up the launcher's terminal niceties.

### Switching modes
- **In-app**: Settings (⚙) → *Default Terminal* → `Webview` or `tmux / psmux`.
- **Per-action override**:
  - Command palette → *Open Claude Code* (always Webview)
  - Command palette → *Open Claude Code in tmux/psmux* (always multiplexer)
- **Per-session override** (right-click a saved session): *Resume in Webview* or
  *Resume in tmux/psmux*.

### Session lifecycle
By default (`kill-on-close`), closing the launcher tab also kills the tmux/psmux session
so claude is fully cleaned up — same lifecycle as the Webview backend, no zombies.

For external attach workflows, switch *Multiplexer Lifecycle* to `Leave detached`:
- The session survives the tab close. Re-attach from any terminal with
  `tmux attach -t cli-launcher-XXXXXXXX`.
- Use *Clean Up Detached Multiplexer Sessions* (command palette) to nuke them in bulk
  when you're done.

If `tmux` / `psmux` isn't on `PATH`, the multiplexer setting silently falls back to the
Webview backend with a one-time info message; no broken UI surfaces.

## Settings reference

All settings live under `claudeCodeLauncher.*`. The most relevant ones:

| Key | Purpose | Default |
|---|---|---|
| `terminal.defaultBackend` | `webview` or `multiplexer` | `webview` |
| `terminal.multiplexerLifecycle` | `kill-on-close` or `detached` | `kill-on-close` |
| `multiplexer.preferred` | `auto` / `tmux` / `psmux` / `none` | `auto` |
| `defaultTheme` | one of 7 themes | `default` |
| `defaultFontSize` | 8–22 | `11` |
| `defaultFontFamily` | CSS font stack | D2Coding-first |
| `soundEnabled` / `particlesEnabled` | UI polish toggles | `true` / `true` |
| `autoEffortMax` | auto-promote to /effort max | `false` |
| `customButtons` | extra slash-command shortcuts | `[]` |
| `customSlashCommands` | autocomplete additions | `[]` |
| `fileAssociations` | per-extension open method | sensible defaults |
| `pasteToFileThreshold` | paste size that auto-creates a file | `2000` |

The same picks (Default Terminal, Multiplexer Lifecycle, Theme, Font, etc.) are
available in the in-app Settings modal, so most users never need to leave the launcher.

## Commands

Frequent ones (more in the command palette under the *Claude* category):

- *Open Claude Code* / *Open Claude Code in tmux/psmux* — launch with explicit backend
- Right-click in Sessions tree:
  - *Move to Group…* (with indented picks for nested groups + *New Sub-Group…*)
  - *Add Sub-Group* (depth ≤ 3)
  - *Resume in Webview* / *Resume in tmux/psmux*
  - *Rename Group* / *Delete Group* (descendants follow automatically)
- *Show CCG* / *Refresh CCG* / *Rerun CCG* (OMC mode)
- *Show HUD Snapshot* (OMC mode)
- *Clean Up Detached Multiplexer Sessions*

## Architecture overview

```
extension.js              ← thin re-export
└─ src/activation.js      ← v2.6.x JS lifecycle, command registrations
└─ src/panel/             ← Webview terminal (xterm.js + node-pty / mux client)
└─ src/tree/              ← Sessions sidebar (drag-and-drop, nested groups)
└─ src/handlers/          ← open-file, paste-image, brace expansion, …
└─ src/orchestration/     ← TS, OMC integration layer (loaded lazily)
   ├─ core/OMCRuntime.ts  ← detect ~/.omc + omc CLI
   ├─ core/omcMode.ts     ← context key + status bar + onboarding
   ├─ core/StateWatcher.ts ← .omc/state/hud-stdin-cache.json
   ├─ core/CcgArtifactWatcher.ts
   ├─ core/multiplexerLauncher.ts (legacy detached path)
   ├─ backends/Tmux|PsmuxBackend.ts
   ├─ ui/HUDStatusBarItem.ts
   ├─ ui/CcgTreeProvider.ts + CcgViewerPanel.ts
   └─ webview/ccg-viewer-main.ts (esbuild bundled)
```

The v2.6.x JavaScript core is unchanged — orchestration code is added on top via
`require('./out/orchestration')`, so users without OMC see exactly the v2.6.6
launcher.

## Versioning & history

- **v3.0.0** — OMC integration arc: TS+esbuild toolchain, multiplexer abstraction
  (tmux/psmux), OMC mode, CCG viewer, HUD status bar, optional multiplexer terminal,
  brace-expanded path opening, nested session groups (max depth 3), in-app settings UI.
- **v2.7.25** — final v2.6.6 deprecation marker (when this repo briefly forked to
  Podium). The Podium experiment is now [archived at v0.16.0](https://github.com/rockuen/podium/releases/tag/v0.16.0)
  and active development returned here on 2026-04-26.
- **v2.6.x** — stable launcher (status icons, session save/restore, themes, ctx bar,
  custom buttons, drag-and-drop). All of that still ships unchanged inside v3.0.

Full changelog: [`CHANGELOG.md`](./CHANGELOG.md).

## License

[MIT](./LICENSE). Made by [@rockuen](https://github.com/rockuen).
