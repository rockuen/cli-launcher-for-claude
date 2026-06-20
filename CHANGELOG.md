# Changelog

## [3.12.0] - 2026-06-19

### Added
- **Chief as the 6th launcher agent.** Added a bundled `chief-repl` Node wrapper that runs Chief REST chats inside a PTY tab, polls asynchronous Chief responses, records launcher-owned transcripts, and resumes by the launcher session id.
- **Chief session integration.** Added Chief detection, project/global transcript storage, reader parsing, split and unified Sessions support, status icons, and settings for API key, project id, base URL, intelligence, and provider.
- **Chief writing profile and presets.** Added a `chief.profile` setting with `general` and `writing` modes. Writing mode prepends a conversation/writing assistant profile, and Chief panels now expose Chief-native slash presets: `/wash`, `/reply`, `/doc`, `/tone`, and `/shorten`.

### Changed
- **Chief defaults are easier to tune from Settings.** Settings → Agent → Chief now shows Profile alongside Intelligence and Provider. Chief panels show Chief-specific slash commands instead of Claude-only commands.
- **Chief icon consistency.** Chief session rows now use the Chief SVG agent icon instead of the generic comment icon.

### Security
- Chief PATs are read only from machine-scoped VS Code settings or `CHIEF_API_KEY` and are passed through process env. They are not written to launcher metadata or transcripts.

### Tests
- Added Chief coverage for registry detection, resolver behavior without credentials, project env injection, direct session path resolution, transcript parsing, and session listing.

## [3.11.2] - 2026-06-18

### Changed
- **Grok visual refresh.** Replaced the provisional Grok status glyphs with the Grok mark across idle/running/done/error/shell states, and switched the Grok panel input theme from green to black/dark.
- **Grok reader layout.** Grok panels now open with a narrower terminal by default, and the reader split slider/drag cap now reaches 95% for long reader-focused sessions.

### Fixed
- **Grok running tab icon color.** The Grok running/thinking tab icon now uses the shared yellow running color instead of the done-state green.

### Tests
- Added a regression test that verifies the Grok running icon stays yellow and distinct from the Grok done icon.

## [3.11.1] - 2026-06-18

### Added
- **Grok CLI agent support.** Added xAI Grok CLI (`grok`) as a first-class launcher agent with detection, new-session/resume commands, unified and split Sessions integration, enabled-agent filtering, reader names, status icons, and a Grok Green input theme.
- **Grok session reader integration.** Grok sessions are discovered from `~/.grok/sessions/<encoded-cwd>/<session-id>/`, resume via `grok --resume <session-id>`, and reader parsing uses `updates.jsonl` visible user/agent chunks while titles come from `summary.json`.

### Changed
- **Project-scoped Grok home.** Project session mode now creates a virtual `GROK_HOME` under `.agent-sessions/.home/grok`, links its `sessions` directory to `.agent-sessions/grok`, and reuses the real Grok auth/config surfaces without overriding `HOME`.
- **Grok TUI handling.** The webview strips combined mouse-tracking sequences such as `?1003;1006h`, keeps Grok scrollback disabled for full-screen redraw stability, and pins the live frame after `2J` redraws and synchronized-output bursts.

### Tests
- Added Grok coverage for registry detection, project session environment, session listing/resolution/parsing, reader names, tab titles, submit input behavior, and tree integration.

## [3.11.0] - 2026-06-18

### Added
- **Search sessions by name in the unified Sessions view.** A new **🔍 Search** button in the Sessions view title (and the `CLI Launcher: Search Sessions` command) filters the tree to sessions whose title contains the typed text (case-insensitive). Matching groups auto-expand, non-matching sessions and now-empty groups are hidden, and the active query is shown above the tree (`🔍 "…"`). A **✕ Clear** button appears while a filter is active (also the `CLI Launcher: Clear Session Filter` command). Grouped / archived / Resume-Later / Trash sessions are searched too, and the **full** session title is matched even when the row label is truncated to 40 chars. Works in both the unified and split (per-agent) views.
- **"New Session" button is back in the Sessions view title — to the left of the ⚙ Settings button.** Clicking it shows a **model picker** (the enabled + installed agents: Claude / Kiro / Antigravity / Codex) and opens a new session with the chosen model. When only one agent is available the picker is skipped and that agent launches directly; Esc cancels. Backed by the new `CLI Launcher: New Session` command.

### Implementation
- `tree/SessionTreeDataProvider.js`: `setFilter()` (normalizes + bypasses the refresh debounce), `_matchesText()` (case-insensitive substring), and a `_noMatchRow()` placeholder shown when a filter matches nothing (instead of the misleading empty-view welcome). `_buildGroups` filters the leaf set before grouping so empty groups collapse out and the rest force-expand while filtering; `_buildAgentGroups` (split kiro / codex / antigravity views) filters its `itemMap`. Session / trash / other-agent leaves now carry `_searchText` (full title) for matching past the label truncation.
- `activation.js`: `newSessionPick` (routes through `pickAgent` → `createPanel`), `searchSessions` (input box → shared `setFilter` across every session provider + `sessionFilterActive` context key + a view-title message), and `clearSessionFilter`.
- `package.json`: three new commands; the unified Sessions `view/title` is ordered **+ New · ⚙ Settings · 🔍 Search · ✕ Clear** *(only while filtering)* **· ↻ Refresh**. `i18n/en|ko`: search + picker prompt strings.

### Tests
- 356 node passing (349 + 7 new source-level invariants covering the filter normalization / match, the no-match row, the split-view filter, `_searchText`, the new commands + `sessionFilterActive` wiring, the i18n keys, and the new-session-left-of-settings view-title placement).

## [3.10.5] - 2026-06-17

### Fixed
- **Cross-device session metadata loss (groups / titles dropped after sync).** The open-tab set (`claudeSessions` — each tab's cwd / viewColumn / order) was stored in the **git-synced** `.claude-launcher/sessions.json` alongside the shared group / title / Resume-Later / Trash metadata. Open tabs are inherently per-machine, so every device rewrote that file on each tab change; the resulting churn meant a `git pull` on another device frequently conflicted on `sessions.json`, and whole-file conflict resolutions silently discarded freshly-added groups / titles (blank-string ids and `"": N` sort-order entries also accreted from line-merges). Open-tab state now lives in **device-local `workspaceState`** (never synced), so the file changes only on deliberate metadata edits — pulls fast-forward cleanly and group / title additions propagate. Cross-device hand-off remains via **Resume Later** (`claudeSavedSessions`), which stays in the shared store.

### Changed
- **`sessions.json` is now written deterministically (sorted keys) and sanitized on every write.** Identical logical state serializes byte-identically across devices, eliminating spurious diffs / 3-way-merge noise; the sanitizer drops blank/duplicate ids inside `*SessionGroups`, the blank `""` key from `*SessionSortOrder` / `*SessionParent`, and de-dupes `claudeSavedSessions` / `claudeArchivedSessions` by sessionId — healing corruption left by earlier merges.
- **One-time migration:** on activate, a legacy `claudeSessions` key still present in `sessions.json` is moved into this device's `workspaceState` (only when empty, so live local tabs are never clobbered) and evicted from the synced file.

### Implementation
- `store/sessionStore.js`: new `deviceLocalGet/Set` (workspaceState via `state.context`), `stableStringify` (recursive key sort), `sanitizeStore`, `sessionStoreDelete`, a shared atomic `writeStore`, and the reverse migration in `migrateFromWorkspaceState`. `store/sessionManager.js` + `activation.js` (deactivate) now read/write `claudeSessions` via the device-local helpers instead of the synced store.
- Workspaces that sync `sessions.json` via git should add `.claude-launcher/sessions.json text eol=lf` to `.gitattributes` (kills CRLF churn under `core.autocrlf=true`).

### Tests
- 349 node + 54 vitest passing. New `test/unit/sessionStore.test.ts` (5 cases — deterministic serialization; group / sort-order / saved-archived sanitize; sanitized+sorted disk write; device-local `claudeSessions` migration).

## [3.10.4] - 2026-06-17

### Added
- **NoteWise Editor as a file-association target.** The File Associations setting now accepts a `notewise` open method that opens the file in the NoteWise Markdown Editor custom editor (`vscode.openWith` → `notewise.editor`). It's selectable in the settings panel's open-method dropdown alongside Obsidian / IDE Editor / System, so `.md` clicks (or any extension) can be routed straight to NoteWise.

### Fixed
- **Kiro terminal now scrolls with the mouse wheel.** Kiro sessions had their xterm scrollback pinned to `0` — a v3.7.13 workaround for a "jump to top" drift on older kiro builds that `2J`-cleared the whole screen every frame — so the wheel had no history to scroll and users were forced into the reader view. Kiro 2.6.x repaints via synchronized output (`?2026`) instead of full `2J` redraws, so that drift no longer applies: kiro now uses the standard **5000-line scrollback** like every other agent, and the wheel scrolls history exactly as it does in PowerShell / Windows Terminal. Output auto-scroll also now respects the "was at bottom" check for kiro, so scrolling up to read history stays put instead of being yanked back down.

## [3.10.3] - 2026-06-16

### Fixed
- **kiro-cli sessions now honor project-scoped storage on Windows.** With `sessionStorage.scope` set to `project`, kiro sessions were still written to the global `~/.kiro/sessions/cli` on Windows because kiro-cli resolves its home via `SHGetKnownFolderPath` (the real user profile) and ignores the `HOME`/`USERPROFILE` the launcher injects. The kiro launch env now sets **`KIRO_HOME`** explicitly to the project virtual `.kiro` (whose `sessions/cli` is already linked to `<workspace>/.agent-sessions/kiro`), so kiro stores sessions per-project. macOS/Linux are unaffected (they already honor `$HOME`); `KIRO_HOME` is set only in the kiro branch, leaving Codex/Antigravity env untouched. This removes the need for the global-junction workaround.

## [3.10.2] - 2026-06-16

### Changed
- **Desktop notification title now reads "CLI Launcher" instead of "Claude Code".** The OS toast shown when a session needs attention used a hard-coded "Claude Code" headline; it now shows **CLI Launcher** as the title on both Windows (toast headline + notifier app id) and macOS (`display notification … with title`). The notification body (the session tab title) is unchanged.

## [3.10.1] - 2026-06-15

### Changed
- **Sessions view title shows the Settings (gear) button instead of "Open Claude Code".** The unified **Sessions** view title bar now uses the same **⚙ Settings** button already present in the **Quick Actions** view (`claudeCodeLauncher.openSettings`, which opens the global settings panel) in place of the "Open Claude Code" button. The `claudeCodeLauncher.open` command itself is unchanged and still reachable from the Command Palette; the editor-title icon and `Ctrl/Cmd+Shift+;` keybinding (both use `openTerminal`) are unaffected. New sessions can still be started from Quick Actions, the editor-title icon, the keybinding, or the Command Palette. Split-mode per-agent views are unchanged.

## [3.10.0] - 2026-06-15

### Added
- **Unified "Sessions" view.** All four agents (Claude, Codex, Kiro, Antigravity) now appear in a single **Sessions** tree instead of four separate per-agent views, with every session badged by its **model icon** so you can tell at a glance which agent it belongs to. The existing structure — Recent / custom groups / Resume Later / Trash — is preserved, and sessions from all agents interleave by recency inside it.
- **`claudeCodeLauncher.sessionViewMode` setting** (`unified` default | `split`). `unified` merges every agent into one tree; `split` keeps the legacy per-agent views (Claude Sessions / Codex Sessions / Kiro Sessions / Antigravity Sessions). Switching applies live (no reload). The unified header's robot icon opens a new session via the agent picker.

### Changed
- The unified view **reuses Claude's group / Resume Later / Trash store**, so existing Claude groups carry over with no migration; non-Claude sessions join the same store keyed by their own id.

### Notes
- In the unified view, non-Claude (Kiro/Codex/Antigravity) sessions support view / resume / rename / move-to-group / reorder. Sub-session **nesting** and **trash** stay scoped to the `split` views (a guard blocks claude-only trash/restore from acting on a foreign file), so no data can be silently lost.

### Tests
- Added unified-mode source invariants; full suite **344 node + 54 vitest** passing.
## [3.9.5] - 2026-06-14

### Added
- **Project-scoped session storage for Codex, Kiro, and Antigravity.** New setting `claudeCodeLauncher.sessionStorage.scope` can be set to `project` so launcher-run non-Claude sessions use `<workspace>/.agent-sessions/<agent>` instead of the global CLI homes. This separates Won/iloom histories without OneDrive live-sync junctions. Default remains `global` for full backward compatibility.

### Changed
- **Project virtual homes for agent CLIs.** In project mode, the launcher creates per-workspace virtual homes under `.agent-sessions/.home` and links/copies only the CLI config/auth surfaces needed for Codex, Kiro, and Antigravity to run while keeping sessions project-local.
- **Kiro trash/restore paths follow session scope.** Kiro session delete/restore now resolves the selected project/global session directory instead of hardcoding the global CLI sessions path.

### Tests
- Added `test/unit/projectSessions.test.ts` covering global vs project path resolution, virtual-home setup, and PTY env integration points. Full suite: 339 node + 54 vitest passing.

## [3.9.4] - 2026-06-14

### Added
- **Per-agent tab status icons.** Each session tab now shows its agent's own logo — Claude spark, Codex blossom, Kiro ghost, Antigravity wing — tinted by status (gray idle, yellow running, green done, red error, blue background-shell). `setTabIcon` resolves `{agent}-{status}.svg` from the panel's agent and falls back to the Claude icon when an agent has no dedicated set yet.
- **Reader handoff button.** A handoff (⇄) button now sits in the reader toolbar (left of the reader toggle) and invokes the existing hand-off-to-another-agent command.

### Changed
- **Codex context indicator shows usage (0→100%)** like Claude/Kiro instead of remaining — green below 50%, yellow at 50%+, red at 80%+.
- **Input-box submission hardened for Claude & Codex.** The editor input sends the text and the Enter key as one deferred sequence so the TUI reliably registers the submit instead of leaving the line unsent.

## [3.9.3] - 2026-06-12

### Fixed
- **Reader view Ctrl+C copy not working.** The document-level Ctrl+C handler only checked xterm's internal selection, missing DOM selections in the reader area. Now falls back to `window.getSelection()` so text dragged in the reader copies correctly.

### Changed
- **Removed FS (fullscreen) indicator button.** Mouse-mode escape sequences are already stripped before reaching xterm.js, making the toggle redundant. The redraw button (↻) remains available when a TUI owns the screen.
- **Sidebar view order** changed from Claude/Kiro/Antigravity/Codex to **Claude/Codex/Kiro/Antigravity**.

## [3.9.2] - 2026-06-12

### Fixed
- **Codex input panel Enter not submitting.** The launcher input bar sent text and `\r` as separate PTY messages; Codex TUI accepted the text but missed the trailing Enter. Now sends `text + \r` as a single atomic payload.
- **Kiro/Codex/Antigravity session title not restored on resume.** Tree-resume passed no title to `createPanel`, so tabs always opened with the default agent label. Now reads the saved title from the per-agent title store and passes it through.
- **Antigravity rename not persisting.** Fresh/`--continue` sessions kept a placeholder UUID as sessionId, so `saveSessions()` wrote the title under a key the tree never looked up. On rename, the real conversation id is now resolved from the history and pinned.

### Improved
- **Codex context indicator shows remaining capacity** (green → yellow → red as it depletes), matching Codex's own "remaining" semantics instead of Claude's "used" semantics.
- **Kiro fresh-session Reader race fix.** Pre-existing session ids are now snapshot *before* PTY spawn (not after), with a 1-second discovery retry interval, preventing the race where a fast Kiro session creation was misidentified as pre-existing.
- **Kiro context parsing.** Added a Kiro-specific TUI status-line parser (`Kiro auto 2%` pattern) so Kiro context usage is displayed in the status bar.

## [3.9.1] - 2026-06-10

### Fixed
- **"Webview is disposed" crash storm on every tab close — and the freeze trigger it fed.** Closing a tab killed the ConPTY *without detaching its data listener*; the kill flushes the pty's remaining buffered output, so every late chunk re-entered `onData` on the already-disposed panel, where the `panel.active` getter throws. Live logs showed two thrown errors plus an "An unknown error occurred" toast on **every** tab close, and the 2026-06-10 extension-host freeze fired at exactly this point while closing a ~7-hour session whose pty had delivered 97,535 chunks. The panel now disposes the PTY data subscription **before** killing the pty (both the panel-dispose and the session-restart paths), and both `onData` handlers gained an `entry._disposed` early-return alongside the existing stale-pty guard. `onExit` stays attached so exit bookkeeping (state, session save) still runs.

### Implementation
- `panel/createPanel.js`: the onData subscription is kept on `entry._ptyDataSub`; `onDidDispose` disposes it first. `panel/restartPty.js`: detaches the previous subscription before killing the old pty, registers the new one the same way, and its `onData` now also checks `entry._disposed`. `lib/ptyChunk.js` already tolerated dispose-mid-flush (isDisposed check + try/catch around postMessage), so paced sends needed no change.

## [3.9.0] - 2026-06-09

### Added
- **Find files anywhere via the OS file index.** When a reader/terminal file link can't be resolved from the session's working directory (or its subfolders), the launcher now falls back to the OS file index to locate the file anywhere on disk and open it — so a bare filename an agent printed (e.g. `_merged_erp_inbound.csv` written to some output folder) opens with a click instead of dead-ending at "file not found". One exact-name hit opens immediately; several show a QuickPick; none falls back to the usual message. Strictly additive: turn it off with `claudeCodeLauncher.fileLocator.enabled`, and with no backend installed behaviour is unchanged (one extra `existsSync` probe on a miss). Backends: **Everything `es.exe` on Windows**, **Spotlight `mdfind` on macOS** (built in), **`plocate`/`locate` on Linux**. Exact-basename matches only; `$Recycle.Bin`, `node_modules`, and `.git` paths are filtered out; the index is over-fetched then filtered + capped so a small result limit can't be consumed by noise.

### Settings
- `claudeCodeLauncher.fileLocator.enabled` (default true), `claudeCodeLauncher.fileLocator.esPath` (Windows es.exe path; blank = auto-discover from `%LOCALAPPDATA%\Programs\everything-cli` or `Program Files\Everything`), `claudeCodeLauncher.fileLocator.maxResults` (default 20).

### Implementation
- New `src/lib/fileLocator.js`: pure `parseLocatorOutput` / `buildEsArgs` / `buildMdfindArgs` / `buildLocateArgs` + IO `resolveEsBinary` / `locateFiles` / `isLocatorAvailable` (all via `execFile`, no shell; 3s timeout; never throws — failures return `[]`). `handlers/openFile.js`: `handleOpenFile` is now async and runs `tryLocateOnDisk` as the last fallback (after cwd-resolve + the cwd basename walk), with a QuickPick on multiple hits and a fragment-suffix narrowing pass. `panel/messageRouter.js`: the `open-path` case hands a cwd-resolve miss to `handleOpenFile` so the index fallback runs.

### Tests
- 320 node + 54 vitest passing. New `test/unit/fileLocator.test.ts` (11 cases — exact-basename match, `.lnk` / recycle-bin / node_modules / .git filtering, case-insensitive dedupe + cap, arg builders). Verified end-to-end against a real `es.exe` on Windows (the `_merged_erp_inbound.csv` case → exactly one hit, three `.lnk` shortcuts filtered).

## [3.8.2] - 2026-06-08

### Added
- **macOS Keychain backend for multi-account switching.** On macOS, Claude Code stores its OAuth tokens in the login Keychain (service `Claude Code-credentials`), not in `~/.claude/.credentials.json` — so the file-based account switcher always saw "no active account" and could neither save nor switch profiles on a Mac. The switcher now reads and writes the live credentials through the Keychain (`security` CLI) on macOS and through the file elsewhere, chosen by a `credsBackend()` helper (override with the `CLI_LAUNCHER_CREDS_BACKEND` env var). Saved-profile snapshots and `.claude.json` stay plain files on every OS; only the *live* credentials transport is backend-aware. `switchProfile` swaps `.claude.json` (file rename + rollback) and then writes the Keychain, restoring the identity file if the Keychain write fails so the pair never ends up split (identity from one account, tokens from another).

### Changed
- **README rewritten (English + Korean) for the 4-agent scope.** The intro, a new "four agents" section, the feature list, and the honest-notes now cover Claude / Codex / Kiro / Antigravity instead of Claude only — each agent's reader support, input tone, and permission toggle laid out in a table — and stale version/command references were corrected. The Korean README keeps its first-person narrative voice.

### Implementation
- New `src/account/liveCreds.ts`: `credsBackend` / `readLiveCredsRaw` / `writeLiveCredsRaw` / `liveCredsExist` over `security find/add-generic-password` (run via `execFileSync`, no shell; the `-U` write reuses the existing item's account name so it never forks a duplicate). `profiles.ts`: a backend-aware `liveCredsHash` plus `readLivePairRaceSafe` / `readLiveIdentity` / `getActiveProfileSlug` / `syncActiveProfile`, and an `applyLiveSwap` dispatcher (file two-file swap vs `.claude.json`-then-Keychain swap, both with rollback).

### Tests
- 309 node + 54 vitest passing. New `test/account/liveCreds.test.ts` (15 cases — backend selection, Keychain read/write/exist round-trip via a mocked `security`, file fallback) and 3 new Keychain-switch cases in `profiles.test.ts` (write into the Keychain, `.claude.json` rollback on write failure, active-slug via the Keychain secret); the existing 36 profile cases are pinned to the file backend.

## [3.8.1] - 2026-06-05

### Changed
- **Rebranded to "CLI Launcher for Claude, Codex, Kiro & Antigravity".** The display name, description, in-app messages (`Claude Launcher:` → `CLI Launcher:`), command-palette titles, account-save notice, and README now reflect the 4-agent scope instead of Claude only. The extension id (`cli-launcher-for-claude`), all settings keys (`claudeCodeLauncher.*`), and the repository are intentionally unchanged, so existing installs, settings, and sessions carry over untouched.

### Notes
- Display/branding only — no functional code changes from 3.8.0.

## [3.8.0] - 2026-06-05

### Added
- **Codex (OpenAI) CLI as the 4th agent.** Full integration alongside Claude / Kiro / Antigravity: auto-detection, a dedicated **"Codex Sessions"** sidebar view, new-session + resume (`codex resume <id>`), a **live reader pane** (rollouts are jsonl, so the conversation renders), and handoff to/from Codex. Enable it in **Settings → Agent** — the view appears once Codex is installed + enabled. Codex stores sessions as `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`; the AI tone is **slate** (the only achromatic agent, matching OpenAI's identity).
- **Codex bypass toggle.** Settings → Agent → Codex → **"Bypass approvals + sandbox"** runs Codex with `--dangerously-bypass-approvals-and-sandbox` (skips all approval prompts and sandboxing). Off by default; **EXTREMELY DANGEROUS** — use only on trusted work. Mirrors the Kiro/Antigravity trust toggles.
- **Customizable reader sender names.** `claudeCodeLauncher.readerNames`: one global **"your name"** shown for your messages in every reader, plus a **per-agent AI name** (Claude / Kiro / Codex). Set them in Settings → Agent. Empty values fall back to "You" and the agent's label; names render verbatim (no forced uppercase) and are HTML-escaped.

### Fixed
- **Codex reader for restored + new sessions.** A restored Codex session — and the first new session opened after it — could show an empty reader: a restored session carries a real rollout id but no resume flag, so it stayed in fresh-discovery mode, never matched itself, and hijacked the next session's rollout. Sessions whose id resolves on disk now pin immediately, and spawn args use `resume <id>` so the terminal and reader stay in sync.
- **Codex Sessions tree refresh.** New Codex sessions now appear in the sidebar automatically (the shared tree-refresh helper was missing the Codex provider). Codex tab renames + exact-resume flags now persist across a window reload.
- **Defensive panel setup.** A throw in session-save / reader-watch can no longer abort wiring up a panel's PTY output handlers — previously this left a spawned terminal with a blinking cursor and no output.

### Implementation
- `agents/registry.js` + `pty/resolveCli.js`: `resolveCodexCli` + codex registry entry. `lib/sessionJsonl.js`: `listCodexSessions` / `findCodexSessionPath` + codex extraction (reads `event_msg` user/agent turns only — `response_item` duplicates assistant text and carries `<environment_context>`). `tree/SessionTreeDataProvider.js` + `activation.js` + `panel/createPanel.js` + `panel/restartPty.js`: Codex Sessions view, spawn, fresh-id pinning, bypass flag. `lib/readerRender.js`: `resolveReaderNames` + `renderBlocks` `names` option; `.role` uppercase dropped.

### Tests
- 309 node + 36 vitest passing (codex registry / codexSessions / readerNames suites added).

## [3.7.20] - 2026-06-04

### Changed
- **Hand off to any agent, not just claude↔kiro.** "Hand off to other agent" now lets you pick the target from **all enabled+installed agents other than the current one** (Claude / Kiro / Antigravity) instead of a fixed claude↔kiro toggle. With exactly one other agent it hands off directly; with two+ it shows a picker; with none it tells you to enable another agent in Settings → Agent. Esc cancels silently.

### Notes
- Handing off **to** Antigravity works (the note is injected into the agy prompt). Handing off **from** Antigravity isn't supported yet — agy transcripts are protobuf-in-SQLite (no jsonl), so the conversation can't be extracted; that path now shows a clear message instead of a generic "session file not found".

### Implementation
- `handlers/pickAgent.js`: `pickAgent({ exclude, placeHolder })` — optional `exclude` drops an agent from the candidate list (returns null when nothing's left, rather than the claude fallback); backward-compatible no-arg call unchanged.
- `activation.js` (`handoffToOther`): target resolved via the eligible-others list + `pickAgent({ exclude: source })` instead of `agent === 'claude' ? 'kiro' : 'claude'`; antigravity-source gets a specific "extraction not supported yet" message.

### Tests
- 291 node + 36 vitest passing (command-wiring change; no test logic affected).

## [3.7.19] - 2026-06-04

### Changed
- **Robot icon → agent picker; in-session "+" → current session's agent.** Reverts the v3.7.15 "everything launches the default agent" behavior into two distinct affordances:
  - The **robot icon** (editor/title) — and the status bar / welcome link, which share `claudeCodeLauncher.open` — now show the **agent picker** again (Claude / Kiro / Antigravity). The QuickPick only appears when 2+ agents are enabled+installed; with one it launches that, with none it falls back to claude. Esc cancels.
  - The **in-session toolbar "+"** now opens a new tab with the **same agent as the current session** (`entry.agent`) — clicking "+" in a Kiro tab opens another Kiro tab, etc. — instead of always the default agent.

### Implementation
- `activation.js` (`claudeCodeLauncher.open`): restored `pickAgent()` when no agent is forced in `opts` (agent-scoped commands / `openInMultiplexer` still bypass it via `opts.agent`).
- `handlers/toolbar.js` (`new-tab`): `createPanel(..., { agent: entry.agent })` instead of `{}`.

### Tests
- 291 node + 36 vitest passing (no test logic affected — command-wiring change).

## [3.7.18] - 2026-06-04

### Fixed
- **Antigravity sessions now actually appear in the sidebar (real on-disk format).** The Phase 1 parser assumed each `history.jsonl` line carried a `conversationId`, but the real agy v1.0.5 format (verified on a logged-in machine) is `{ "display": "…", "timestamp": <epoch-ms>, "workspace": "…" }` with **no id** — the resumable id is the `conversations/<id>.db` *filename*. The old parser skipped every id-less line, so the Antigravity Sessions view was always empty. `listAntigravitySessions` now reads the metadata from `history.jsonl` and pairs it with the `.db` ids by recency rank (newest history entry ↔ newest `.db`); an explicit id on the line is still honored if a future build adds one. Verified against the real `history.jsonl` + `.db` (one session "테스트" → resumes via `agy --conversation <id>`).

### Implementation
- `lib/sessionJsonl.js`: `listAntigravitySessions(cwd, _file?, _convDir?)` rewritten — history metadata + `conversations/*.db` id pairing, recency-rank match, explicit-id fast path, `.db`-less → empty (no resumable id).

### Tests
- 291 node (+2, antigravity parser cases reworked to the real format: `.db`-id pairing, no-`.db` empty, explicit-id, field/timestamp drift, malformed, cross-OS) + 36 vitest passing.

### Notes
- Cross-device sync uses a OneDrive symlink of the CLI session dirs (same as Claude's `~/.claude/projects/<cwd>` → OneDrive). Kiro's dir was symlinked on this device; Antigravity's symlink + the macOS/other-device setup are documented as a manual per-device step.

## [3.7.17] - 2026-06-04

### Added
- **Antigravity bypass-permissions toggle.** Settings → Agent now has a "Bypass permissions (--dangerously-skip-permissions)" checkbox for Antigravity, matching Claude's bypass toggle and Kiro's trust-all-tools. Bound to `claudeCodeLauncher.antigravity.trustAllTools` (the config existed since Phase 0; this surfaces it in the UI). Applies to newly opened and restarted agy sessions.
- **Cross-device session sync via OneDrive symlink (Kiro + Antigravity).** The Kiro and Antigravity session lists now match the same workspace across operating systems, so sessions synced through a OneDrive-symlinked CLI session dir (the same way Claude's `~/.claude/projects/<cwd>` is symlinked to OneDrive) show up — and resume — on every device. The cwd filter falls back from an exact path match to the last two path segments (parent + leaf, case-insensitive), so a vault at `c:\Obsidian\Won's 2nd Brain` (Windows) and `/Users/<me>/obsidian/Won's 2nd Brain` (macOS) are treated as the same workspace, while unrelated `/my/project` vs `/other/project` still don't collide. (Setting up the OneDrive symlinks themselves is a per-device infra step, documented in the repo notes — no extension code routes the files.)

### Changed
- **Antigravity sessions open as a plain terminal, not split view.** Since agy has no reader yet (its transcripts are protobuf-in-SQLite), the split layout would only show an empty reader pane — so antigravity tabs now ignore `splitLayoutDefault` and open terminal-only. The per-tab 👁 toggle still flips it.

### Fixed
- **Antigravity session titles now persist.** `saveSessions()` only wrote claude/kiro titles to their per-agent title stores; antigravity titles were dropped, so a renamed agy tab didn't keep its name. Added the `antigravitySessionTitles` branch (+ persists `isAntigravityResume` across Reload Window so the exact `--conversation <id>` resume survives, like kiro's `--resume-id`).

### Implementation
- `panel/settingsPanel.js`: antigravity `--dangerously-skip-permissions` checkbox in the Agent category; `antigravityTrustAllTools` added to `globals` + `ALLOWED_GLOBAL_KEYS`.
- `panel/createPanel.js`: `splitLayoutDefault` forced `false` when `agent === 'antigravity'`.
- `lib/sessionJsonl.js`: `_cwdMatch()` (exact-normalized → last-two-segment fallback) used by `listKiroSessions` + `listAntigravitySessions`.
- `store/sessionManager.js`: `antigravitySessionTitles` write branch + `isAntigravityResume` persistence.

### Tests
- 289 node (+2) + 36 vitest passing. New cases: cross-OS basename/segment matching for both `listKiroSessions` and `listAntigravitySessions`; the existing exact-cwd filter test still passes (no over-match on shared leaf names).

## [3.7.16] - 2026-06-04

### Added
- **Antigravity CLI (`agy`) — Phase 1: sidebar session tree.** A dedicated **Antigravity Sessions** view (alongside Claude/Kiro), shown when `agy` is installed *and* enabled. It lists this workspace's `agy` conversations newest-first — each row is one conversation (keyed by its conversation id, labelled by the agy display title or your rename), filtered to the current folder. Click a row to resume it with `agy --conversation <id>`. Conversations can be grouped, reordered, nested, and renamed exactly like Kiro sessions, all under an antigravity-only store namespace. The card reader stays off for `agy` this phase (its transcripts are protobuf-in-SQLite, not jsonl) — that's a later phase.

### Implementation
- `lib/sessionJsonl.js`: `listAntigravitySessions(cwd, _file?)` parses `~/.gemini/antigravity-cli/history.jsonl` — dedupes by conversation id (append-only log → latest record wins), filters by cwd (drive-case + slash insensitive for Windows), sorts newest-first, and tolerates field-name drift (`conversation_id`/`cwd`/`title`/`updated_at`) + ISO/epoch-s/epoch-ms timestamps.
- `tree/SessionTreeDataProvider.js`: `antigravity` agentMode — `STORE_KEYS.antigravity` (fully separate group/parent/sortOrder/titles keys), `_buildAntigravitySessions()` (mirrors `_buildKiroSessions`, reuses `_buildAgentGroups`), `_loadSessionIds()` branch, antigravity-scoped DnD MIME pair, and `antigravitySession` recognized in `handleDrag`/`handleDrop`.
- `activation.js`: registers the `antigravitySessions` tree view + provider, `newAntigravity` command, `antigravityAvailable` context key (refreshed on `enabledAgents` change), `resumeSession` antigravity branch (`isAntigravityResume` → `agy --conversation <id>`), `providerForItem` + `moveUnderSession` routing.
- `panel/createPanel.js`: entry carries `isAntigravityResume` so a panel restart re-resumes via `--conversation <id>` (the spawn branches for `agy` already shipped in Phase 0). `state.js`: `antigravityTreeProvider` + `refreshSessionTrees()` includes it.
- `package.json`: `antigravitySessions` view (gated on `antigravityAvailable`), `newAntigravity` command + view-title `+`/refresh, and the session/group context-menu set (no Trash — agy's history.jsonl is an append-only log, not per-session files).

### Tests
- 287 node (+14 new) + 36 vitest passing. New `test/unit/antigravitySessions.test.ts` covers the parser (cwd filter, dedupe, field/timestamp drift, malformed/missing-file handling, Windows path matching) and the provider in `antigravity` mode (store-key isolation vs claude/kiro, group build + Recent Sessions, the conversation-resume command payload, nesting, DnD MIME scoping).

### Notes
- The `history.jsonl` path + line schema are from the work-PC handoff (agy v1.0.5). The parser is fixture-verified here; an end-to-end check needs a logged-in `agy` that actually writes the file (on a logged-out machine `agy` never creates it).

## [3.7.15] - 2026-06-04

### Added
- **Antigravity Spectrum theme.** A third input-area tone, alongside Claude (coral) and Kiro (purple), themed after the Antigravity logo — an azure (`#34c2e0`) accent on a deep teal-charcoal panel, with a rainbow-gradient swatch in the picker. `Auto` now resolves Antigravity panels to it automatically (Claude → coral, Kiro → purple, Antigravity → azure); the assistant role accent and the bottom input area both follow it. Pickable in the theme picker and Settings → Theme, and `defaultTheme` can pin it for every panel.

### Changed
- **The "new session" icon now launches your default agent directly — no agent QuickPick.** Clicking the editor-title icon, the toolbar `+`, the status bar, or the welcome link opens a session with the default agent (`claudeCodeLauncher.agent`) instead of prompting which agent to use each time. Set the default in **Settings → Agent → "Default for new sessions"** (the radio was already there; it's now what the new-session icons obey). To launch a *specific* non-default agent, use the per-agent **Quick Actions** header or the agent's session view `+`.

### Implementation
- `panel/webviewClient.js`: `antigravity` palette in `themes`; `IS_ANTIGRAVITY` threaded; `applyTheme('auto')` → `IS_KIRO ? 'kiro' : IS_ANTIGRAVITY ? 'antigravity' : 'claude'`; `initialPanelTheme` accepts `antigravity` as an explicit pin.
- `panel/webviewContent.js`: Antigravity entry in the theme picker (rainbow swatch) and the Settings theme select. `i18n/en.js` + `ko.js`: `themeAntigravity`. `package.json`: `defaultTheme` enum gains `antigravity`.
- `activation.js` (`open`) + `handlers/toolbar.js` (`new-tab`): drop the `pickAgent()` prompt; `createPanel` resolves the default agent from `claudeCodeLauncher.agent` when none is forced.

### Tests
- 273 node + 36 vitest passing; rendered the webview client for `antigravity`/`claude` and asserted the palette, `auto` resolution, `IS_ANTIGRAVITY` threading, picker/select options, and that `open`/`new-tab` no longer call `pickAgent`.

## [3.7.14] - 2026-06-04

### Added
- **Antigravity CLI (`agy`) as a third agent — Phase 0 (launch).** You can now run Google's Antigravity CLI in a launcher tab alongside Claude and Kiro. Enable it in **Settings → Agent** (opt-in, like Kiro), then pick **Antigravity** when opening a new session. Includes a per-agent **trust toggle** (`antigravity.trustAllTools` → runs `agy --dangerously-skip-permissions`). This phase covers launching/continuing sessions; the sidebar session tree and the card reader for `agy` come in later phases (its conversations are stored as protobuf-in-SQLite, not jsonl, so they need their own parser).

### Implementation
- `pty/resolveCli.js`: `resolveAntigravityCli()` — `~/.local/bin/agy` → `%LOCALAPPDATA%\agy\bin\agy.exe` (Windows installer) → PATH (absolute via `where.exe`, since node-pty needs it).
- `agents/registry.js`: `antigravity` entry (`agy`) — auto-surfaces in the Agent settings category and the new-session picker once enabled + installed.
- `panel/createPanel.js` + `panel/restartPty.js`: `agy` spawn branch — fresh `agy`, `--continue` (auto-restore), `--conversation <id>` (future Tree resume), `+ --dangerously-skip-permissions` when trusted.
- `panel/createPanel.js` + `lib/sessionJsonl.js`: reader is gated off for `antigravity` (no jsonl transcript yet).
- `package.json`: `agent` enum gains `antigravity`; new `antigravity.trustAllTools` config.

### Tests
- 273 node + 36 vitest passing; verified `resolveAntigravityCli` detects the installed binary, the registry exposes `antigravity`, and the reader path is gated.

## [3.7.13] - 2026-06-04

### Fixed
- **Kiro no longer drifts to the top of the terminal.** Kiro is a full-screen TUI that redraws in the *normal* buffer (`CSI 2J` + cursor-home, no alt-screen). The v3.7.3 fix tracked "is the user at the bottom?" via `onScroll`, but Kiro's own redraws scroll the viewport programmatically and `onScroll` can't distinguish that from a user scroll — so the follow flag flipped off and the view stuck at the top. The real fix is upstream: Kiro terminals now use `scrollback: 0`, giving them alt-screen-like behavior (repaint in place, no scrollback for stale frames to pile into and no room for the viewport to drift), plus an unconditional `scrollToBottom()` after each Kiro write. Claude's inline-output path is unchanged.

### Implementation
- `webviewClient.js`: `new Terminal({ scrollback: IS_KIRO ? 0 : 5000 })`; removed the `kiroStick`/`onScroll` follow flag; Kiro's output handler now `term.write(cleaned, () => term.scrollToBottom())`.

### Tests
- 273 node + 36 vitest passing; rendered the webview client for both agents and asserted the `scrollback` branch, the unconditional Kiro scroll-to-bottom, and that no `kiroStick` references remain.

## [3.7.12] - 2026-06-04

### Fixed
- **The per-agent input tone is back.** Choosing a theme once in Settings wrote `claude` or `kiro` to the global `defaultTheme`, which then pinned every panel — Claude tabs and Kiro tabs both showed the last-picked color instead of each following its own agent. Root cause: the theme picker only had explicit `Claude`/`Kiro` options, so there was no way to ask for "follow the agent," and any pick became a global override.

### Added
- **`Auto (agent)` theme** — now the default. Each panel follows its own agent (Claude → coral, Kiro → purple); `Claude`/`Kiro` remain as explicit pins for users who want one tone everywhere. The theme picker and Settings dropdown both lead with **Auto**.

### Implementation
- `webviewClient.js`: `initialPanelTheme` resolves non-`claude`/`kiro` values (incl. legacy `default`/`midnight`/…) to `'auto'`; `applyTheme()` maps `'auto'` → `IS_KIRO ? 'kiro' : 'claude'` per panel.
- `webviewContent.js`: `Auto` option added to the theme picker (split coral/purple swatch) and the Settings `set-theme` select.
- `package.json`: `defaultTheme` config rewritten from the stale background-theme enum (`default`/`midnight`/`ocean`/…) to `auto`/`claude`/`kiro`, default `auto`.
- `i18n/en.js` + `ko.js`: `themeAuto` label.

### Tests
- 273 node + 36 vitest passing; rendered the webview client for both agents and asserted the `auto` resolution, `IS_KIRO` threading, and explicit-pin guard.

## [3.7.11] - 2026-06-04

### Changed
- **The robot icon is now neutral gray instead of Claude coral.** The robot in the editor title bar (top-right), the activity-bar view container, and the command-palette entries all came from one coral (`#D97757`) `claude-robot.svg`. Now that the launcher hosts non-Claude agents, the icon is a theme-neutral gray so it no longer reads as "Claude" — agent identity is already carried by the per-agent input theme (Claude coral / Kiro purple). The command icons use a light/dark split because VS Code renders contributed command icons as-is without recoloring.

### Implementation
- `icons/claude-robot.svg`: coral `#D97757` → `#8B949E` (used by the dark-theme command icon + the masked activity-bar container icon).
- `icons/claude-robot-light.svg` (new): `#57606A` variant for light themes.
- `package.json`: the `open` / `openTerminal` command icons now point `light` → `claude-robot-light.svg`, `dark` → `claude-robot.svg` (activity-bar container stays `claude-robot.svg`, masked to the theme color anyway).

### Tests
- 273 node + 36 vitest passing (icon/manifest-only change; no test references the icon).

## [3.7.10] - 2026-06-04

### Changed
- **Status bar now says "Agent" instead of "Claude".** The IDE status bar item read `Claude Running` / `Claude Needs Attention` / `Claude Idle` (plus `Claude Done` / `Claude Error`, and `Claude Code` at rest), but the launcher now runs non-Claude agents (Kiro) too, so a hard-coded "Claude" was misleading. The status bar aggregates every open agent tab, so it now reads `Agent Running` / `Agent Idle` / `Agent Needs Attention` / `Agent Done` / `Agent Error`, with `Agent` as the resting (no-tabs) label — both EN and KO locales.

### Implementation
- `i18n/en.js` + `i18n/ko.js`: `sbIdle` / `sbRunning` / `sbAttention` / `sbDone` / `sbError` reworded Claude → Agent.
- `panel/statusIndicator.js`: the no-panel resting label `$(hubot) Claude Code` → `$(hubot) Agent`.

### Tests
- 273 node + 36 vitest passing (no test references the status strings; the unrelated `Claude Code` agent-label tests are unchanged).

## [3.7.9] - 2026-06-04

### Added
- **Kiro Sessions now has Recent Sessions and Trash, matching Claude Sessions.**
  - Ungrouped Kiro sessions are collected under a collapsible **Recent Sessions** header (they used to list flat at the root).
  - A 🗑 action on each Kiro session moves it to **Trash**; the Trash node lists trashed sessions, clicking one restores it, and the Trash header has **Empty Trash** (permanent delete, with a confirmation). Trashing moves the session's `.json` + `.jsonl` into `~/.kiro/sessions/cli/trash/`, so `kiro-cli` and the launcher stop listing it until you restore.

### Implementation
- `tree/SessionTreeDataProvider.js` `_buildAgentGroups()`: wrap ungrouped sessions in a `recentGroup` node; for kiro, append a `kiroTrashGroup` built from `~/.kiro/sessions/cli/trash` via `listKiroSessions(cwd, trashDir)`. New `_kiroTrashDir()`.
- `activation.js`: `trashKiroSession` (move files to trash + drop from kiro groups), `restoreKiroSession` (move back), `emptyKiroTrash` (permanent delete, confirmed). `package.json`: 3 commands + `view/item/context` menus (kiroSession 🗑, kiroTrashed ↺, kiroTrashGroup empty).

### Tests
- 273 node + 36 vitest passing (kiro group/nesting tests updated for the Recent Sessions wrapper; the `.None` leaf-row guard bumped to ≤4 for the trash leaf).

## [3.7.8] - 2026-06-04

### Fixed
- **The reader now shows Kiro tool-use turns instead of dropping them.** A Kiro assistant turn that calls a tool is usually an empty `text` block + a `toolUse` block; the kiro parser only kept non-empty `text`, so those whole turns vanished and tool-heavy conversations looked sparse or empty in the card reader. Tool calls now render as `🔧 <tool> — <purpose>`, so the full conversation flow is visible (truly-empty turns are still skipped).

### Added
- **Rename a session from the sidebar** (Claude Sessions + Kiro Sessions) — a ✎ action on each session row. Kiro has no auto-generated title (it falls back to the session's first message), so this is the reliable way to give a Kiro session a stable name; it works on closed sessions too. The name is stored per agent (`kiroSessionTitles` / `claudeSessionTitles`) and shows as the tree label; an open tab for that session updates live.

### Implementation
- `lib/sessionJsonl.js` `_extractKiroMessages()`: render `toolUse` content blocks (tool name + its `__tool_use_purpose`).
- `activation.js`: new `claudeCodeLauncher.renameSessionTitle` command — writes the entered name to `prov._storeKey('titles')`, refreshes the tree, and syncs any open tab. `package.json`: command + `view/item/context` entries for `kiroSession` and `session`/`subSession` (inline ✎).

### Tests
- 273 node + 36 vitest passing (the kiro parser test now asserts tool-use turns render, empty turns skip).

## [3.7.7] - 2026-06-04

### Added
- **Per-agent startup flags under Settings → Agent.** The Claude agent row now carries two launch toggles, matching Kiro's Trust-all-tools layout:
  - **Effort max (`--effort max`)** — relocated from Settings → General ("Auto Effort Max") to sit next to the agent. Same config key (`claudeCodeLauncher.autoEffortMax`), so your existing setting is preserved.
  - **Bypass permissions (`--dangerously-skip-permissions`)** — new. Launches Claude sessions in bypass-permissions mode (skips tool/permission prompts) without `shift+tab` each time. Off by default; use with care. Config key `claudeCodeLauncher.claude.bypassPermissions`.
  Both apply to newly opened and restarted Claude sessions; the Agent section is now symmetric per agent (Claude: effort/bypass, Kiro: trust-all-tools).

### Implementation
- `panel/createPanel.js` + `panel/restartPty.js`: claude spawn args append `--dangerously-skip-permissions` when `claude.bypassPermissions` is set (alongside the existing `--effort max`).
- `panel/settingsPanel.js`: the Auto Effort Max field is removed from General; the Claude agent row renders Effort-max + Bypass-permissions toggles (added to the settings globals + the write allowlist).
- `package.json`: new `claudeCodeLauncher.claude.bypassPermissions` boolean (default false); `autoEffortMax` description updated (it's a spawn flag now, not an idle-send).

### Tests
- 273 node + 36 vitest passing. The settings panel was rendered and its client script syntax-checked (Effort/Bypass toggles present, kiro block intact, the General field removed).

## [3.7.6] - 2026-06-04

### Fixed
- **Image-paste cancel now works in Kiro tabs.** Kiro's TUI runs in Windows *win32-input-mode* and ignores the client-side backspaces the launcher used to undo an image-path injection, so [취소] couldn't remove an already-injected path. Kiro tabs now **defer** the injection: pasting an image saves the temp PNG and shows a toast with [붙여넣기]/[취소] — the path is written to Kiro only when you confirm, so cancel simply discards it (nothing was injected). Claude tabs keep the immediate inject + backspace-to-cancel behaviour. (Confirmed empirically that neither `0x7f`/`0x08` raw backspaces clear Kiro's input via the launcher.)
- **Renaming a Kiro session now updates its label in the Kiro Sessions sidebar.** Session-title persistence was hardcoded to the `claudeSessionTitles` store and the Kiro Sessions tree only read the kiro metadata title — so a renamed kiro session's new name went to the wrong store and never appeared. `saveSessions()` now splits titles by agent into `claudeSessionTitles` / `kiroSessionTitles`, and `_buildKiroSessions()` reads `kiroSessionTitles` first (falling back to the kiro meta title).

### Implementation
- `handlers/pasteImage.js`: both paste paths skip the upfront `pty.write` when `entry.agent === 'kiro'` and flag the result `deferred`; `panel/messageRouter.js` gains an `inject-paste-file` case that writes the path on confirm.
- `panel/webviewClient.js`: the image-paste-result toast offers [붙여넣기]/[취소] for a deferred (kiro) result.
- `store/sessionManager.js`: title persistence split by agent. `tree/SessionTreeDataProvider.js`: `_buildKiroSessions()` labels from `kiroSessionTitles` first.

### Tests
- 273 node + 36 vitest passing.

### Note
- The Kiro "Trust all tools" toggle persists from 3.7.3 onward (the setting key is registered in the manifest). If it appears to not save, you are likely on a pre-3.7.3 build where the key was unregistered and `config.update` silently dropped it — updating resolves it.

## [3.7.5] - 2026-06-04

### Changed
- **The Kiro tone now extends to the reader's welcome robot and the assistant message accent.** In a Kiro tab the empty-state welcome robot and the vertical accent line on the left of assistant messages were still coral; they now follow the agent theme (purple for Kiro, coral for Claude), matching the input area added in 3.7.4. The standalone reader window (which has no agent theme) keeps the coral fallback.

### Implementation
- `lib/readerRender.js`: the welcome robot SVG's 5 coral fills/stroke became `currentColor` (the 3 white eye/mouth shapes are unchanged), so the robot takes its color from CSS.
- `webviewStyles.js` + `readerView.js`: `.rw-robot` gains `color: var(--accent, #D97757)`; `#reader-area .msg-assistant .msg-body`'s left border uses `var(--accent-glow-strong, …)` (the 0.5-alpha accent, matching the previous coral softness).

### Tests
- 273 node + 36 vitest passing. `renderWelcome()` verified (5 `currentColor` shapes, 3 white eyes kept, no hardcoded coral remaining).

## [3.7.4] - 2026-06-04

### Changed
- **Themes now tint the bottom input area, not the terminal.** A theme used to recolor the whole xterm terminal (background/foreground/cursor) and the window frame. Now the terminal always keeps its default colors, and the theme sets the *tone* of the input panel instead — the accent (focus border, send button, caret, queue/slash highlights, typing glow) **and** the input panel background. Output stays visually consistent across agents.
- **Themes are agent-branded and auto-follow the panel's agent.** Claude tabs get the coral "Claude Dark" tone (identical to before), Kiro tabs get the new purple "Kiro Purple" tone — applied automatically when the tab opens. Override per tab from the theme picker (right-click → Change Theme); an explicit pick in Settings acts as a global override. The old scenic themes (Midnight/Ocean/Forest/Sunset/Aurora/Warm) are removed in favour of this agent-theme model (foundation for future Antigravity/Codex tones).

### Implementation
- `webviewStyles.js`: the input area's hardcoded coral (`#D97757`/`#C96442`) + panel/textarea backgrounds + glows became CSS variables (`--accent`, `--accent-strong`, `--accent-deep`, `--accent-panel-bg`, `--accent-input-bg`, `--accent-glow`, `--accent-glow-strong`, `--accent-muted`) with the original coral as the fallback — so nothing changes until a theme is applied.
- `webviewClient.js`: `themes` is now `{ claude, kiro }`, each with a dark + light input-tone palette; `applyTheme()` sets the CSS variables only (no more `term.options.theme` / frame recolor). The initial theme resolves to an explicit `claude`/`kiro` global pick, else the panel's agent (via the `IS_KIRO` flag threaded from v3.7.3), applied synchronously to avoid a flash.
- `webviewContent.js`: theme picker + settings theme select rebuilt to Claude / Kiro with tone swatches; the queue-add button uses the accent variable.
- `i18n`: `themeClaude` ("Claude Dark") + `themeKiro` ("Kiro Purple"); the theme section retitled "Agent Theme".

### Tests
- 273 node + 36 vitest passing. Rendered webview client + full HTML verified for both agents (palettes present, `applyTheme` sets `--accent`, terminal no longer recolored, picker shows Claude/Kiro, input CSS fully variable-ized).

## [3.7.3] - 2026-06-04

### Added
- **Kiro "Trust all tools" toggle** (CLI Launcher Settings → Agent, under Kiro). When on, Kiro sessions launch with `kiro-cli chat --trust-all-tools` so Kiro may use any tool without asking for confirmation each time. Off by default (Kiro prompts per tool). Applies to newly opened and restarted Kiro sessions; existing tabs pick it up on restart. Config key: `claudeCodeLauncher.kiro.trustAllTools`.

### Fixed
- **Kiro terminal now stays pinned to the bottom** like the Claude terminal, instead of drifting to the top of the pane on new output. Kiro renders a full-screen frame in the *normal* buffer (no alternate screen): it clears with `CSI 2J` and redraws via cursor-home, which made xterm's pre-write "am I at the bottom?" snapshot go stale mid-redraw, so the viewport could land above Kiro's input line. Kiro sessions now follow the bottom on every write via an explicit scroll-intent flag (set from real scroll gestures through `term.onScroll`) rather than the fragile per-write snapshot, so the input line stays visible — and scrolling up still pauses the follow until you return to the bottom. Claude's inline-render path is unchanged.

### Implementation
- `panel/createPanel.js` + `panel/restartPty.js`: append `--trust-all-tools` to the kiro `chat` args when `claudeCodeLauncher.kiro.trustAllTools` is set.
- `panel/webviewContent.js` + `panel/webviewClient.js`: thread the panel's `agent` into the webview as `IS_KIRO`; for kiro the output handler keeps a `kiroStick` follow flag (updated by `term.onScroll`) and `scrollToBottom()`s after each write unless the user scrolled up.
- `panel/settingsPanel.js`: the Kiro agent row gains a "Trust all tools (--trust-all-tools)" checkbox bound to the global; `kiro.trustAllTools` added to the settings globals and the write allowlist.
- `package.json`: new `claudeCodeLauncher.kiro.trustAllTools` boolean (default false).

### Tests
- 273 node + 36 vitest passing. Kiro PTY behaviour confirmed empirically (no alt-screen; `2J` + cursor-home full-redraw), and the rendered webview client was syntax-checked for both agents (`IS_KIRO` true/false).

## [3.7.2] - 2026-06-04

### Fixed
- **Kiro readers no longer show other sessions' transcripts.** With two or more Kiro tabs open in the same folder, every reader rendered whichever session wrote most recently instead of its own conversation. `getSessionJsonlPath()` ignored the session id for Kiro and always returned `findLatestKiroSessionPath(cwd)` (cwd-latest) — fine for one session per cwd, wrong the moment a second appears (verified against two real sessions sharing the vault cwd: both resolved to the newer one). Now, when the real Kiro id is known, the reader reads that exact `<id>.jsonl`; a fresh session — whose id Kiro assigns and we don't know at spawn — is **discovered and pinned** on its first transcript write, then reads its own file thereafter. Our placeholder `crypto.randomUUID()`s never exist as `<id>.jsonl` on disk, so an `existsSync` check cleanly tells a real id from a not-yet-pinned placeholder.

### Implementation
- `lib/sessionJsonl.js` `getSessionJsonlPath()`: for kiro, return `~/.kiro/sessions/cli/<sessionId>.jsonl` when that file exists; only an unknown placeholder id falls back to `findLatestKiroSessionPath(cwd)`.
- `panel/createPanel.js` `startReaderWatch()`: a fresh kiro panel snapshots the session ids that already existed for its cwd, then claims the first NEW, unclaimed id that appears — pinning it onto `entry.sessionId` (and setting `isKiroResume`, so a restart resumes via `--resume-id`) and persisting it. A module-level `_claimedKiroIds` set stops two fresh panels in one cwd from claiming the same id; the claim is released on panel dispose. A Tree-resume owns its real id immediately.
- Known limit: two kiro tabs opened in the same folder *before either writes its first transcript* can still be assigned in the wrong order — there is no on-disk id to disambiguate them yet. Opening them one at a time (the normal flow) is exact.

### Tests
- 273 node + 36 vitest passing. New `kiroReaderPath.test.ts`: a known id resolves to its own file, the older session is not pulled to the newest (the actual bug), and an unknown placeholder falls back to cwd-latest. (`USERPROFILE`+`HOME` overridden so `os.homedir()` resolves the fixtures cross-platform.)

## [3.7.1] - 2026-06-04

### Fixed
- **Kiro sessions now launch on Windows.** Opening a new Kiro session failed with `PTY spawn FAILED: File not found:`. `resolveKiroCli()` only checked the macOS/Linux standalone path (`~/.local/bin/kiro-cli`) and otherwise fell back to the bare command name `kiro-cli.exe`. That bare name passes a `child_process --version` probe (Node resolves it via PATH) but then fails inside node-pty, because winpty/conpty does **not** search PATH — it needs an absolute path. The Windows installer location (`%LOCALAPPDATA%\Kiro-Cli\kiro-cli.exe`) was never checked. The resolver now (1) checks the Windows installer dir, and (2) resolves any PATH hit to an absolute path via `where.exe`, so node-pty always receives a spawnable absolute path. macOS was unaffected because `~/.local/bin/kiro-cli` exists there and was returned as an absolute path. The same hardening was applied to `resolveClaudeCli()`'s PATH fallback (identical latent bug, previously masked because `~/.local/bin/claude.exe` exists on the affected machine).

### Changed
- **New installs enable only Claude by default** (`enabledAgents` default is now `["claude"]`, was `["claude","kiro"]`). Kiro is opt-in — enable it in CLI Launcher Settings → Agent. This keeps the default surface Claude-only for users who don't have Kiro installed; the new-session picker and Kiro Sessions view appear once Kiro is both enabled and installed.

### Implementation
- `pty/resolveCli.js`: new `resolveOnPath(name)` helper — Windows uses `where.exe <name>` (first PATH hit, absolute path); Unix verifies `<name> --version` and returns the bare name (execvp searches PATH). `resolveKiroCli()` gains a `%LOCALAPPDATA%\Kiro-Cli\kiro-cli.exe` check; both resolvers route their PATH fallback through `resolveOnPath` so the returned `shell` is always absolute on Windows.
- `enabledAgents` default changed in `package.json` (config schema) and the four runtime readers: `activation.js`, `handlers/pickAgent.js`, `tree/QuickActionsProvider.js`, `panel/settingsPanel.js`.

### Tests
- 269 node + 36 vitest passing — now green on Windows too. `kiroSessionGroups.test.ts` overrides `USERPROFILE` as well as `HOME`, because `os.homedir()` reads `USERPROFILE` on Windows; the two kiro-grouping cases pointed their fake `~/.kiro` fixtures at `HOME` only and so failed on Windows (a latent test-portability bug from the 3.7.0 Kiro work, not a product regression).

## [3.6.14] - 2026-06-01

### Fixed
- **The terminal pane's content now sits at the pane bottom reliably — including on freshly opened panels/tabs and after `/clear`.** Previously a short startup screen could render at the top of a tall terminal instead of hugging the bottom. The cause was the leftover "background-terminal" trick (the pty forced to 40 logical rows + the xterm CSS-anchored to the pane bottom), whose only consumer — the in-reader choice-bar menu detector — was already removed in 3.6.12. That trick created a pty/xterm row mismatch that bottom-anchoring tried to paper over, which mispositioned content whenever Claude's output was short (a fresh panel, a session right after `/clear`), because Ink renders the input line *after* its content rather than pinned to the screen bottom. The terminal now fits the visible pane normally and the pty resizes to the actual row count, so Claude's input lands at the pane bottom on its own.
- **Navigating an open menu (e.g. `/model`) with the arrow keys no longer collapses the auto-expanded terminal as if you'd already answered.** The input handler clears the rolling affordance tail on a keystroke so a just-answered menu's footer can't keep the prompt-affordance "present" and block the terminal-restore — but it was doing this on *every* key, including the arrows used to move within a still-open menu. Because Ink re-renders a navigated menu only partially (the changed rows, not the footer the detector keys on), clearing mid-navigation lost the footer and falsely restored the terminal. A new `isNavKey()` guard keeps the tail intact on pure cursor-navigation keys (arrows / page / home / end); only an actual answer (digit / Enter / Esc / typing) clears it.

### Implementation
- `webviewClient.js`: removed the `BG_TERM_ROWS = 40` `term.resize` override — the terminal just `fitAddon.fit()`s the visible pane now.
- `webviewStyles.js`: dropped the `#terminal .xterm { position: absolute; bottom: … }` bottom-anchoring; the xterm fills the pane in normal flow with `#terminal`'s padding as inset.
- `messageRouter.js`: the `resize` handler resizes the pty to the actual `msg.rows` (was `Math.max(rows, 40)`); new pure `isNavKey(data)` helper gates the `input` handler's `entry._recentTail = ''` so navigation keys preserve the tail. Idle prompt detection is unchanged — it's byte-based on the PTY footer, which Claude emits even when a tall menu is windowed into a short pane.

### Tests
- 237 node + 36 vitest passing.

## [3.6.13] - 2026-06-01

### Changed
- **The reader's empty state is now a branded welcome screen instead of the bare "Waiting for session output…" line.** Before any conversation output exists — a freshly opened panel, or a session with zero messages yet — the reader shows the Claude Code wordmark, the robot mascot, and a short hint, matching Claude Code's own welcome look. It transitions to the live transcript as soon as messages arrive.

### Implementation
- `readerRender.js`: new `renderWelcome()` returns the splash markup (inline `claude-robot.svg`, static/trusted). `renderBlocks([])` returns it and `createPanel.js` passes it as the initial reader HTML, so both the initial load and the zero-message state are covered — for the split-pane reader and the standalone reader view.
- `.reader-welcome` / `.rw-*` styles added to `webviewStyles.js` and `readerView.js`.

## [3.6.12] - 2026-05-31

### Changed
- **Interactive prompts now fire a desktop notification (and, in reader/split view, auto-expand the bottom terminal) instead of rebuilding the menu as in-reader buttons.** The previous inline y/n prompt-bar and numbered choice-bar screen-scraped raw PTY ANSI to reconstruct Claude's menus as clickable buttons; that mis-fired on plain text (a bare `(y/n)` in prose) and on a `/model` menu rendered above a code diff (phantom options). They are removed. Now, when output settles on an interactive prompt (a `/model`-style menu, a trust/permission prompt, or a y/n), the tab escalates to needs-attention + a desktop notification — regardless of the 7s running threshold, since menus appear in under 3s — and in reader/split view the bottom terminal pane grows so the menu is visible and answerable without dragging, restoring your ratio when the prompt clears.
- **Built-in slash-command autocomplete synced to the current Claude Code (Opus 4.8 era) built-ins.** Removed commands that no longer exist (`/pr-comments` gone v2.1.91, `/vim` gone v2.1.92, `/output-style` folded into `/config`, `/migrate-installer`) and added the current core + integration commands (`/plan`, `/rewind`, `/status`, `/theme`, `/diff`, `/branch`, `/rename`, `/recap`, `/background`, `/tasks`, `/btw`, `/copy`, `/sandbox`, `/privacy-settings`, `/skills`, `/plugin`, `/keybindings`, `/usage-credits`, `/feedback`, `/mobile`, `/desktop`, `/teleport`, `/remote-control`, `/install-slack-app`). Bundled skills (`/code-review`, `/debug`, `/loop`, …) are intentionally excluded — they're surfaced through the personal PKM/OMC catalog. Verified against the official commands reference.
- HUD now shows the active model name; the account status bar shows the full email.

### Implementation
- New `src/lib/promptAffordance.js` — a conservative, idle-gated prompt detector (Claude's interactive footer keywords + a caret-anchored numbered-menu check, not bare tokens). Pure + unit-tested. `createPanel.js` runs it in the idle timer against a rolling `entry._recentTail`, deduped on `entry._promptSig`; `messageRouter.js` drops the tail on user input so a just-answered menu's footer can't keep the affordance "present". Detection is ext-side, so it also fires on background tabs.
- Terminal auto-expand lives in `webviewClient.js` `setupSplitter` (`expandTerminalForPrompt` / `restoreTerminalAfterPrompt`, reader flex-basis ≤40%, never persisted), driven by new `prompt-terminal-expand` / `prompt-terminal-restore` messages.
- Removed: `choicePrompt.js` (+ test/fixture), `detectBinaryPrompt`, `looksLikePrompt`, the `prompt-detected` / `choice-detected` / `prompt-respond` / `choice-respond` protocol, `showPromptBar` / `showChoiceBar` + DOM + CSS, `choiceBarTitle` i18n.
- New `src/pty/backend.js` (`createBackend` / `createPtyBackend`) — a named, behaviour-identical spawn seam used by `createPanel.js`.
- Slash catalog: `BUILTIN_EXTRAS` rewritten (39 entries) in `slashRegistry.js`; `/plan` + `/rewind` added to the primary array; en/ko labels at parity (55 keys each), no duplicates.

### Tests
- 237 node + 36 vitest passing. Independent code review (0 Critical/High) addressed.

## [3.6.11] - 2026-05-30

### Changed
- **`autoEffortMax` now injects `--effort max` as a CLI flag at spawn time instead of typing `/effort max` once the session goes idle.** The previous behaviour sent the slash command through PTY input ~800 ms after the first idle, which left a visible `/effort max` line in the terminal and only took effect once the prompt was ready. The flag path starts the session at max from the first token with no on-screen command. The setting key, persisted value, and settings toggle are unchanged; turning it off falls back to the model's configured baseline effort (e.g. `effortLevel`).

### Implementation
- `createPanel.js`: `args` spreads `...(autoEffortMax ? ['--effort', 'max'] : [])` after `claudeArgs`. The multiplexer wrap reuses the same `args`, so both the direct and `psmux`/`tmux` backends inherit the flag.
- `restartPty.js`: reads `claudeCodeLauncher.autoEffortMax` and appends the same flag to the `--resume` argv, so reload-window restores also start at max.
- `webviewClient.js`: removed the first-idle slash-injection block (`/effort max` + toast); the spawn-time flag supersedes it.

## [3.6.10] - 2026-05-21

### Fixed
- **Republish to recover the win32-x64 artifact.** v3.6.9 shipped darwin-arm64 and linux-x64 to Open VSX but the win32-x64 artifact never became visible: its 23 MB / 78 MB-unpacked vsix (bloated with MSVC build intermediates — see the v3.6.9 `.vscodeignore` note below) exceeded the Open VSX publish gateway's upload timeout, returning HTTP 503 on every attempt. One of those timed-out attempts left a half-registered, *inactive* `3.6.9 (win32-x64)` entry on Open VSX — enough that `ovsx publish` then reported "already published, but currently isn't active and therefore not visible" and refused to re-upload the (now slimmed) artifact at the same version. Since ovsx cannot overwrite an existing version and the inactive entry cannot be cleared via the CLI, v3.6.10 is a clean version bump so all three platforms register fresh. No code changes from v3.6.9 — the `.vscodeignore` slimming (win32 vsix now ~7 MB) and the workflow's idempotent + retry publish loop are already on `main`.
- **Publish workflow no longer treats an inactive duplicate as a successful skip.** The idempotent loop matched the bare string "is already published", which also matched the "...but currently isn't active" variant — so a half-published zombie was silently skipped and the job went green. The match is now narrowed: a plain already-published line is a soft skip, but an "isn't active" / "not visible" variant is surfaced as an error so a broken partial publish can't masquerade as success.

## [3.6.9] - 2026-05-21

### Fixed
- **Sessions placed in a custom group no longer disappear from the tree once newer activity pushes them past the top-30 mtime window.** `_loadSessions` had a hard `.slice(0, 30)` cap inherited from the original Recent Sessions design; that cap was applied before group membership was consulted, so explicit bucketing — the strongest signal a user can give that a session matters — was overridden by raw recency. v3.6.9 keeps the 30-item hot path for the Recent Sessions list AND additionally surfaces group members (regular groups + Resume Later) up to a soft cap of 100 (mtime DESC). The cap aligns with the v3.5.9 file-meta LRU so title parsing stays inside the cache and tree refreshes don't degrade as group sizes grow.

### Added
- **Archive groups for stash-style buckets of large jsonls.** Right-click a custom group → **Toggle Archive Mode**. Archive groups get a `📦` prefix and `archive` icon, have no member cap, and skip the expensive `extractAiTitle` / `extractFirstUserMessage` parse on tree load — only `fs.statSync` runs per member. Labels fall back to the saved title or an 8-char session-id prefix; the metadata row (turns + relative time + size) still parses lazily on first expand and the entry is fully resumable. A 200-member archive of multi-MB sessions costs roughly the same as a 5-member regular group on refresh.
- New storage key `claudeSessionGroupArchived` (array of group names). No migration — empty default means existing groups stay in regular mode.
- New command `claudeCodeLauncher.toggleGroupArchive` exposed in the group context menu and the command palette. Shows a toast confirming the new mode.
- Korean / English i18n strings (`archiveModeOn` / `archiveModeOff` / `archiveGroupNotFound`).

### Implementation
- `_loadSessions(protectedIds, archivedIds)` now derives two id sets in `_buildGroups`, full-extracts top-30 + protected-extra members, and runs a separate cheap path for archived members. Archive membership wins when a session would otherwise be in both buckets (cheaper path).
- `makeGroupNode` reads `claudeSessionGroupArchived` and flips the leaf label / icon for archive groups; tooltip on archived session items advertises `(archived — title not parsed; expand to load)` so users understand why labels read as session-id prefixes.

## [3.6.8] - 2026-05-21

### Changed
- **Coalesce window widened from 8 ms to 32 ms (`createPanel.js:COALESCE_WINDOW_MS`).** v3.6.4 introduced an 8 ms coalescing window for small PTY chunks on the postMessage path, and v3.6.5 routed parser calls through the same window. v3.6.7's PerformanceObserver + main-thread block timer landed in the field and immediately produced an inter-arrival histogram showing why those two fixes left so much on the table: the **9–32 ms bucket holds ~80% of all chunks** on busy panels (one 10-min window: 4 643 / 8 974). An 8 ms window catches almost none of that bucket — every Ink redraw, spinner tick, and cursor blink lands in its own flush. Widening to 32 ms (two 60fps frames, well under the 100 ms perception threshold) makes the coalescing actually bite: flush invocations on a busy panel drop from ~10–15/sec to ~1/sec (~14× reduction), and the four parser calls (`contextParser.feed`, `detectShellRunning`, `detectBinaryPrompt`, `looksLikePrompt`) inherit the same reduction since v3.6.5 hung them on `flushPending`. Large chunks (≥ `SMALL_CHUNK` = 4 KB) still flush immediately so table dumps and session-resume bursts retain their pacing.
- This is **not** a fix for the OS-level main-thread contention that v3.6.7 surfaced (concurrent Playwright + OneDrive sync from sister automations driving 6–9 s block samples in the dump) — that's outside the extension's control. What v3.6.8 buys is **ext-host main-thread headroom during those contention windows**, so the cli-launcher recovers faster instead of accumulating its own scheduling debt on top of the OS-level pressure.

### Implementation
- One-line constant change in `src/panel/createPanel.js` (8 → 32) plus the two surrounding comment blocks updated to reflect the new rationale and rate ceilings.
- No new tests: the change is a single timing constant with no branching; `ptyChunk` tests still cover the SMALL_CHUNK pass-through path; manual verification is via the next diagnostics dump (chunks/flush ratio should rise visibly on busy panels).

### Trade-offs
- **First-chunk latency: +24 ms** in the worst case (8 → 32 ms). Two frames at 60 fps. Imperceptible against the Windows ConPTY baseline of ~20–30 ms; well below the 100 ms human-perception threshold.
- **`needs-attention` detection: up to +32 ms**. The four interactive-prompt detectors run on the coalesced payload now, so a Y/n prompt reaches the reader UI one window later. Functionally invisible — the prompt itself still renders via xterm.write at the same time.
- **Input echo: unaffected** — xterm.js handles local echo without going through the PTY round-trip, so keystroke responsiveness is independent of this window.

## [3.6.7] - 2026-05-20

### Added
- **GC observer + main-thread block timer for diagnostics.** v3.6.5 cut the per-chunk parser cost and v3.6.6 capped the reader DOM, yet a 14:24 KST reproduction with the BigQuery daily-load workflow active still produced a periodic dump that fired **52.4 seconds late** (`elapsed=652.4s` where the scheduler was wired for 600s). That delta is direct evidence the extension-host main thread was blocked for tens of seconds — parser/render were not the residual blocker. v3.6.7 instruments the two prime suspects so the next freeze isolates them on the spot.
  - **GC pause aggregation** — a `perf_hooks.PerformanceObserver` subscribes to GC entries and buckets each into major / minor / other with per-bucket count + total + max duration. Stop-the-world major GCs are the headline number; minor GCs stay visible as a sanity check that V8 is actually running its young-generation cycles. The observer subscribes with `buffered: true` so entries that fire in tight bursts during a GC storm don't get dropped.
  - **Main-thread block sampling** — a 1 Hz `setInterval` measures its own scheduling drift each tick. Whenever the actual fire time exceeds the scheduled interval by more than 500ms, that drift is recorded as a block sample (count + total + max). 500ms filters out normal scheduler jitter (GC minor pauses, OS context switches) while catching the seconds-long pauses that match user-visible freezes. A 52-second block surfaces as a single ~52000ms sample.
- Both axes reset per dump window, identical to the per-panel PTY counters, so consecutive dumps describe the most recent interval — easy to correlate against a freeze the user just experienced.

### Implementation
- New `src/lib/diagnosticsStats.js` carries the four pure helpers (`newGcStats`, `newBlockStats`, `recordGcEntry`, `recordBlockSample`) so they can be unit-tested without a `vscode` runtime shim. `diagnostics.js` `require`s the module and holds the runtime parts (PerformanceObserver subscription + setInterval lifecycle).
- `Diagnostics.start()` wires the observer + block timer; `Diagnostics.dispose()` disconnects the observer + clears the timer (no leak across reload / toggle-off).
- The dump renderer adds two new lines under each `heap:` block: `gc: major count=... / minor count=...` and `main-thread blocks (drift>500ms): count=... total=...ms max=...ms`. No behaviour change beyond the new measurement — hot path PTY recording is untouched.
- 11 new unit tests in `test/unit/diagnosticsStats.test.ts` cover bucket dispatch, accumulation, threshold strictness, and the 52-second block reproduction case.

## [3.6.6] - 2026-05-20

### Fixed
- **Reader DOM auto-prune to keep long sessions bounded.** v3.6.5 cut the per-chunk parser cost but the diagnostics dump from a 17-panel marathon revealed a second leak vector that survived: `#reader-area` grew monotonically as sessions accumulated turns. One panel hit 10,457 DOM nodes / 335KB HTML, others sat at 2,000–4,000 nodes / 70–130KB. Multiply by 17 panels and the webview heap budget went into multi-hundred-MB territory before any Ink storm even happened. v3.6.6 caps the rendered message count in `readerRender.renderBlocks` to the most recent N messages (default 200, configurable via `claudeCodeLauncher.readerMessageCap`, range 20–2000). The cap covers both the split-pane reader (`createPanel.js:startReaderWatch`) and the standalone reader panel (`readerView.js:renderLive` + `renderHtml`) because both funnel through the same `renderBlocks`. A top indicator row (`… N older messages hidden`) appears when truncation kicks in so users see what's happening; the underlying jsonl is untouched. RSS reads per render (no closure-cached cap) so a settings edit takes effect at the next reader refresh without a panel reload.

### Implementation
- `readerRender.js` exports a new `DEFAULT_READER_MESSAGE_CAP = 200` and `renderBlocks(messages, { cap })` signature. When `messages.length > cap`, the rendered output slices the tail (most recent) and prepends a `<div class="reader-truncated">` indicator with the dropped count + the settings key name.
- Both reader call sites (createPanel + readerView × 2 paths) read `claudeCodeLauncher.readerMessageCap` from workspace config per render. Config read is cheap; render frequency is 1s polling at worst.

## [3.6.5] - 2026-05-19

### Fixed
- **Hour-scale ext-host RSS spike pattern that caused 7–60s main-thread blocks (root cause of remaining freezes).** v3.6.4 coalesced the postMessage path but parsing (`contextParser.feed`, `detectShellRunning`, `detectBinaryPrompt`, `looksLikePrompt`) still ran on every raw PTY chunk. v3.6.3+v3.6.4 diagnostics dumps revealed the consequence: during Ink redraw storms 11,000+ chunks/window × 4 parsers × per-call string allocation produced a recurring `200MB → 1060MB → GC → 200MB` cycle in `process.memoryUsage().rss`, and the periodic-dump timer landed 7–60 seconds late on spike windows — direct evidence the V8 major GC was holding the main thread. The user's symptom ("freeze → wait → keys land in burst → freeze again, every ~hour") matched exactly. v3.6.5 moves all four parser calls into `flushPending` so they run on the coalesced 8ms-window payload (≤8 invocations/sec/panel instead of 100+). Parser outputs stay identical because `contextParser` is incremental via its 300-char rolling buffer; `detectShellRunning` / `detectBinaryPrompt` / `looksLikePrompt` each detect from the tail of the data, and tail-window regex actually become **more accurate** on coalesced payloads because keywords no longer split across chunk boundaries.
- **Inactive panel parsing now also coalesces (needs-attention still fires on hidden tabs).** Previously inactive panels still ran 4 parsers per raw chunk to keep prompt detection live; that path is now identical to the active path (parse-then-skip-postMessage) so the same RSS reduction applies regardless of which tab is focused.

### Implementation
- `onData` body is now a 4-line hot path: stale-guard, diagnostics counter, outputBuffer push (inactive), `pendingPayload` append + flush-timer arm.
- `flushPending` carries the full parser pipeline (contextParser, detectShellRunning, detectBinaryPrompt, looksLikePrompt + v2.6.6 fast-path + idleTimer/runningDelayTimer reset) and only branches on `panel.active` for the final `sendPtyChunkPaced`.
- 8ms is half a 60fps frame so needs-attention recognition stays well under the 100ms human-perception threshold.

## [3.6.4] - 2026-05-18

### Fixed
- **Single-panel freezes on Ink redraw storms (SelectInput / spinner screens).** The v3.6.2/v3.6.3 diagnostics confirmed the long-suspected pattern: during a SelectInput or spinner screen, Claude Code's Ink renderer emits **20–30 tiny PTY chunks per second** (cursor blink, status-line partial redraws, selection indicator). One representative 10-minute window logged 15,522 chunks averaging 35B, with **92.6% under 64B and 64% arriving within 33ms of the previous one** — every one of those was firing a separate `panel.webview.postMessage` + `xterm.write` on the webview's main thread, saturating it until a user input keystroke could break through the backlog as a burst, the exact symptom reported. v3.6.4 coalesces small chunks across an 8ms window (half a 60fps frame so input latency is imperceptible) and ships them as one payload through the existing `sendPtyChunkPaced`. Large chunks (≥4KB, the pacer's threshold) still flush immediately so table dumps and session-resume bursts stay paced. Inactive panels keep using the v3.5.7 `outputBuffer` path; coalescing only applies once a panel is active and the webview is ready.
- **`panel undefined` in diagnostics dumps.** `state.diagnostics.recordChunk()` was called with `entry.tabId`, which was never set on the entry object — every panel's stats collapsed into a single "panel undefined" bucket making per-tab attribution useless. Added `tabId` to the entry constructor so `recordChunk` and `recordWebviewMemory` both attribute per panel correctly.

### Implementation
- `pendingPayload` string + `pendingFlushTimer` per panel in `createPanel.js`; the onData hot path appends to the buffer and either flushes when it crosses `SMALL_CHUNK` (4 KB) or schedules a single 8 ms timer to drain. `flushPending()` is idempotent and disposal-safe; `panel.onDidDispose` clears the timer + drops any unsent bytes.
- Parsing (`contextParser.feed`, `detectShellRunning`, `detectBinaryPrompt`, `looksLikePrompt`) **stays per-chunk** so needs-attention recognition remains instant — the coalesce only affects the postMessage path.

## [3.6.3] - 2026-05-18

### Added
- **Webview-side memory probe for diagnostics.** Each webview is its own V8 context, separate from the extension host's, so a leak that freezes a single panel doesn't show up in `process.memoryUsage()`. v3.6.3 adds a per-tab probe that reports `performance.memory.usedJSHeapSize / totalJSHeapSize / jsHeapSizeLimit` plus `xterm.buffer.active.length` (scrollback line count) and the `#reader-area` DOM node count + HTML byte size every 60 seconds. The diagnostics OutputChannel dump now shows `webview-heap`, `xterm-scrollback`, and `reader: dom-nodes=…/html=…` lines under each panel, so a tab that's drifting toward V8's 2 GB ceiling is visible per-panel before it actually freezes.
- Panel blocks now print even when no PTY traffic happened in the dump window, as long as a webview snapshot exists — this surfaces idle tabs whose webview is still creeping.

### Implementation
- New webview-side `__probeWebviewMemory()` in `webviewClient.js` fires immediately (baseline) and then every 60 s via `setInterval`; `window.unload` clears the timer.
- New `webview-memory` message handled by `messageRouter.js` → `state.diagnostics.recordWebviewMemory(tabId, msg)`. Disabled-state cost is one `if (state.diagnostics)` check per minute per panel.
- `Diagnostics.recordWebviewMemory` stashes the latest snapshot per panel; the dump renders `webview-heap (age Ns)` so a probe that stopped reporting is identifiable.

## [3.6.2] - 2026-05-15

### Added
- **Opt-in diagnostics for freeze investigation.** Toggle `claudeCodeLauncher.diagnostics.enabled` and a new `CLI Launcher — Diagnostics` OutputChannel starts receiving a baseline snapshot at startup plus a periodic dump every 10 minutes. Each dump records `process.memoryUsage()` (rss / heapUsed / heapTotal / external) plus, per tab, the number of PTY chunks received, total bytes, average + max chunk size, and **two histograms — chunk size in 7 buckets (≤64B … >64KB) and inter-arrival interval in 5 buckets (≤8ms … >1s).** The histograms make the difference between "many tiny chunks" (Ink redraw storm during a SelectInput / spinner) and "few huge chunks" (initial flush, table dumps) visible at a glance, which is the missing piece for diagnosing the v3.5.5–v3.5.9 freeze fix's residual cases.
- **`Claude: Diagnostics: Dump Now` command** for on-demand snapshots — useful right after reproducing a freeze so the latest interval gets flushed before the periodic timer fires.

### Implementation
- New `src/lib/diagnostics.js` (~155 lines). Disabled-state cost in `createPanel.js:onData` is one `if (state.diagnostics)` null check per PTY chunk; when enabled the hot path does three integer increments + one histogram bump + one timestamp diff.
- Reactive to config changes (`onDidChangeConfiguration`) so toggling on/off doesn't need a window reload.
- Per-panel counters reset after each dump so successive snapshots describe the most recent window, not the lifetime — easier to correlate with a freeze that just happened.
- Closed tabs drop their counters on `panel.onDidDispose` so the rolling map doesn't leak entries.

## [3.6.1] - 2026-05-15

### Added
- **Account status bar item.** A left-aligned status bar entry now shows the active Claude account — `$(account) <organizationName>` when the live account belongs to an org, otherwise the full email. Click it to open the same QuickPick that `Switch Claude Account…` runs (save current, swap, update, delete). The tooltip carries email, organization, plan, and whether the account is saved as a profile. Hides itself entirely when no Claude credentials exist (Claude CLI hasn't been logged in), so users without a `/login` see no stub label. Auto-refreshes after every save/swap/update/delete — no file watcher needed because Claude CLI's background token rotation never changes identity, only credential bytes.

## [3.6.0] - 2026-05-15

### Added
- **Multi-account profile switcher.** New `claudeCodeLauncher.switchAccount` and `claudeCodeLauncher.saveAccount` commands plus a "Switch Account…" button in the settings modal (⚙) let you save a Claude Code login and swap between accounts without going through the full `/logout` + `/login` browser dance each time. Saved profiles live under `~/.claude/account-switcher/<slug>/` (separate from upstream `vishalguptax/claude-manager`'s `manager-accounts/` to avoid data conflicts). A one-time consent modal explains that OAuth tokens are copied in plain text — same format Claude CLI already uses on disk — before the first save. The switcher is a native QuickPick: active profile pinned to the top, duplicates flagged, inline Update/Delete buttons. Switching is two-file atomic (claude.json + .credentials.json) with rollback if either rename fails partway. Active-profile detection cascades through four matchers (credentials hash → `accountUuid` → `userID + email` → email) so Anthropic's background token rotation doesn't silently "unsave" the active profile.
- **Account module + 36 unit tests** — ported from `rockuen/claude-account-switcher` v0.1.1 under `src/account/` (TypeScript) and `test/account/` (vitest). The 881-line `profiles.ts` snapshot/swap/sync core is carried over byte-for-byte; the QuickPick UI (`switcher.ts`) is adapted to use `vscode.ExtensionContext` directly instead of a webview view-provider host. See `NOTICE` for Apache-2.0 attribution.
- **vitest as a second test runner** for the account lane. The existing 210-test `node --test` suite is unchanged (`npm run test:node`); `npm run test:vitest` runs the 36 ported tests; `npm test` runs both.

## [3.5.9] - 2026-05-14

### Fixed
- **Tree refresh fan-out: extractMessageCount made lazy, file meta cached, refresh debounced.** User report: even after v3.5.5–v3.5.8, idle-period freezes still occur on iloom-workspace. Investigation found three sources of repeated work that previous fixes left untouched, all compounding hard when (a) several multi-MB sessions sit in the most-recent 30 and (b) the tree is asked to refresh several times a minute because each of 5 active sessions cycles state during background work.
- **`extractMessageCount` now runs only on expand**, not on every tree refresh. The metadata row (`N turns · relative time · size`) used to be pre-built inside `_loadSessions` for every one of the 30 most-recent jsonls. On iloom, that meant a refresh re-parsed 7 multi-MB scm-pdca sessions every single time even though the user wasn't looking at them. Session items now carry just `_jsonlPath` / `_fileSize` / `_mtime`; `getChildren(element)` composes the metadata row on first expand and caches the result in `_composedChildren`, so re-expand after collapse doesn't re-run anything. Trash items skip `extractMessageCount` entirely — their meta row says "trashed · …" with no turn count.
- **`SessionTreeDataProvider.refresh()` debounced at 500 ms.** PTY state transitions (running → waiting → needs-attention → running) on a busy session can fire `refresh()` a dozen times in a few seconds; 5 sessions doing this concurrently was rebuilding the whole tree at the rate the host could barely keep up with. The debounce coalesces the burst into a single `fire()`. 500 ms is short enough that the user perceives the tree as live but long enough to absorb the common state-change cascade.
- **`extractAiTitle` + `extractFirstUserMessage` results cached by `{mtime, size}`** in a tree-level `_fileMetaCache` (LRU, 100 entries). `extractAiTitle` parses the whole file with no per-line cap (Claude Code rewrites the title as a session grows, so the latest occurrence wins), and that's the worst case on a 48 MB scm-pdca jsonl. Combined with the `_readLinesCached` 2 MB cap from v3.5.6 that excludes big files from sessionJsonl's own cache, the same 48 MB file was being read + parsed top-to-bottom on every refresh. The new cache keys by `{mtime, size}` so unchanged files cost only a `stat()`.
- **Sub-sessions moved from `_children` to `_subSessions`** so the lazy `getChildren` can compose `[metaRow, ...subSessions]` on demand without conflating the always-present metadata row with the sub-session list. Group containers (Resume Later, Custom Groups, Recent Sessions, Trash) still use `_children` — only session items got the new field.

## [3.5.8] - 2026-05-14

### Added
- **Size-based session decoration: yellow for 5+ MB, red for 10+ MB.** v3.5.6 surfaced the per-session size on the expanded metadata row, but the row only appears when expanded — a glance at the collapsed tree gave no hint that a session had grown into the freeze-prone zone. v3.5.8 colors the session label itself: yellow (`editorWarning.foreground`) over 5 MB, red (`errorForeground`) over 10 MB. Hovering a colored session shows a recommendation in the tooltip — `⚠ 큰 세션 (X MB) — 새 세션으로 분할 권장` at 5 MB, `⚠ 매우 큰 세션 (X MB) — 즉시 새 세션으로 분할 권장` at 10 MB. Trash entries get the same color treatment with `휴지통에서 정리 권장` / `휴지통에서도 비우기 권장` wording so users know which trashed sessions are taking up the most disk too.
- **Thresholds are empirical, matching the v3.5.7 risk table:** under 5 MB sessions are entirely safe; 5–10 MB sessions trigger the v3.5.6 cache miss + heavier per-poll work; 10+ MB sessions are the iloom-workspace `a00cfa9a` (18 MB) class that actually started showing the multi-session freeze pattern. Coloring at exactly those thresholds means the visible warning aligns with the practical recommendation: re-split when you see yellow, definitely re-split when you see red.

### Implementation
- New `src/tree/SessionDecorationProvider.js` implementing `vscode.FileDecorationProvider`. Custom URI scheme `claudeCodeLauncher-session://<sessionId>?size=<bytes>&trashed=<0|1>` carries the metadata into the provider so the existing `SessionTreeDataProvider` only has to tag each `TreeItem.resourceUri` and the decoration follows automatically. Registered in `activation.js` next to the tree view.
- `_sizeWarningSuffix()` in `SessionTreeDataProvider` appends the recommendation to the regular hover tooltip too — VSCode renders the file-decoration tooltip on a secondary hover, but the main TreeItem tooltip is more discoverable, so we duplicate the message where users will actually see it.
- 14 unit tests in `test/unit/sessionDecoration.test.ts` cover the threshold boundaries (5/10 MB exact, 18 MB iloom case), trash-vs-active wording, invalid input handling, and URI round-trip.

## [3.5.7] - 2026-05-13

### Fixed
- **Background-task freeze on vaults with many concurrent active sessions.** User pattern: open VSCode on an Obsidian vault with 5 long-running Claude Code sessions (one ~18 MB, several smaller), kick off background tasks, walk away for hours. Coming back, the foreground session's xterm has gone unresponsive — typing produces nothing, output stops updating — and in the worst case VSCode itself locks up and needs a reboot. Root cause: Chromium throttles hidden webview tabs (`requestAnimationFrame` to ~1 Hz, `setTimeout` slow-down), so `panel.webview.postMessage` payloads queue up in the IPC pipe faster than the throttled webview can drain them. With 5 sessions × hours of background output, the queue grows to hundreds of MB, eventually OOM'ing the extension host or the whole window. v3.5.7 holds the data extension-side while a panel is inactive and batch-flushes through the pacer on visibility return.
- **PTY output gating for inactive panels** — `createPanel.js`'s PTY `onData` handler now treats `!panel.active` the same as `!webviewReady`: append to an extension-side buffer, drop oldest chunks past a 1 MB cap (xterm.js's own scrollback is authoritative for visual continuity after the catch-up). `onDidChangeViewState`'s active transition drains the buffer through `sendPtyChunkPaced`, so the catch-up never re-creates the v3.5.5 single-huge-chunk freeze.
- **Reader-Live pauses on hidden panels** — `renderBlocks()` on a multi-MB jsonl produces a multi-MB HTML payload; sending one to a throttled webview every poll was a major piece of the same queue-flooding pattern. Hidden panels now mark a `pendingRender` flag instead of posting; the panel's `onDidChangeViewState` calls `entry._readerCatchUp()` on activation to do a single batched render. The split-pane reader catches up to the current transcript the moment you re-focus a tab.

### Added
- **PTY heartbeat for stuck-session detection.** Some patterns (OS sleep/wake, ConPTY pipe broken, Claude Code child zombied without emitting an exit event) leave an entry stuck in `running` forever — typing goes nowhere because the dead child never reads it, and PTY output never comes back. The classic symptom: closing the tab and resuming the same session restores it. v3.5.7 probes the child pid every 5 minutes with `process.kill(pid, 0)` (no signal sent, just an aliveness check); if the pid is gone but `onExit` never fired, the entry transitions to a new `stuck` state, the tab gets a ⚠ prefix, the icon turns red, and the tree refreshes — so the user knows to restart rather than wait. Slow cadence is deliberate: the goal is post-long-idle recovery hints, not real-time process supervision.
- **`scrollback: 5000` explicit on xterm.** The default 1000 lines fills in minutes on a long task; once full, xterm drops oldest lines and breaks history navigation on background sessions. 5000 covers most real-world session lengths while keeping the per-line memory cost bounded.

## [3.5.6] - 2026-05-13

### Added
- **Session metadata row shows the jsonl file size.** Expanding a session in the sidebar now reads `N turns · relative time · X MB` (or `KB`/`B` for small sessions). Makes it visible at a glance which sessions are growing into multi-MB territory and which can stay collapsed. Trash rows get the same treatment (`trashed · relative time · X MB`). Reuses the single `fs.statSync` call that was already happening for the mtime, so the extra information costs zero new syscalls. New `src/lib/sizeFormat.js` with `formatBytes()` helper kept module-pure for unit testing.

### Fixed
- **Cache size cap so tree refresh on a vault with huge sessions stops accumulating memory.** v3.5.5's line cache assumed jsonls would all be small. In the wild (iloom-workspace inspection: 656 files / 868 MB, with a 54 MB single jsonl and seven 13–48 MB scm-pdca sessions), a tree refresh — which calls `extractAiTitle` + `extractMessageCount` on every session in the project — used to land the biggest files in the LRU 20-slot cache, pinning **500–700 MB** of parsed JSON arrays in resident memory until they aged out. v3.5.6 adds `MAX_CACHEABLE_BYTES = 2 MB`: oversized files still get fully read + parsed (callers see no behavior change), they just skip the cache, so the next call re-parses from disk like in v3.5.4. The active-reader / split-pane render path is unaffected for typical session sizes (≈ 1.3 MB average); only the rare giants pay the re-parse cost they would have paid pre-v3.5.5 anyway.

## [3.5.5] - 2026-05-13

### Fixed
- **Extension host freeze when a large PTY chunk meets a chokidar event storm.** A single 51 KB PTY chunk (observed in the wild on session resume with a box-drawing + giant-table redraw) used to be handed to `panel.webview.postMessage` as one payload, serialized + IPC-marshalled + xterm-parsed on a single tick of the main thread. Combined with rapid-fire chokidar events from `repoSync` watching a vault that overlapped with hourly automation (sed temp files, log rotation), the extension host would tip into the `unresponsive` state — *every* session frozen, no key input, no new sessions, and eventually `PTY exited, code: undefined`. v3.5.5 unblocks both contributors.
- **`src/lib/ptyChunk.js`** — new module. Chunks ≤ 4 KB go through `postMessage` unchanged (no overhead); larger chunks are sliced into 4 KB pieces with `setImmediate` between each, so other pending tasks (other sessions' PTY data, keystrokes, command-palette dispatches) interleave. Slice boundaries avoid splitting in the middle of an ANSI CSI/OSC sequence; xterm.js's parser buffers partial escapes correctly anyway, but respecting boundaries keeps each IPC payload self-contained. `createPanel`, `restartPty`, and the webview-ready buffer-flush all route through the new helper. 14 unit tests cover plain text, ANSI-heavy frames, CSI/OSC boundaries, disposed-mid-flush, and the small/empty/large size matrix.

### Changed
- **`repoSync` chokidar watcher hardened against event storms.** The previous `ignored: /(^|[\/\\])\../` only excluded dot files, so `node_modules`, log rotation outputs, `*.tmp` files, and short-lived sed temp files (`sedLOvKxk` pattern) all fired add/change/unlink events. Combined with the matching `console.log` per event, this saturated the Extension Host console at 100+ lines/s during automation bursts. v3.5.5 ignores by default: dot files, `node_modules`, `log/`/`logs/` directories, `*.log` + rotated variants, `*.tmp`, `sed***` temp files, and vim swap files. New `claudeCodeLauncher.repoSync.extraIgnore` setting (array of glob/regex strings) lets users append more without forking the defaults.
- **`awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 }`** added to the watcher options. Transient files that are created and deleted within the window emit no event at all — exactly the right behavior for sed-style temp files that are gone before they need to be tracked.
- **`[sync]` console output throttled to ≤ 10 lines per minute** with a single "(suppressed N more events…)" line summarizing the overflow. Real repo activity stays debuggable; pathological event storms no longer drown out everything else in the host console.
- **`_pendingChanges` counter capped at 100 000.** `runSync` recomputes the real count from `git status --porcelain` anyway, so further increments past the cap during event storms were pure waste (and a memory smell in the status-bar tooltip).

### Performance
- **`sessionJsonl` line-cache.** `extractAiTitle`, `extractMessages`, and `extractMessageCount` used to each do a fresh `fs.readFileSync + JSON.parse` per call. A single split-pane reader render tick calls extractAiTitle *and* extractMessages back-to-back, so a 4 MB jsonl turned into 8 MB of disk read + two full parse passes per poll — and with 5 concurrent sessions polling, that compounded badly. v3.5.5 caches parsed lines keyed by `{mtime, size}`; repeat reads of an unchanged snapshot share one parse, and the cache invalidates automatically when the file actually changes. 8 new unit tests in `test/unit/sessionJsonlCache.test.ts` cover the cache reuse path, mtime/size invalidation, `_clearLineCache` semantics, and bounded LRU eviction at the 20-entry cap.
- **Reader polling interval 250/200 ms → 1000 ms.** Both `createPanel.js`'s split-pane reader and `readerView.js`'s standalone reader used to poll the active session's jsonl every 200–250 ms. Claude Code batch-flushes the jsonl at turn-end (empirically: 5 turn flushes with +35/+39/+15/+40/+7 line jumps, zero mid-stream increments), so polling faster than the actual flush cadence just burns `stat()` calls. 1 s keeps the "live" feel while cutting OS work per active session 4×–5×. Combined with the line-cache above, post-change re-renders also do one parse instead of two.

### Maintenance
- **GitHub Actions bumped to v5 series** (`actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, `actions/download-artifact`). Avoids the Node 20 → Node 24 runtime deprecation deadline (2026-06-02). Workflow logic unchanged — same matrix (win32-x64 / darwin-arm64 / linux-x64), same ovsx publish step.

## [3.5.4] - 2026-05-07

### Fixed
- **`Ctrl+Wheel` no longer scrolls while zooming.** v3.5.3 attached the wheel listeners during the bubble phase, but xterm's `.xterm-viewport` and the reader's native overflow scroll both react during the target phase, so the user saw the font resize *and* a simultaneous scroll. Listeners now run in capture phase (`{ capture: true, passive: false }`) and call `stopPropagation()` only when `Ctrl` is held — the inner scroll handlers never see those events, so Ctrl+Wheel is a pure zoom. Without `Ctrl` the early-return path leaves the event untouched, so normal wheel-scroll keeps working at native speed.

## [3.5.3] - 2026-05-07

### Added
- **`Ctrl+Wheel` zooms the terminal and the reader.** Hover the terminal area and `Ctrl + scroll up/down` resizes the xterm font; hover the reader area and `Ctrl + scroll up/down` resizes the reader font. Each side honors its existing slider's range (terminal 8–22 px, reader 10–24 px) and step (1 px). Without `Ctrl` the wheel still scrolls normally — terminal scrollback in the xterm pane, reader content in the reader pane.
- Persistence is unchanged: each zoom step fires the same `save-setting` message the sliders use (`defaultFontSize` / `readerFontSize`), so the new size carries to the next panel and stays in sync with the Settings modal sliders.

### Notes
- `wheel` listeners are registered with `{ passive: false }` and `preventDefault()` only when `Ctrl` is held, so non-zoom scrolling stays at native speed and the webview's outer page never zooms.

## [3.5.2] - 2026-05-06

### Added
- **Blue tab dot when a background shell is keeping a session warm.** When Claude Code prints `* Baked for … · N shell still running` after a turn, the panel now repaints the tab icon blue (`#2196F3`) instead of falling back to the gray idle dot. Reads at a glance: gray = nothing happening, yellow = thinking, blue = idle but a `Bash` shell is still running in the background, green = done, red = error. The tab icon is the only thing that changes — `entry.state` and the status bar are untouched, so existing automations keep working.
- New tab-icon state `shell-running` (asset `icons/claude-shell.svg`) and a `setIdleIcon(panel, entry, …)` helper in `statusIndicator.js` that picks between gray and blue based on a 30-second freshness window, with a self-rescheduling timer so the dot fades back to gray when the shell genuinely finishes (Claude Code does not always re-emit the line, so we cannot rely on a negative match).
- `src/lib/shellRunningDetect.js` — the regex extraction (`/(\d+)\s+shells?\s+still\s+running/i`) lives in its own helper so PTY detection works the same way from `createPanel` and `restartPty`. ANSI escape sequences are stripped before matching.
- 8 new unit tests in `test/unit/shellRunningDetect.test.ts` covering the canonical sentence, plurals, ANSI-coloured output, the chunk-tail trim, and the false-positive guards (no count, zero count, "1 shell" footer, plain "Bash shell exited"). Suite is now 153/153 passing.

## [3.5.1] - 2026-05-06

### Fixed
- **Restore platform-specific Open VSX publish.** v3.5.0 was published to Open VSX as a single universal VSIX (the v3.5.0 git tag was never pushed, so the GitHub Actions matrix build did not run). The universal package only ships one ABI build of `node-pty`, so on platforms whose Electron ABI does not match the build host the extension fails on session start with `node-pty native module incompatible`. v3.5.1 republishes through the existing matrix workflow (`win32-x64`, `darwin-arm64`, `linux-x64`) so each platform receives its own correctly rebuilt `node-pty`. No code changes vs v3.5.0.

## [3.5.0] - 2026-05-06

### Changed
- **Every session is rendered as `Collapsed`.** Sibling rows always reserve VSCode's caret column now, which fixes the v3.4.8–v3.4.15 "leaf-only sub-group children look flush with the sub-group header" bug at its root cause. The TreeView's column-reservation rule is what holds the hierarchy together — not label-prefix or padded-SVG hacks.
- **Session expand reveals a stat row** (`N turns · relative time`). Previously the caret expanded into nothing, which felt off. The metadata row both anchors the column hierarchy and gives the expand a real payload. Sub-sessions, when present, follow the metadata row. Trash entries get the same treatment.

### Removed
- **U+3000 ideographic-space label prefix workaround** (v3.4.13) and **padded-SVG icon assets** (v3.4.14, `icons/comment-discussion-padded.svg`, `icons/comment-draft-padded.svg`). Both replaced by the structural fix above.

### Fixed
- **Leaf-only sub-group children visibly nest under their sub-group header.** Seven prior iterations (v3.4.8 ASCII space, v3.4.9 NBSP, v3.4.10 `│` glyph, v3.4.11 phantom row, v3.4.13 ideographic-space prefix, v3.4.14 padded SVG, v3.4.15 thin prefix) attempted cosmetic fixes; v3.5.0 fixes it structurally by promoting all leaf sessions to `Collapsed` so VSCode's tree renderer reserves the same caret column for every sibling.

## [3.4.15] - 2026-05-06

### Reverted
- **Padded-SVG icon experiment (v3.4.14) reverted.** VSCode's tree view enforces a 16×16 icon column and `fill="currentColor"` is not applied to file/dataUri icons, so the 32×16 padded SVG rendered as a tiny black square instead of an icon shifted right. Returned to v3.4.13's thin label prefix (`　` × 1) for leaf-only sub-group children. Users wanting a more pronounced hierarchy depth should raise `workbench.tree.indent` in their `settings.json` — that's the only knob VSCode exposes for tree row indent. The padded SVG assets remain on disk in case a future approach can use them.

## [3.4.14] - 2026-05-06

### Changed
- **Leaf-only sub-group children: icon physically moves inward, not just the label.** Earlier attempts (NBSP/em-space prefix v3.4.8/9, visible `│` glyph v3.4.10, phantom row v3.4.11, ideographic-space prefix v3.4.13) all relied on label tricks, leaving the bubble icon glued to the same X as the sub-group folder. v3.4.14 swaps the codicon for a 32×16 SVG variant whose left half is transparent and right half carries the bubble path — the icon column itself slides 16px right, the label follows it, and the result reads as a true deeper hierarchy level. Two new assets (`icons/comment-discussion-padded.svg`, `icons/comment-draft-padded.svg`) ship with the extension; only leaf-only-sub-group children get the swap, so Recent Sessions and mixed groups remain untouched.

## [3.4.13] - 2026-05-06

### Fixed
- **Leaf-only sub-group children now visibly indent below the sub-group header.** When a custom group holds only leaf sessions (no sub-sub-groups), VSCode's tree skips the `▷` column and the children sit flush with their parent header — making "CLI 런처" look like a sibling of "서브 개인" instead of its child. Mixed groups (those with at least one sub-group) keep VSCode's native indent because the column is already reserved. Leaf-only groups now prefix each child label with U+3000 IDEOGRAPHIC SPACE × 4, the only practical way to add visible horizontal space inside a TreeItem (NBSP and EM SPACE both get collapsed by the renderer). The prefix is applied only on the leaf-only path, so groups with sub-groups remain untouched and identical to Recent Sessions.

## [3.4.12] - 2026-05-06

### Reverted
- **Phantom row removed.** v3.4.11's phantom collapsible sibling reserved the `▷` column at the cost of an empty extra row that users found visually noisy. Reverted to VSCode's native tree indent, which already nests sub-groups and their children correctly. The remaining "leaf-only sub-group children look flush with the sub-group header" case is a workbench tree quirk; users wanting a more pronounced hierarchy can raise `workbench.tree.indent` in their `settings.json` (default 8 → e.g. 16) — that affects every tree, not just this one, but is the only knob VSCode exposes for indent depth.

## [3.4.11] - 2026-05-06

### Fixed
- **Group children now align exactly like Recent Sessions.** v3.4.8/v3.4.9 (NBSP prefix) failed silently — VSCode tree label collapses non-breaking spaces. v3.4.10 (`│` glyph prefix) worked but added a printable artifact in front of every row. The new approach mirrors why Recent Sessions itself indents: it has a collapsible sibling somewhere in the list, so VSCode reserves a `▷` column for the whole group. Custom leaf-only groups now insert one phantom collapsible sibling (empty label, empty children, `contextValue='phantom'`) at the bottom — the column appears, every real child snaps to the same indent, and no labels are touched. Sub-group cases skip the phantom because sub-groups already provide the column.

## [3.4.10] - 2026-05-06

### Fixed
- **Group child indent now uses a visible tree-line glyph.** v3.4.8/v3.4.9 tried 4×NBSP and 8×NBSP prefixes, but VSCode's tree label renderer collapses leading non-breaking spaces too — the prefix never made it to screen. Switched to `│` (U+2502 BOX DRAWINGS LIGHT VERTICAL) + 2×NBSP, which renders the way scope guides do in editor gutters and finally makes the hierarchy obvious for leaf-only groups. The clone path is otherwise unchanged.

## [3.4.9] - 2026-05-06

### Fixed
- **Group child indent now actually shows.** v3.4.8's 4×NBSP prefix wasn't visible — either VSCodium normalized leading non-breaking spaces too, or the same-version vsix re-install short-circuited cache reload. Bumped to v3.4.9 (forces a real activation cycle) and widened the prefix to 8×NBSP. If this still reads flush against the group header, the next iteration switches to a visible tree-line glyph (e.g. `│`).

## [3.4.8] - 2026-05-06

### Fixed
- **Custom group children now visibly indent under the folder header.** Sessions inside a custom group sat flush against the group's own indent, so the hierarchy read as a single block. The cause was VSCode's TreeView only reserving a `▷` collapse column when at least one sibling is collapsible — Recent Sessions usually has a sub-session in the mix, so its children auto-align, but a leaf-only custom group skipped that column entirely. The tree provider now clones each direct child with a thin two-space label indent (preserving `_sessionId`, `command`, `iconPath`, sub-session `_children`, etc.) so leaf-only groups read with the same visual nesting users expect from Recent Sessions.

## [3.4.7] - 2026-05-06

### Fixed
- **In-panel reader on Windows now actually receives session output.** The split-layout reader stayed pinned at "Waiting for session output…" on Windows even after Claude Code wrote the first turn to its jsonl. Root cause: `lib/sessionJsonl.getSessionJsonlPath()` folded `[/\\' ]` to `-` but did **not** include `:`, so a Windows cwd like `C:\Users\foo\proj` encoded to `C:-Users-foo-proj` and the watcher tailed a path that doesn't exist — Claude Code's actual folder is `C--Users-foo-proj` (both `:` and `\` collapsed to `-`). macOS paths never contain `:`, so the bug never surfaced on Mac. The strip set now includes `:`.

### Changed
- **Splitter drag now reaches reader=92% (terminal=8%).** v3.4.1 introduced a dynamic minRows guard (`1 − terminalMinRows×charHeight/splitH`) that pinned reader's max at ~0.55–0.60 on typical heights, so users couldn't make the terminal narrow when reading a long answer. The cap is back to a flat 0.92 — `#terminal`'s CSS `min-height` + xterm scrollback keep the pane usable, and anyone who clips the Claude TUI ctx line can simply drag back. `terminalMinRows` setting is kept for forward compatibility but no longer feeds the drag clamp.

### Added
- **"Reader Default Height" slider in the settings modal.** Settings → Split Layout (Default) now has a sibling slider that controls the default reader/terminal ratio (15–92%, in 1% steps). Mirrors the in-panel splitter drag — both write the same `claudeCodeLauncher.splitRatio` globalState — so users can either drag the handle or set a precise value from the modal, and changes live-preview into the active panel as the slider moves. The slider re-syncs from the live `flexBasis` whenever the modal reopens, so a recent drag isn't shown as stale.

### Internal
- New `test/unit/sessionJsonl.test.ts` — 8 cases covering macOS leading-slash, Windows backslash, Windows forward-slash, apostrophe (`Won's 2nd Brain`), space, drive-letter casing preservation, missing-arg null-return, and the full `~/.claude/projects/` anchoring.

## [3.4.6] - 2026-05-04

### Fixed
- **Bare-filename anchor click no longer falls into the noop branch.** v3.4.5 added bare-filename matching in `linkifyHtml` and cwd resolution in `messageRouter.open-path`, but the webview-side `setupReaderLinks` only dispatched `open-path` for hrefs starting with `/`, `~`, `file://`, or a Windows drive letter. Bare hrefs like `README.md` matched none of those branches, fell through, and the click silently no-op'd — so the router's new cwd resolution never ran. The handler now treats any anchor with `class="auto-link"` (i.e. anything `linkifyHtml` itself produced) as a path candidate and dispatches `open-path`, leaving absolute-prefix paths and existing markdown-form `[txt](/path)` links on their previous routing.

## [3.4.5] - 2026-05-04

### Added
- **Bare-filename autolink + cwd-relative resolution.** Plain `README.md`, `src/foo.ts`, `package.json` style references now turn into clickable anchors in the reader (previously only absolute paths and tilde / drive-prefixed paths matched). The `open-path` router resolves any non-absolute click against the active Claude session's `entry.cwd` before stat, so `README.md` clicked inside a `cli-launcher-for-claude` session opens `/Users/.../cli-launcher-for-claude/README.md` — and `handleOpenFile`'s existing `fileAssociations` honors the user's `.md → Obsidian` mapping (with IDE fallback when Obsidian isn't installed). Right-click "Open File" already worked this way; left-click now matches.

### Internal
- New `BARE_FILE_RE` in `src/lib/readerRender.js` — known-extension match with a negative lookahead that excludes paths already covered by `FILE_PATH_RE` (absolute / tilde / Windows drive). Anchor href stays as the bare token; resolution lives entirely in the router so the rendered HTML is portable.
- 6 new `linkifyHtml.test.ts` cases — bare filename, bare relative path with directory, bare filename in inline `<code>`, coexistence with absolute paths, unknown-extension rejection, `:LINE` suffix preservation.

## [3.4.4] - 2026-05-04

### Changed
- **Inline `<code>` no longer blocks reader autolink.** Claude Code answers commonly backtick-quote paths (`` `/Users/foo/bar.md` ``) — under v3.4.3's protection list those landed inside an `<code>` element and `linkifyHtml` skipped them, so the rendered token wasn't clickable. Inline `<code>` is now linkified just like surrounding paragraph text. Multi-line `<pre>` code blocks remain protected so a 200-line snippet doesn't sprout dozens of stray anchors.

## [3.4.3] - 2026-05-04

### Added
- **Plain-text autolink in the reader.** Reader-area now turns plain-text URLs, known-extension file paths (`.md`, `.ts`, `.json`, `.png`, `.pdf`, …), and folder paths (anything ending with `/`) into clickable anchors automatically — no markdown link syntax required. The existing reader anchor click handler routes them through the same `open-link` / `open-path` flow that already powered markdown-form links: URLs go to the system browser, files open in the IDE (with `:LINE` suffix honored), folders open in Finder/Explorer.

### Internal
- New `linkifyHtml(html)` in `src/lib/readerRender.js`. Three-stage protection: stash existing `<pre>` / `<code>` / `<a>` / `<script>` / `<style>` regions as placeholders → run URL / file-path / folder-path regex sweeps (each new anchor also stashed so subsequent passes can't double-wrap) → restore all stashes. Trailing sentence punctuation (`.,;:!?)]`) is excluded from anchor matches via lookahead so URLs/paths preserve readable surrounding text.
- New `LINKIFY_EXTENSIONS` (60+ entries: code, config, docs, images, archives, media). Conservative list — only triggers on filenames ending with these so generic dotted phrases stay plain text.
- New `test/unit/linkifyHtml.test.ts` — 20 unit tests cover URL wrapping, deep paths, trailing punctuation, `<code>`/`<pre>`/`<script>` protection, existing `<a>` non-double-wrap, tilde + drive-letter paths, `:LINE` suffix preservation, mixed URL+path+folder paragraphs, and unknown-extension rejection.

## [3.4.2] - 2026-05-04

### Changed
- **`terminalMinRows` default 8 → 14.** v3.4.1's 8-row floor was enough for the legacy Claude Code TUI but not for v2.1+ — the new layout reserves more rows for the prompt header (`Claude Code v2.x.x`), the model line, the cwd line, the bypass-permissions hint, and the input prompt itself, pushing the ctx status line out of frame on tall reader / short terminal splits. 14 covers the v2.1+ idle layout with a one-line margin. Users on smaller fonts can still lower it via settings; users seeing the ctx line clipped can raise it.

## [3.4.1] - 2026-05-04

### Fixed
- **Split layout no longer hides the Claude Code TUI status line.** With the v3.2.1 default ratio of 0.85 (reader 85% / terminal 15%), tall fonts or shorter window heights could shrink the xterm pane below the row that draws `ctx:XX%` / `Claude idle` info. Because Claude redraws based on the current row count, the ctx line stopped appearing in PTY chunks, which in turn broke the launcher's toolbar `ctx` indicator. The splitter now enforces a configurable minimum xterm row count: drag clamping uses a dynamic max ratio derived from the live cell height, and a saved ratio that violates the guard is corrected on startup (and re-corrected on window resize).

### Settings (new)
- `claudeCodeLauncher.terminalMinRows` (default `8`, range 3–30) — minimum xterm rows the terminal pane is guaranteed when split layout is on. Increase if you use a larger reader font; decrease if you intentionally want a tiny terminal.

### Internal
- `setupSplitter` (`src/panel/webviewClient.js`) gained `getCharHeight()` (measures cell height from the live terminal element instead of poking xterm internals), `computeMaxRatio()` (translates the row-count guard into a per-frame ratio cap), and `enforceMinRows()` (re-applies the cap on startup + window resize, and persists the corrected ratio so future panels start inside the guard).

## [3.4.0] - 2026-05-04

### Added
- **Slash registry — extra Claude Code built-ins in autocomplete.** Every Claude Code built-in slash that already had a translation in v3.2.1 but was never spread into the live menu now appears in the autocomplete dropdown by default: `/resume`, `/export`, `/usage`, `/effort`, `/fast`, `/output-style`, `/statusline`, `/security-review`, `/agents`, `/mcp`, `/hooks`, `/permissions`, `/ide`, `/add-dir`, `/vim`, `/bug`, `/install-github-app`, `/upgrade`, `/migrate-installer`, `/release-notes`.
- **Personal catalog override (opt-in).** A maintainer can drop a `src/lib/slashRegistry.local.js` sibling file to wire in their own `.claude/commands/*.md` project slashes (tagged `[PKM]`) and `/oh-my-claudecode:<skill>` catalog (tagged `[OMC]` / `[OMC alias]`) without publishing them. The local file is `.gitignore`d, so personal slashes never land in the published vsix. See **README §"Registering your own slashes"** for a Claude Code prompt that builds the file from your local environment.

### Settings (new)
- `claudeCodeLauncher.slashRegistry.includeBuiltinExtras` (default `true`) — include the extra Claude Code built-ins in the dropdown.
- `claudeCodeLauncher.slashRegistry.includePkm` (default `true`) — include `[PKM]`-tagged project slashes loaded from the personal override (no-op for users without `slashRegistry.local.js`).
- `claudeCodeLauncher.slashRegistry.includeOmc` (default `true`) — include `[OMC]`-tagged oh-my-claudecode slashes loaded from the personal override (no-op for users without `slashRegistry.local.js`).

### Internal
- New `src/lib/slashRegistry.js` — public-build catalog (BUILTIN_EXTRAS only) plus a `try { require('./slashRegistry.local') } catch` shim that loads personal catalogs when present. Each entry stores `desc` as `{ ko, en }`; `resolveExtraSlashes(locale, options, T)` flattens to `{ cmd, desc }[]` server-side so the webview client only handles the rendered shape. Display order: PKM → OMC alias → OMC namespaced → built-in extras (built-ins last so the long alphabetical tail doesn't bury custom commands).
- `createPanel.js` resolves the registry once per panel and forwards it through `getWebviewContent` → `getClientScript` to the webview as the new `EXTRA_SLASH` array. The existing `customSlashCommands` user-editable list is preserved verbatim (still spread before `EXTRA_SLASH`).
- New `test/unit/slashRegistry.test.ts` — 18 unit tests cover the public-build empty-catalog path, `setLocalOverride()` test seam, group toggles, locale picking, prefix tagging, T fallback, partial-override semantics, and reset behavior. `tsconfig.test.json` opts the JS module in via `allowJs: true` + explicit include.

## [3.3.0] - 2026-05-03

### Added
- **Open Link from selection** — drag-select any URL or domain in the xterm or split-layout reader, right-click → "링크 열기 / Open Link" → opens in the external browser. Accepts `http(s)://…` as-is, `www.…` and `domain.tld[/path]` get an automatic `https://` prefix. Wrapping punctuation (quotes, parens, angle brackets) and trailing punctuation are stripped before matching. Selections that don't look like a URL (plain words, emails, unsupported schemes) show a "유효한 URL이 아닙니다" toast instead of dispatching. The extension-side `open-link` handler keeps its `^https?://` guard, so client-side normalization can never bypass scheme safety.

### Internal
- New `normalizeUrlFromSelection` helper in `webviewClient.js` — stage A (whitespace/newline collapse + outer punctuation strip), stage B (scheme detection), stage C (domain-shape regex with TLD 2–24). 19 input cases verified (http/https, www, deep paths, country TLDs, wrapping punctuation, emails rejected, foreign schemes rejected).
- `messageRouter.js` unchanged — the existing `case 'open-link'` keeps `vscode.env.openExternal` gated to `^https?://`. Reader-side `setupReaderLinks` and ctxMenu both feed through the same single sink.

## [3.2.1] - 2026-05-03

### Added
- **Inline binary prompt approval (Phase 4-extra)** — PTY output is matched against `[Y/n]`, `[y/N]`, `(y/n)`, `(yes/no)` patterns at the chunk tail. When detected, a small bar above the reader shows Approve / Reject buttons; click writes `key + CR` back into the PTY. `[Y/n]` highlights Approve as default; `[y/N]` highlights Reject. `(yes/no)` writes the full word. Auto-hides after 30s; dismiss (×) clears without sending input. Hides when split layout is off.
- **Reader Font Size slider** — Settings → "Reader Font Size" range (10–24px, default 12). The reader pane uses a CSS variable `--reader-font-size`, so timestamps, message headers, code blocks, and the meta header all scale proportionally via em. Live applies on drag without reload; persisted as a global user setting.

### Changed
- **Default split ratio 0.7 → 0.85** — new tabs reserve 85% for the reader, ~15% for the xterm TUI, matching the design intent of "TUI ~4 lines small, reader prominent". Existing per-tab ratios in `globalState` are preserved.
- **Slash command translations expanded** — Korean and English labels added for `/resume`, `/export`, `/usage`, `/effort`, `/fast`, `/output-style`, `/statusline`, `/security-review`, `/agents`, `/mcp`, `/hooks`, `/permissions`, `/ide`, `/add-dir`, `/vim`, `/bug`, `/install-github-app`, `/upgrade`, `/migrate-installer`, `/release-notes`.

### Fixed
- **Binary prompt re-fire after response** — terminal redraws and post-response command echoes that replayed the original prompt text were re-triggering the inline bar. `detectBinaryPrompt` now anchors matching to the trailing 400 chars (where the cursor parks waiting for input), and `createPanel` tracks `_lastPromptKey` / `_lastPromptAt` to suppress an identical kind+snippet within a 5-second window. The dedupe key is cleared on `prompt-respond` so a legitimate follow-up prompt right after the response can still fire.

### Settings (new)
- `claudeCodeLauncher.readerFontSize` (default `12`, range 10–24) — font size in pixels for the reader pane. Children scale via em.

## [3.2.0] - 2026-05-03

### Added
- **Reader Live Watch (Phase 1)** — chokidar polling tail of the active session jsonl auto-refreshes the standalone reader panel as Claude streams new turns. 200ms debounce after each turn-end flush. macOS fsevents misses single-file watches under hidden `~/.claude/projects/...`, so polling (`usePolling: true, interval: 200`) is used for reliability. The ● live dot in the top-right flashes on each refresh.
- **Reader Input Box (Phase 2)** — textarea + Send at the reader bottom. Three-mode payload routing matching the main editor: >`pasteToFileThreshold` → temp file + `@<path>`, multiline → bracketed paste sequence (`\x1b[200~ ... \x1b[201~`), single line → `text + \r`. IME-safe Enter (`e.isComposing`). Typing indicator pulses orange from PTY write until the assistant turn lands (`lastRole` payload check). PTY-dead state disables input + shows inline error.
- **Split Layout (Phase 3)** — single cli-launcher panel now hosts the markdown reader and the xterm TUI together with a drag splitter between them. Default 70/30 reader/terminal, persisted to `globalState` (`claudeCodeLauncher.splitRatio`), clamped 0.15–0.85 so neither pane collapses. Toolbar 👁 (replacing 📖) toggles the split for the active tab only; new setting `claudeCodeLauncher.splitLayoutDefault` decides the initial state for newly opened tabs. Standalone reader panel is still reachable via the right-click context menu.
- **Reader file/folder open (Phase 4)** — anchor clicks inside the reader route through the extension. `http(s)` reuses the existing `open-link` handler; absolute paths, `~` paths, `file://`, and `:LINE` suffixes go through a new `open-path` case that stats and dispatches to `handleOpenFile` or `handleOpenFolder`. Right-click in the reader works too: when xterm has no selection, `ctxSelectionCache` / `readSelection` fall back to `window.getSelection()`, so the existing Open File / Open Folder context items operate on selected reader text.

### Changed
- **Assistant role color → Claude orange.** Both the split-layout reader (`webviewStyles`) and the standalone reader panel (`readerView`) use `#D97757` (dark) / `#C96442` (light) for the assistant role badge and message-body left border. User role color (cyan/blue) is unchanged.
- **Toolbar 📖 → 👁.** The button that opened the standalone reader was repurposed: it now toggles the in-panel split layout. The standalone reader stays available via the right-click context menu (Reader).

### Internal
- New `src/lib/readerRender.js` — `escapeHtml`, `formatStamp`, `buildMeta`, `renderBlocks` extracted from `readerView` so both `readerView` and `createPanel` share a single rendering path.
- `createPanel.js` gained `startReaderWatch(entry, panel)` — chokidar polling on the session jsonl, 200ms-debounced render, posts `reader-update` to the webview. Cleaned up via `entry._stopReaderWatch` on dispose.
- `messageRouter.js` gained two new cases: `save-split-ratio` (writes `globalState`) and `open-path` (file:// decode, `~` expand, `:LINE` strip, `fs.statSync` → dispatch).
- `webviewClient.js` gained `setupSplitter`, `setupReaderLinks`, `applySplitVisibility`, `markReaderTyping` (4 trigger points: xterm Enter, editor textarea, queue, custom buttons), and a `reader-update` message handler.

### Settings (new)
- `claudeCodeLauncher.splitLayoutDefault` (default `false`) — show the in-panel reader+terminal split by default in new tabs.

## [3.1.0] - 2026-05-02

### Added
- **Reader panel** — read-only markdown viewer for the active session. Pulls user / assistant turns directly from the session jsonl (`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`) instead of scraping the PTY transcript, so the rendered output is clean markdown with zero ANSI / CR / alt-screen workarounds. Filters out thinking blocks, `tool_use` / `tool_result`, attachments, sidechain, and system-tag-prefixed strings. Single shared panel: subsequent invocations re-render in place.
  - **Theme toggle** in the top-right (☀ / 🌙) — choice persists in `ExtensionContext.globalState`. Default = dark; both themes use brighter foreground tokens for legibility. CSP locks the panel to a nonce'd inline script.
  - **Save as Markdown** (💾) — `showSaveDialog` defaulted to `<workspace>/reader-<timestamp>-<title>.md`. Writes user / assistant turns as `## user — <ts>` / `## assistant — <ts>` sections; the success toast offers an Open action.
  - Entry points: toolbar 📖 button + right-click "Open in Reader".
- **Sidebar tree label fallback** — sessions without a saved title now fall back to the jsonl `ai-title` (Claude Code's auto-generated title) before the first-user-message fallback. Both saved and ai-titled sessions get the `comment-discussion` icon.
- **Repo Sync — Sprint 1: auto-commit + push.** When `claudeCodeLauncher.repoSync.autoCommit` is on, file changes are buffered behind a debounce window (default 5 min) and flushed via `git add -A && commit -m "[<device>] auto-sync: <ts> (<n>)"` followed by a fire-and-forget push. Failures surface on a new left-aligned status bar item (states: disabled / idle / pending / syncing / error). On first use, an InputBox prompts for a device name and saves it to user settings (`ConfigurationTarget.Global`). New commands: `Repo Sync: Set Device Name`, `Repo Sync: Open Settings`.
- **Repo Sync — hot reload.** `onDidChangeConfiguration` restarts the watcher when any `repoSync.*` key changes — Reload Window is no longer required.
- **Repo Sync — shutdown safety.** `deactivate()` runs a synchronous best-effort commit so the last debounce window's changes don't get stranded if VS Code is closed before the timer fires.

### Changed
- **Export Conversation removed.** The 💾 export button (which scraped the xterm viewport with all its ANSI / alt-screen quirks) was replaced by the new Reader. The `src/handlers/exportConversation.js` module, the `export-conversation` message route, the `export-result` toast handler, and 9 i18n keys (`exportTip`, `ctxExport`, `exportingToast`, `exportDone`, `exportFailToast`, `exportFail`, `exportLabel`, `conversationSaved`, `fsExportWarn`) were all dropped.

### Internal
- New `src/lib/sessionJsonl.js` — shared jsonl parser used by both the sidebar tree label fallback and the reader panel. Handles the encoded-cwd path convention (`[/\\' ]` → `-`), ai-title scan, first-user-message scan, and message extraction.
- New `marked@^18` dependency for jsonl text → HTML rendering.

### Settings (new)
- `claudeCodeLauncher.repoSync.autoCommit` (default `false`)
- `claudeCodeLauncher.repoSync.deviceName` (default `""` — prompted on first sync)
- `claudeCodeLauncher.repoSync.debounceMs` (default `300000`, min `10000`)

## [3.0.4] - 2026-05-02

### Changed
- **HUD status bar — no click handler.** Removed the `command:` binding on the HUD status bar item. Hovering still surfaces the same rate-limit tooltip; clicking is now a deliberate no-op so the bar acts as a passive indicator. The `claudeCodeLauncher.hud.show` command (which dumped the raw HUD JSON to the orchestration output channel) was deleted entirely along with its package.json registration.
- **HUD percentages — integers.** `formatPct()` now uses `Math.round()` instead of `toFixed(1)`, so the status bar reads `5h:28%` / `7d:9%` instead of `28.0%` / `9.0%`. The tooltip mirrors the same precision.
- **OMC mode — always-on by default + status pill removed.** The dedicated `$(organization) OMC` / `$(organization) OMC OFF` status bar pill and the first-run onboarding info message were both removed. `activateOMCMode()` now flips the `claudeCodeLauncher.omcModeActive` context key to `true` on activate without consulting `decideInitialMode()` — CCG and HUD UI surface immediately on first install. The `claudeCodeLauncher.omc.enter` / `omc.exit` commands stay registered (and persist via `globalState`) for power users who want to flip the mode off through the command palette.

### Internal
- `omcMode.ts` shrank from 152 → ~75 lines after dropping the status bar UI, the onboarding branch, and the initial-state decision tree. The pure logic in `omcModeLogic.ts` and its six `decideInitialMode` unit tests are unchanged — the function is still re-exported from `omcMode.ts` so any external import keeps working.
- `HUDStatusBarItem` tooltip dropped the `_Click to open CLI Launcher HUD._` footer that turned misleading once the click handler was gone.

## [3.0.3] - 2026-04-29

### Changed
- **HUD status bar — one-decimal percentages.** `5h` and `7d` rate-limit usage now render with one decimal place (`28.0%`) instead of the raw float that occasionally surfaced JS arithmetic noise like `28.000000000000004%`. Tooltip mirrors the same precision.
- **7d reset clock — 12-hour am/pm form.** Switched from the 24-hour `M/D, Hh` form to a more compact 12-hour form: `5/6,6am` / `5/6,6pm` (`12am` for midnight, `12pm` for noon). The comma now sits flush against the hour to keep the segment tight.

### Internal
- Added `formatPct(v)` helper used by both the status bar and the tooltip so percent formatting can't drift between the two surfaces.

## [3.0.2] - 2026-04-28

### Changed
- **HUD status bar — trimmed to rate-limits only.** Removed the model name, context-window %, and session cost segments from the status bar pill. The bar now surfaces only the two rate-limit pieces most operators actually watch:
  - `$(clock) 5h:NN% (HH:MM)` — 5-hour window with reset clock time.
  - `$(calendar) 7d:NN% (M/D,HHh)` — 7-day window with month/day + reset hour.
- Status bar color now tracks the higher of 5h / 7d usage (≥85% failed-red, ≥60% running-amber, otherwise OMC orange) instead of context %.
- Tooltip mirrors the same two-line layout — model / session / context / cost markdown sections were removed; both rate limits now show their reset time.

### Internal
- Dropped unused `shortModel` / `formatUsd` re-exports and the `formatDuration` helper from `HUDStatusBarItem.ts`. The pure formatters in `hudFormatters.ts` are kept as-is (still covered by unit tests so no test churn).

## [3.0.1] - 2026-04-26

### Fixed
- **Multiplexer backend on Windows**: opening the launcher with
  `claudeCodeLauncher.terminal.defaultBackend = "multiplexer"` produced a
  `Claude Code 시작 실패: File not found:` toast and disposed the panel
  before any output. Root cause: bare binary names (`psmux`/`tmux`) were
  passed to `pty.spawn`, but node-pty's `WindowsPtyAgent` does not search
  `PATH` — it calls `fs.existsSync()` on the string directly, so the spawn
  threw "File not found:" even though `child_process.execFileSync` had
  successfully resolved the same binary in the detect step. Now resolved to
  an absolute path via `where` / `which` during detect and reused for
  spawn. Hosts without psmux/tmux still fall back silently to webview.

## [3.0.0] - 2026-04-26

### OMC integration arc — major chapter restart

After the brief Podium fork was archived, active development returned to this repo
and shipped the OMC integration as additive features on top of the v2.6.6 launcher.
None of the v2.6.x behavior was removed. The v3.0 number reflects the surface area
added (TS toolchain, multi-backend terminal, OMC-gated UI), not breaking changes.

#### Added — toolchain (Phase 0)
- TypeScript + esbuild + `node:test` build pipeline.
- `vscode` engine bumped to `^1.85.0`.

#### Added — multiplexer abstraction (Phase 1, 6, 9, 12)
- `IMultiplexerBackend` + `TmuxBackend` (Mac/Linux) + `PsmuxBackend` (Windows).
- New settings: `terminal.defaultBackend`, `terminal.multiplexerLifecycle`,
  `multiplexer.preferred`.
- Smart `Open Claude Code (use default backend)` wrapper drives keybinding +
  editor title icon. Explicit *Open Claude Code* (Webview) and *Open Claude Code
  in tmux/psmux* commands stay in the palette for per-action overrides.
- In-place multiplexer mode: same Webview tab, multiplexer client inside.
- `kill-on-close` lifecycle (default) avoids zombie sessions; `detached` for
  external attach workflows; *Clean Up Detached Multiplexer Sessions* command.
- Silent Webview fallback when no multiplexer binary is on PATH.

#### Added — OMC mode (Phase 3, 4)
- `OMCRuntime.detectOMC()` two-of-three majority detection.
- `claudeCodeLauncher.omcModeActive` context key + *Enter / Exit OMC Mode*.
- One-time onboarding info message when OMC is detected.

#### Added — CCG tri-model viewer (Phase 5)
- Sidebar tree of every `/ccg` artifact pair (`.omc/artifacts/ask/`).
- Per-pair Webview comparison panel (~10 KB esbuild bundle).
- Commands: *Show CCG*, *Refresh CCG*, *Open CCG Pair*, *Rerun CCG* (OMC-gated).

#### Added — HUD status bar (Phase 7)
- `<workspace>/.omc/state/hud-stdin-cache.json` watcher.
- Status bar pill: model / context % / total cost / 5-hour rate-limit %.
- *Show HUD Snapshot* dumps the live JSON to the orchestration output channel.

#### Added — file-path UX (Phase 11)
- Brace expansion in *Open File* / *Open Folder* handlers — patterns like
  `worker-{1,2,3}/answer.md` open every alternative in one click.

#### Added — nested session groups (Phase 13 + hotfixes)
- Sub-folder support up to depth 3 (e.g. `Work/Backend/API`).
- *Add Sub-Group* + *New Sub-Group…* in *Move to Group…* picker.
- *Rename Group* migrates every descendant path prefix automatically.
- *Delete Group* removes self + descendants behind a confirm dialog.
- Single-segment groups continue to work identically (zero regression).

#### Added — per-session backend override (Phase 10)
- *Resume in Webview* / *Resume in tmux/psmux* on the right-click menu of any
  saved session.
- IDE-startup auto-restore respects `terminal.defaultBackend`.

#### Added — in-app settings (Phase 8b, 12)
- *Default Terminal* and *Multiplexer Lifecycle* dropdowns in the launcher's
  gear modal — same dotted keys as the host Settings UI.

#### Fixed
- `colors.ts`/`HUD` modules split so unit tests don't need a vscode mock.
- Editor title button regained its Claude robot icon after Phase 8 hand-off.
- Empty sub-group `null` dereference in the tree builder (Phase 13 hotfix).
- Sub-group disappear-on-move where moving the last session out of a root
  group emptied the path key and lost both root and sub-group from the
  tree — preserve key + render-time ancestor synthesis (Phase 13 hotfix-2).

#### Background
This release closes the cli-launcher → Podium → cli-launcher round-trip.
The Podium fork is archived at v0.16.0; OMC features now live here as
opt-in extensions of the launcher rather than a separate product.

## [2.7.25] - 2026-04-22

### Final Deprecation Release

This release marks the **end of `rockuen.cli-launcher-for-claude`**. The extension has been rebranded and continues as **Podium CLI Launcher for Claude** — please install the new extension for future updates:

- **New GitHub repo**: https://github.com/rockuen/podium
- **New Open VSX listing**: `rockuen.podium`
- **Migration**: VSCode/Antigravity has no automatic upgrade path between different extension IDs. Uninstall `rockuen.cli-launcher-for-claude` and install `rockuen.podium` manually.

### Content

The functional content of v2.7.25 is **identical to v2.6.6** (stable launcher, no Podium orchestration). Intermediate versions v2.6.7 through v2.7.24 were WIP integration builds now superseded by the Podium rebrand and no longer distributed here.

## [2.6.6] - 2026-04-17

### Added
- **Interactive prompt detection — fast-path to needs-attention** — When the PTY emits a Claude CLI confirmation prompt ("Do you want to…", "[Y/n]", "Press Enter to continue…", etc.), the tab now flips to `needs-attention` immediately instead of waiting out the 7-second running threshold. Brief prompts that finished setup in 2 seconds and silently sat asking for a Yes/No no longer go unnoticed.
- **Tab title blink while needs-attention** — The webview tab title prefixes a `⚠` glyph that flashes every 800 ms whenever the tab is unfocused **and** in `needs-attention` state. Self-stops when you focus the tab, when the state transitions away, or when the panel is disposed. Combined with the existing desktop notification + status bar prominent background, the tab is now genuinely hard to miss when Claude is waiting for an answer.

## [2.6.5] - 2026-04-17

### Added
- **Reorder custom buttons in settings** — Each custom button row in the Settings → Custom Buttons list now has ▲/▼ arrows next to the delete X. Click to swap with the adjacent row. The top row's ▲ and the bottom row's ▼ are hidden so you always know what will happen. Order is persisted to `customButtons` and reloads into the toolbar on the next window reload.
- **Edit custom buttons in place** — Click the label or command text of any custom button row to turn it into an inline input. Enter commits the edit, Escape cancels, blur commits. No separate edit dialog — same hover affordance pattern as the delete X and the new move arrows.
- **Auto /effort max on first idle** — Optional toggle in Settings. When on, each session automatically sends `/effort max` the first time it reaches an idle state after startup. Useful when Reload Window restores many resume-later sessions and you want them all back on max effort without visiting each tab. Off by default. Fires once per session — manually changing the effort later is not overridden.

### Changed
- **Smooth wheel scroll in normal mode** — Enabled xterm.js `smoothScrollDuration: 120` so wheel scrolling over the scrollback buffer glides between frames instead of jumping line-by-line. Applies only to xterm's native scroll API path (normal buffer with scrollback), so fullscreen TUI mode is unaffected — the TUI (Claude CLI) still drives its own partial redraws there, and any fake CSS smoothing would collide with partial frame updates and re-introduce ghost artifacts.

## [2.6.4] - 2026-04-17

### Added
- **Redraw screen — recover from fullscreen rendering corruption without losing context** — Wheel scrolling in Claude CLI's fullscreen TUI sometimes leaves overlapping text or ghost lines behind (the TUI's partial-redraw pipeline doesn't always flush its frame buffer cleanly). Added a `↻` button in the toolbar (visible only while alternate screen is active) and a `Ctrl+Shift+R` shortcut that trigger a full redraw. Mechanism: webview repaints xterm via `term.refresh()`, then the extension toggles the PTY size by 1 column and back — Claude CLI receives two SIGWINCH signals and redraws from scratch. Unlike `/clear` or `/compact`, **no session, scrollback, or conversation state is touched** — it's a purely visual refresh.

## [2.6.3] - 2026-04-16

### Fixed
- **FS mode stuck detecting fullscreen when Claude CLI isn't in it — wheel scroll broken** — The mouse-mode tracking flag was kept alive by the enable/disable escape sequences alone. If Claude ever failed to emit the disable sequence on TUI exit (or a write-chunk boundary sliced the sequence and broke our regex), `isMouseMode` stayed `true` indefinitely, hijacking wheel events into SGR reports that the non-fullscreen Claude CLI couldn't consume. Now wheel forwarding requires **both** `isAlternateScreen` (authoritative via `term.buffer.onBufferChange`) **and** `isMouseMode`, and any return to the normal screen buffer force-clears the mouse-mode flag.

### Added
- **Click FS indicator to force normal mode** — Escape hatch for rare cases where detection is still wrong. Clicking the amber `FS` badge in the toolbar toggles a user override: the badge turns grey, strikes through (`FS×`), and the terminal behaves as if fullscreen were off — wheel scrolls locally, drag/copy work as usual. Click again to return to auto-detect. The override auto-clears when the buffer returns to normal, so you don't have to remember to toggle it back.

## [2.6.2] - 2026-04-16

### Fixed
- **Ctrl+C still forwarded to PTY after copy (leaking ^C to Claude CLI exit prep)** — The v2.6.1 document-level Ctrl+C handler correctly did the clipboard copy, but it also naively skipped all `<textarea>` targets to preserve native input copy. xterm.js uses a hidden `xterm-helper-textarea` to capture keyboard input, so focus inside the terminal classified as TEXTAREA → the handler skipped → xterm's internal processing forwarded ^C to the PTY. Claude CLI then started its "Press Ctrl+C again to exit" countdown even though the copy had succeeded. Now we detect xterm's internal textarea by checking `#terminal.contains(e.target)` and always proceed with copy in that case, only bailing for real user-facing inputs. Added `stopImmediatePropagation()` and restored a selection-guard inside `attachCustomKeyEventHandler` (returns `false` when selection exists) as belt-and-suspenders protection.
- **Open Folder failed for partial/nested paths** — `handleOpenFile` had a basename-search fallback that walked the cwd tree up to depth 6 to locate files like `slack-manifests/01-demand-forecast.yaml`, but `handleOpenFolder` skipped this branch and just errored out when the first resolve attempt failed. Mirrored the same fallback so selecting a relative file path and choosing "Open Folder" now finds the file anywhere in the workspace tree and opens its containing directory in the OS file explorer.

## [2.6.1] - 2026-04-16

### Changed
- **Context indicator click → `/compact`** — Clicking the toolbar context-usage bar used to re-query usage via `/context`. But usage already updates automatically from output, so the click was most often used when the bar entered the danger zone and the user wanted to compact anyway. One less command to type.

### Fixed
- **Ctrl+C copy unreliable after drag-select** — `attachCustomKeyEventHandler` only fires when xterm's internal textarea has focus, but drag-to-select in fullscreen/alternate-screen mode can leave focus on the viewport div instead. Moved the Ctrl+C copy logic to a document-level capture-phase listener so it runs regardless of which element inside the webview holds focus. Real `<input>`/`<textarea>` targets are skipped so native input-field copy still works, and the "send ^C to PTY when no selection" path is preserved (non-handled events fall through to xterm's default).

## [2.6.0] - 2026-04-16

### Added
- **Custom session sorting** — Sessions within a group (or at top level in Recent Sessions) can now be reordered manually. Two methods: (1) right-click → "Move Up" / "Move Down" for precise adjustments, (2) drag-and-drop for direct positioning. Sort order is persisted in `claudeSessionSortOrder` and takes precedence over the default mtime-based order.
- **2-level session nesting** — Sessions can now contain sub-sessions for hierarchical organization. Right-click a top-level session → "Nest Under Session..." → pick a parent from the QuickPick. Maximum depth is 2 (Group → Session → Sub-session). Sub-sessions appear indented under their parent regardless of their own group membership. Use "Unnest (Move to Top Level)" on a sub-session to flatten it back.
- **Drag & drop session management** — Drag a session onto a custom group → moves it there. Drag onto another session → inserts it right before the target, inheriting the target's group and parent (so dropping on a sub-session places the dragged item as a sibling under the same parent). Multi-select is supported (`canSelectMany: true`). 2-level safety guard prevents drops that would exceed the depth limit.
- **Custom group ordering** — Groups can now be reordered the same two ways as sessions: (1) right-click a group header → "Move Group Up" / "Move Group Down", (2) drag a group header onto another group to insert it right before. Group order is persisted by rewriting the `claudeSessionGroups` object with the new key order (modern JS engines preserve non-integer-string key insertion order).

### Changed
- **Session icons — titled vs untitled** — Titled sessions (with a user-assigned name) use `comment-discussion` (two overlapping speech bubbles). Untitled sessions use `comment-draft` (dashed-border bubble) so the two kinds are visually distinguishable at a glance. Removed the earlier `folder` override that rendered every grouped session identical to its group header.
- **Context value assignments** — Tree items now carry explicit `contextValue` strings (`session`, `subSession`, `customGroup`, `recentGroup`, `resumeLaterGroup`, `trashGroup`, `trashed`). Existing `moveToGroup` / `trashSession` menu conditions switched from negative matching to positive matching so they no longer leak onto group headers.

### Internal
- `SessionTreeDataProvider` gains `handleDrag` / `handleDrop` (for `TreeDragAndDropController`) and helpers `_getScope` / `_getSiblings` / `_writeSortOrder` / `moveSessionUp` / `moveSessionDown` / `setSessionParent` / `removeSessionParent` / `moveGroupUp` / `moveGroupDown` / `_reorderGroupsBefore` / `_writeGroupOrder`.
- D&D uses two MIME types — `application/vnd.code.tree.claudecodelauncher.sessions` (session items) and `...groups` (custom group headers) — so group drags can't accidentally act like session moves.
- New storage keys: `claudeSessionSortOrder` (integer map, sparse 10/20/30...) and `claudeSessionParent` (session→parent sessionId map). No migration needed; group order continues to live in `claudeSessionGroups` key order.

## [2.5.7] - 2026-04-16

### Added
- **Fullscreen mode detection & indicator** — Claude CLI's new fullscreen mode uses alternate screen buffer + mouse reporting, which breaks text selection and other launcher features. The launcher now detects both `\e[?1049h` (alternate screen) and `\e[?100Xh` (mouse tracking) escape sequences in real-time and shows an amber "FS" badge in the toolbar. A one-time toast hint reminds the user that Shift+drag bypasses mouse capture for text selection.
- **Context menu works in fullscreen** — Right-click context menu listener switched from bubble to capture phase, so it fires even when xterm.js mouse reporting intercepts and stops propagation of the event.
- **Export warns in alternate screen** — When exporting from fullscreen mode, a toast warns that only the current viewport is captured (the normal buffer with full scroll history is not accessible from the alternate screen).
- **Scroll FAB auto-hidden in fullscreen** — The scroll-to-bottom button is suppressed in alternate screen mode since the TUI application manages its own scrolling.

## [2.5.6] - 2026-04-15

### Added
- **Toast "열기" link after paste-to-file** — When a large paste is saved to a temp file, the notification toast shows a clickable `[열기]` link that opens the saved text file in the editor. Lets you verify exactly what Claude will see via the `@path` reference.
- **Toast "취소" link on attachments** — Both the text paste-to-file toast and the image paste toast now carry a red `[취소]` link. Clicking it sends N DELs (0x7f) into the PTY to wipe the just-injected `@path`/image-path from the prompt and deletes the backing temp file, so the attachment never existed as far as Claude is concerned. Saves you hitting backspace N-hundred times. Caveat: if you've already typed prompt text after the paste, those trailing chars get erased first — cancel promptly.
- **Image paste thumbnail preview** — When a screenshot is pasted, the toast now renders a small thumbnail (max 96×64) of the exact bitmap that was captured, so a wrong clipboard (pasted the previous screenshot by mistake) is obvious before Claude sees it. Thumbnail is reused on the success toast, which additionally gets the `[열기]` + `[취소]` links.
- **TSV → Markdown preview in toast** — Conversion toast previously said only "TSV → Markdown 표 변환". It now reports dimensions, e.g. "📊 TSV → Markdown: 6행 × 4열", so a wrong clipboard is obvious at a glance.

### Fixed
- **Toast action links weren't clickable** — `#paste-toast` had `pointer-events:none` in CSS (so the toast wouldn't block terminal clicks under it). That also blocked the new `[열기]` link. Root fix: keep the toast non-interactive by default, but set `pointer-events:auto` on action links individually.
- **Idle 1s scroll polling removed (B4)** — `scroll-fab` visibility was driven by a 1-second `setInterval(checkScroll, 1000)` on every open panel, doing a DOM query even when the terminal was idle. Replaced with a direct `scroll` listener on xterm's `.xterm-viewport` element (attached once it materializes). Zero work while idle; identical behavior when scrolling.

### Internal
- `tryConvertTsvToMarkdown` now returns `{ markdown, rows, cols } | null` instead of `text`. Callers switched to explicit null check.
- `showToast(message, opts)` now accepts `opts.actions = [{ label, onClick, color? }, ...]` for multi-link rows; legacy `opts.action` still supported. New `opts.image` renders a prepended thumbnail. Toast auto-dismiss bumped 2.5s → 4s to give time to click.
- `paste-file-ready` / `image-paste-result` messages carry `fullPath` (native separators) alongside `cliPath`. New router cases: `open-paste-file` (routes to `vscode.open`), `cancel-paste-file` (unlinks the temp file).

## [2.5.5] - 2026-04-15

### Fixed
- **Excel cell selection pasted as PNG instead of text** — Excel puts both tab-separated text AND a rendered PNG on the clipboard for any cell range. The v2.5.4 paste handler iterated `clipboardData.items` and caught the image entry first, which meant tabular data was silently uploaded as an image instead of kept as text. Paste now **prioritizes text**: if `clipboardData.getData('text')` returns anything, the text path runs (with optional TSV→Markdown conversion and the existing size-based paste-to-file threshold). Image handling only fires when there is no text on the clipboard (pure screenshots).

### Added
- **TSV → Markdown table auto-conversion** — When a paste is detected as a tab-separated table (≥2 rows with the same ≥2 column count), it is converted to a Markdown table before injection so Claude can parse it directly. Enabled by default; disable with `claudeCodeLauncher.pasteTableAsMarkdown = false` to keep the raw TSV. `|` characters inside cells are escaped as `\\|` to keep the table valid. Converted pastes are injected via `term.paste()` so xterm's bracketed-paste wrapping still applies.

## [2.5.4] - 2026-04-15

### Fixed
- **Paste truncation — root workaround via `@path`** — v2.4.3's 256B/20ms chunked writes still lost bytes in prolonged large pastes because Ink (Claude CLI's TUI layer) runs its own line editor on top of ConPTY, and that editor drops bytes when reads can't keep up with writes over ~1–2KB. Chunking only lowered the rate, didn't remove the drop. Now when clipboard text exceeds `claudeCodeLauncher.pasteToFileThreshold` characters (default **2000**, set `0` to disable), the webview intercepts the paste, saves the text to `<os.tmpdir()>/claude-launcher-paste/paste-<timestamp>-<rand>.txt`, and injects `@<absolute-path> ` into the PTY instead. The CLI's `@file` reference reads the file directly, sidestepping PTY bulk-write entirely. No truncation possible because the PTY only sees a short path. Temp files older than 7 days are swept on each paste.
- **Export Conversation — transcript corrupted by terminal reflow (redone correctly)** — v2.5.2 tried to fix this by capturing raw `pty.onData` bytes and stripping ANSI, but Claude CLI is an Ink (TUI) app that expresses layout via cursor-move + partial writes, so blind ANSI stripping discards layout meaning and produces mangled text. Export now uses `term.selectAll() + term.getSelection()`, which runs through xterm.js's virtual-terminal state machine (already handles cursor moves, `isWrapped` line merges, and render state) and then trims trailing whitespace per line. Render output is now export output.

### Added
- **`claudeCodeLauncher.pasteToFileThreshold`** setting (default 2000, min 0) — 0 disables the paste-to-file behavior and restores direct PTY paste for all sizes.

### Removed
- `src/pty/rawBuffer.js` and related `appendRaw`/`resetRaw` hooks added in v2.5.2 (unused after switching Export to `getSelection`).

## [2.5.2] - 2026-04-15

### Fixed
- **Export Conversation — transcript corrupted by terminal reflow** — Previously the transcript was reconstructed by iterating xterm's render buffer (`term.buffer.active.getLine(i).translateToString(true)`). Two failure modes stacked: (1) soft-wrapped long lines (e.g. a long URL warning exceeding `cols`) were split across physical rows and `\n`-joined, chopping one sentence into two; (2) Windows ConPTY live-reflows already-emitted lines when the terminal resizes, which could then collapse many logical lines into one very wide row padded with hundreds of trailing spaces — producing the wall-of-spaces blob users reported. Export now reads from a new **per-entry raw PTY capture** (`pty.onData` → `entry.rawOutput`, ring-trimmed at 10MB by whole lines) and runs it through a dedicated `sanitizeForExport()` that strips CSI/OSC/DCS escape sequences, collapses `\r\n` → `\n`, and resolves lone `\r` progress-bar overwrites by keeping only the text after the last `\r` on each line. Render state of the terminal no longer affects export fidelity.

### Internal
- New module `src/pty/rawBuffer.js` (`appendRaw` / `resetRaw` / `sanitizeForExport` / `MAX_RAW_BUFFER = 10MB`).
- `pty.onData` handlers in `createPanel.js` + `restartPty.js` call `appendRaw(entry, data)`; `restartPty` calls `resetRaw(entry)` when spawning the new process so a restart starts the raw transcript fresh.
- `handleExportConversation` signature changed from `(text, entry, panel)` to `(entry, panel)`. Webview no longer scrapes its render buffer; it just sends `{ type: 'export-conversation' }`.
- `entry.rawOutput` is in-memory only (not persisted to `sessions.json`).

## [2.5.1] - 2026-04-15

### Fixed
- **`sessions.json` partial-write / cross-window race** — `sessionStoreUpdate` previously did `readFileSync` → mutate → `writeFileSync`, so two windows (or two flushes inside one window) flushing back-to-back could clobber each other's keys, and a crash mid-write left a truncated/corrupt JSON file the next launch couldn't parse. Writes now go through a `.tmp.<pid>.<ts>` file with `fsync` + atomic `rename`, and tmp files are cleaned up on failure.
- **Particle effect RAF kept burning CPU when disabled** — `animateParticles` re-scheduled itself via `requestAnimationFrame` every frame even when `particlesEnabled` was off, leaving an idle ~60 fps no-op loop running. Now the loop exits on disable, and both toggle paths (right-click "Particles" + slash command `toggle-particles`) restart it on re-enable.

### Removed
- **Dead `set-memo` message handler** — Router accepted a `set-memo` webview message that no client code ever sent (real memo flow is `request-edit-memo` → `showInputBox` → `memo-updated`). Removed handler + protocol comment.

## [2.5.0] - 2026-04-15

### Changed
- **Internal refactor — module split** — `extension.js` (4,386 lines) split into a thin 3-line entry + 23 modules under `src/`. No user-visible behavior changes. Structure only. Module layout:
  - `src/activation.js` — activate/deactivate lifecycle, command registration (10 commands under `claudeCodeLauncher.*`)
  - `src/state.js` — runtime state singleton (panels Map, tabCounter, statusBar, sessionTreeProvider, context)
  - `src/i18n/` — locale strings (en/ko) and runtime resolution
  - `src/store/` — session JSON persistence (`sessions.json`) + save/restore
  - `src/tree/` — `SessionTreeDataProvider` for the sidebar
  - `src/pty/` — `writePtyChunked`/`killPtyProcess`/`resolveClaudeCli` + `createContextParser()` factory (dedupes what was previously duplicated between createPanel and restartPty)
  - `src/panel/` — `createPanel`, `restartPty`, `messageRouter` (19 webview→ext types dispatched from one table), `statusIndicator`, `webviewContent`/`webviewStyles`/`webviewClient` (HTML/CSS/JS separated as JS modules; true static split scheduled for v2.6)
  - `src/handlers/` — toolbar, openFile (with partial-path recovery), openFolder, pasteImage, dropFiles, exportConversation, desktopNotification

### Fixed
- **XSS via innerHTML (pre-existing, hardened during refactor)** — Settings list renders for custom buttons / custom slash commands / file associations / slash menu concatenated user input directly into `innerHTML`. Added `escapeHtml()` helper and applied it at 5 injection points. DOM structure unchanged, string sanitization only.

### Internal
- Session schema (`sessions.json` keys and 6-field session object) unchanged — existing user sessions load transparently.
- Command IDs under `claudeCodeLauncher.*` preserved (legacy naming kept to protect existing `keybindings.json` bindings).
- `WebviewPanelSerializer` still not used — retained self-managed restore via `sessions.json` and activate-time `restoreSessions`.

## [2.4.3] - 2026-04-14

### Fixed
- **Long paste truncation (recurrence)** — v2.4.0's `writePtyChunked` (1024B/10ms) still dropped bytes on Windows ConPTY under sustained writes, and concurrent `writePtyChunked` calls (paste + typing) could interleave chunks because each call started its own setTimeout chain. Now a per-entry write queue serializes all writes, chunk size dropped to 256B and delay bumped to 20ms for ConPTY buffer headroom, and chunk boundaries skip UTF-16 surrogate pair splits so emoji/astral chars don't corrupt.

## [2.4.2] - 2026-04-13

### Fixed
- **Open File — Windows default app not launched** — Two issues combined silently: (1) `vscode.env.openExternal(Uri.file(...))` on Windows/Antigravity didn't hand off to the OS default app, and (2) when users had explicit `fileAssociations` like `.xlsx→excel`, the code invoked `spawn('excel', [...])` which fails with ENOENT since `excel` isn't in PATH. Both paths now route through `cmd.exe /c start "" "<path>"` (with `windowsVerbatimArguments` so `cmd` sees the quoted path intact), deferring to Windows file association to resolve the default app. Added a spawn error listener so future failures surface as a warning toast instead of silent.
- **Open File — partial/mid-drag selection** — "Open File" now uses the same `resolvePathFragment` recovery as Open Folder (cwd → ancestors → home dir → platform roots), so mid-drag fragments like `Downloads\foo.xlsx` resolve correctly. Previously only the basename-search fallback ran, which couldn't reach files outside `entry.cwd` (e.g. `~/Downloads`) and silently failed with "File not found".
- **`~` expansion for Open File** — `~`, `~/foo` now expand to the home directory.
- **Directory-as-file rejection** — If the resolved path points to a directory, Open File now warns instead of attempting to open it as a file.

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
