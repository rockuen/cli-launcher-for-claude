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

<p align="center">
  <a href="./README.ko.md">한국어 README</a>
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
- Slash command autocomplete (type `/` → suggestions). Ships with the full
  Claude Code built-in catalog (`/compact`, `/clear`, `/resume`, `/usage`,
  `/effort`, `/output-style`, `/statusline`, `/security-review`, `/agents`,
  `/mcp`, `/hooks`, `/permissions`, …). User-defined entries via
  `customSlashCommands` are merged in; personal PKM/OMC catalogs can be
  wired in via the gitignored override file (see §_Registering your own slashes_).
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

### Multi-account
- Save the current Claude login as a profile and switch between accounts without going
  through the full `/logout` + `/login` browser dance each time. Snapshots live under
  `~/.claude/account-switcher/<slug>/`. Active-profile detection cascades through
  credentials hash → `accountUuid` → `userID + email` → email, so Anthropic's background
  token rotation doesn't silently "unsave" the active profile.
- Open the switcher: **command palette → *Switch Claude Account…*** or the
  *Switch Account…* button in the settings modal (⚙). First save asks once for
  consent (OAuth tokens are copied in plain text — same format Claude CLI uses on disk).
- Lifted from [`rockuen/claude-account-switcher`](https://github.com/rockuen/claude-account-switcher)
  v0.1.1, which forks the snapshot mechanism from
  [`vishalguptax/claude-manager`](https://github.com/vishalguptax/claude-manager). Both
  upstream credits live in the `NOTICE` file (Apache-2.0).

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
  *That cache is written by whatever script is registered as Claude Code's `statusLine`
  command (OMC's `omc-hud.mjs` is the canonical producer); without it the HUD bar
  stays idle.*
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

## Registering your own slashes

The autocomplete dropdown ships with the full Claude Code built-in catalog,
plus the user-editable `customSlashCommands` list in Settings. For a fixed
personal catalog (your own `.claude/commands/*.md` PKM project slashes, an
oh-my-claudecode skills set, or any other shared collection) you can drop an
**override file** that the extension picks up at startup.

### Quick setup — paste this into Claude Code

If you run cli-launcher inside the source repo (or a fork), open a Claude
Code session in that repo and paste the prompt below. Claude will scan your
local environment and produce `src/lib/slashRegistry.local.js` with PKM +
OMC catalogs filled in:

```
Generate src/lib/slashRegistry.local.js for cli-launcher-for-claude.

Scan:
1. The current Obsidian vault / project at `~/path/to/your/vault` for
   `.claude/commands/*.md`. For each file extract `name` and `description`
   from the frontmatter (fall back to a humanized form of the filename
   when the description is empty). These become PKM_COMMANDS — cmd
   `/<name>`, desc { ko, en }.
2. The installed oh-my-claudecode skills at
   `~/.claude/plugins/cache/omc/oh-my-claudecode/<version>/skills/*/SKILL.md`.
   For each skill take the `description` line. These become OMC_SKILLS —
   cmd `/oh-my-claudecode:<skill>`, desc { ko, en }.
3. From CLAUDE.md (or memory), pick out the short OMC aliases the user
   actually types (e.g. `/ccg`, `/team`, `/ralplan`, `/deep-interview`,
   `/omc-setup`, `/omc-doctor`). These become OMC_ALIASES.

Schema for every entry: `{ cmd: '/foo', desc: { ko: '한국어', en: 'English' } }`.
Translate Korean ↔ English where one side is missing. Export
`module.exports = { PKM_COMMANDS, OMC_ALIASES, OMC_SKILLS }`.

Don't change `src/lib/slashRegistry.js` — only create the .local.js sibling.
```

Reload the extension (`Developer: Reload Window`) and the autocomplete
dropdown picks up the new entries automatically. Each catalog is tagged in
the description: `[PKM] …`, `[OMC alias] …`, `[OMC] …`, so you can filter
by typing the tag.

### Manual override

If you'd rather hand-edit, create `src/lib/slashRegistry.local.js`:

```js
const PKM_COMMANDS = [
  { cmd: '/blog', desc: { ko: '블로그 글', en: 'Blog post' } },
  { cmd: '/idea', desc: { ko: '아이디어 추출', en: 'Capture idea' } },
];

const OMC_ALIASES = [
  { cmd: '/ccg', desc: { ko: 'Codex+Gemini 리뷰', en: 'Codex+Gemini review' } },
];

const OMC_SKILLS = [
  { cmd: '/oh-my-claudecode:autopilot',
    desc: { ko: '자율 실행', en: 'Autopilot full autonomous run' } },
];

module.exports = { PKM_COMMANDS, OMC_ALIASES, OMC_SKILLS };
```

The file is in `.gitignore` so it never lands in the published vsix.
Toggle each catalog independently:

| Setting | Default | Effect |
|---|---|---|
| `claudeCodeLauncher.slashRegistry.includeBuiltinExtras` | `true` | Show the extra Claude Code built-ins (`/resume`, `/usage`, `/effort`, …) |
| `claudeCodeLauncher.slashRegistry.includePkm` | `true` | Show `[PKM]`-tagged entries from your override |
| `claudeCodeLauncher.slashRegistry.includeOmc` | `true` | Show `[OMC]` / `[OMC alias]` entries from your override |

When no override file is present, the public build only contributes the
built-in extras toggle — your dropdown stays clean.

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
| `slashRegistry.includeBuiltinExtras` | extra Claude Code built-ins in autocomplete | `true` |
| `slashRegistry.includePkm` | `[PKM]`-tagged entries from override file | `true` |
| `slashRegistry.includeOmc` | `[OMC]`-tagged entries from override file | `true` |
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
