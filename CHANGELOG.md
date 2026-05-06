# Changelog

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
