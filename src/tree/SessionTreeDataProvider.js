// @module tree/SessionTreeDataProvider — sidebar tree view showing session groups.
// Groups: "Resume Later" (pinned) / custom groups / "Recent Sessions" / "Trash".
// Expansion state kept in _expandedGroups (Set), tracked via activate()'s onDidExpand/Collapse.
//
// v2.6.0: custom sort (claudeSessionSortOrder) + 2-level nesting (claudeSessionParent)
// + TreeDragAndDropController for drag-reorder / drag-to-group.
//
// v3.6.9: group-aware session loading. The old hard cap of `slice(0, 30)`
// silently dropped sessions a user had bucketed into a custom group once
// newer activity bumped them past the window — exactly the opposite of the
// intent behind grouping. Two new behaviours:
//   - protected ids (regular group members + Resume Later) bypass the 30 cap
//     and are loaded up to a soft cap of 100 (mtime DESC). The cap matches
//     the v3.5.9 file-meta LRU so title parsing stays inside the cache.
//   - archive groups (stored in `claudeSessionGroupArchived` — array of
//     group names) have no cap, but their members skip the expensive
//     extractAiTitle / extractFirstUserMessage parse on tree load. Labels
//     fall back to saved title or `<8-char prefix>…`. Designed for the
//     "stash big jsonls I rarely open" pattern where parsing every file on
//     refresh would otherwise dominate the tree-build cost.

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { t } = require('../i18n');
const { sessionStoreGet, sessionStoreUpdate } = require('../store/sessionStore');
const { pathDepth, getDescendants } = require('../util/groupPath');
const { extractAiTitle, extractFirstUserMessage, extractMessageCount, listKiroSessions, listAntigravitySessions, listCodexSessions, listGrokSessions, listGjcSessions, listChiefSessions } = require('../lib/sessionJsonl');
const { getKiroSessionsDir } = require('../lib/projectSessions');
const { formatBytes } = require('../lib/sizeFormat');
const { buildUri: buildSessionDecorationUri, WARN_THRESHOLD: SIZE_WARN, ERROR_THRESHOLD: SIZE_ERROR, formatMB } = require('./SessionDecorationProvider');

// v3.5.8: size-warning tooltip suffix appended to a session's hover text so
// the recommendation shows even on VSCode versions where FileDecorationProvider
// tooltips render only on a secondary hover. Returns '' for sessions under
// the warning threshold so the suffix doesn't crowd small-session tooltips.
function _sizeWarningSuffix(size, trashed) {
  if (typeof size !== 'number' || !isFinite(size) || size <= SIZE_WARN) return '';
  if (size > SIZE_ERROR) {
    return trashed
      ? `\n\n⚠ 매우 큰 세션 (${formatMB(size)} MB) — 휴지통에서도 비우기 권장`
      : `\n\n⚠ 매우 큰 세션 (${formatMB(size)} MB) — 즉시 새 세션으로 분할 권장`;
  }
  return trashed
    ? `\n\n⚠ 큰 세션 (${formatMB(size)} MB) — 휴지통에서 정리 권장`
    : `\n\n⚠ 큰 세션 (${formatMB(size)} MB) — 새 세션으로 분할 권장`;
}

// Korean/English short relative time. Falls back to a locale date string
// once the gap exceeds a week.
function _relTime(mtime) {
  const diff = Date.now() - mtime;
  const min = Math.floor(diff / 60000);
  const isKo = (vscode.env.language || '').startsWith('ko');
  if (min < 1) return isKo ? '방금 전' : 'just now';
  if (min < 60) return isKo ? `${min}분 전` : `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return isKo ? `${hr}시간 전` : `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return isKo ? '어제' : 'yesterday';
  if (day < 7) return isKo ? `${day}일 전` : `${day}d ago`;
  return new Date(mtime).toLocaleDateString();
}

const DND_SESSION_MIME = 'application/vnd.code.tree.claudecodelauncher.sessions';
const DND_GROUP_MIME = 'application/vnd.code.tree.claudecodelauncher.groups';
// kiro view uses its own MIME pair so a drag started in the Kiro Sessions view
// can never drop onto the Claude Sessions view (and vice-versa) — VSCode only
// accepts a drop whose DataTransfer carries a MIME the target provider lists in
// its dropMimeTypes. Distinct MIMEs per agent are the structural guard against
// cross-view session/group mixing.
const DND_KIRO_SESSION_MIME = 'application/vnd.code.tree.claudecodelauncher.kirosessions';
const DND_KIRO_GROUP_MIME = 'application/vnd.code.tree.claudecodelauncher.kirogroups';
// antigravity gets its own MIME pair too, for the same cross-view isolation
// reason as kiro: a drag started in the Antigravity Sessions view can only drop
// back into that view (VSCode matches the DataTransfer MIME to the target
// provider's declared dropMimeTypes).
const DND_AGY_SESSION_MIME = 'application/vnd.code.tree.claudecodelauncher.antigravitysessions';
const DND_AGY_GROUP_MIME = 'application/vnd.code.tree.claudecodelauncher.antigravitygroups';
// codex gets its own MIME pair for the same cross-view isolation reason.
const DND_CODEX_SESSION_MIME = 'application/vnd.code.tree.claudecodelauncher.codexsessions';
const DND_CODEX_GROUP_MIME = 'application/vnd.code.tree.claudecodelauncher.codexgroups';
// grok gets its own MIME pair for the same cross-view isolation reason.
const DND_GROK_SESSION_MIME = 'application/vnd.code.tree.claudecodelauncher.groksessions';
const DND_GROK_GROUP_MIME = 'application/vnd.code.tree.claudecodelauncher.grokgroups';
// gjc gets its own MIME pair for the same cross-view isolation reason.
const DND_GJC_SESSION_MIME = 'application/vnd.code.tree.claudecodelauncher.gjcsessions';
const DND_GJC_GROUP_MIME = 'application/vnd.code.tree.claudecodelauncher.gjcgroups';
// chief gets its own MIME pair for the same cross-view isolation reason.
const DND_CHIEF_SESSION_MIME = 'application/vnd.code.tree.claudecodelauncher.chiefsessions';
const DND_CHIEF_GROUP_MIME = 'application/vnd.code.tree.claudecodelauncher.chiefgroups';

// Per-agent store-key map. claude keeps its historical keys (no migration);
// kiro gets a parallel, fully separate set so the two agents' custom groups,
// membership, ordering and nesting never touch each other's data. _storeKey()
// resolves a logical key (e.g. 'groups') to the agent-specific physical key.
const STORE_KEYS = {
  claude: {
    groups: 'claudeSessionGroups',
    saved: 'claudeSavedSessions',
    parent: 'claudeSessionParent',
    sortOrder: 'claudeSessionSortOrder',
    archived: 'claudeSessionGroupArchived',
    titles: 'claudeSessionTitles',
  },
  kiro: {
    groups: 'kiroSessionGroups',
    // kiro has no Resume Later / archive concept; the keys are declared so the
    // shared helpers can read them uniformly (they resolve to empty defaults).
    saved: 'kiroSavedSessions',
    parent: 'kiroSessionParent',
    sortOrder: 'kiroSessionSortOrder',
    archived: 'kiroSessionGroupArchived',
    titles: 'kiroSessionTitles',
  },
  antigravity: {
    // Fully separate antigravity key namespace, same shape as kiro — custom
    // groups, membership, ordering, nesting + per-session rename titles never
    // mix with claude's or kiro's store.
    groups: 'antigravitySessionGroups',
    saved: 'antigravitySavedSessions',
    parent: 'antigravitySessionParent',
    sortOrder: 'antigravitySessionSortOrder',
    archived: 'antigravitySessionGroupArchived',
    titles: 'antigravitySessionTitles',
  },
  codex: {
    // Fully separate codex key namespace, same shape as kiro/antigravity.
    groups: 'codexSessionGroups',
    saved: 'codexSavedSessions',
    parent: 'codexSessionParent',
    sortOrder: 'codexSessionSortOrder',
    archived: 'codexSessionGroupArchived',
    titles: 'codexSessionTitles',
  },
  grok: {
    // Fully separate grok key namespace, same shape as codex.
    groups: 'grokSessionGroups',
    saved: 'grokSavedSessions',
    parent: 'grokSessionParent',
    sortOrder: 'grokSessionSortOrder',
    archived: 'grokSessionGroupArchived',
    titles: 'grokSessionTitles',
  },
  gjc: {
    // Fully separate gjc (Gajae Code) key namespace, same shape as grok.
    groups: 'gjcSessionGroups',
    saved: 'gjcSavedSessions',
    parent: 'gjcSessionParent',
    sortOrder: 'gjcSessionSortOrder',
    archived: 'gjcSessionGroupArchived',
    titles: 'gjcSessionTitles',
  },
  chief: {
    // Fully separate chief key namespace, same shape as grok.
    groups: 'chiefSessionGroups',
    saved: 'chiefSavedSessions',
    parent: 'chiefSessionParent',
    sortOrder: 'chiefSessionSortOrder',
    archived: 'chiefSessionGroupArchived',
    titles: 'chiefSessionTitles',
  },
  unified: {
    // v3.10: the unified "Sessions" view reuses claude's physical store keys so
    // a user's existing Claude groups / Resume Later / Trash carry over with NO
    // migration. Non-claude sessions (kiro/codex/grok/agy) join the SAME store keyed
    // by their own session id — grouping/sorting/rename done in the unified view
    // all land in claude's keys. Keeping one store (vs merging four) is what
    // makes the group-op helpers (_moveToGroup, _reorderBefore, _getSiblings…)
    // work unchanged in unified mode. Cross-agent id collisions are effectively
    // impossible (all five agents key sessions by UUID-class ids).
    groups: 'claudeSessionGroups',
    saved: 'claudeSavedSessions',
    parent: 'claudeSessionParent',
    sortOrder: 'claudeSessionSortOrder',
    archived: 'claudeSessionGroupArchived',
    titles: 'claudeSessionTitles',
  },
};

// v3.10: agents whose sessions are folded into the unified view alongside
// claude, with the per-agent bits the leaf builder needs: the list* loader,
// how to read mtime from a session record, the resume opts flag, and the
// contextValue that drives the right-click menu (kept identical to each
// agent's split-view value so the menu `when`s extend by OR, not by clone).
const UNIFIED_OTHER_AGENTS = [
  { agent: 'kiro', contextValue: 'kiroSession', resumeKey: 'kiroResume', mtimeOf: (s) => Date.parse(s.updatedAt || '') || 0 },
  { agent: 'antigravity', contextValue: 'antigravitySession', resumeKey: 'antigravityResume', mtimeOf: (s) => s.mtime || 0 },
  { agent: 'codex', contextValue: 'codexSession', resumeKey: 'codexResume', mtimeOf: (s) => s.mtime || 0 },
  { agent: 'grok', contextValue: 'grokSession', resumeKey: 'grokResume', mtimeOf: (s) => s.mtime || 0 },
  { agent: 'gjc', contextValue: 'gjcSession', resumeKey: 'gjcResume', mtimeOf: (s) => s.mtime || 0 },
  { agent: 'chief', contextValue: 'chiefSession', resumeKey: 'chiefResume', mtimeOf: (s) => s.mtime || 0 },
];

class SessionTreeDataProvider {
  // agentMode: 'claude' (default — full claude groups), 'kiro' / 'antigravity'
  // / 'codex' / 'grok' / 'chief' (root children are that agent's sessions only), or 'unified' (all
  // agents merged into one tree, each leaf badged with its model icon, sharing
  // claude's store). The split agent-scoped views own their header actions and
  // hide when their CLI isn't installed/enabled (kiro/antigravity/codex/grokAvailable
  // keys); the unified view is gated by the sessionViewMode setting
  // (unifiedViewActive context key).
  constructor(context, agentMode = 'claude') {
    this._context = context;
    this._agentMode = agentMode;
    // v3.10: per-agent model-icon cache. _agentIcon resolves a {light,dark} svg
    // URI (or ThemeIcon fallback) once per agent — static for the process — so
    // we avoid an fs.existsSync per session leaf on every unified tree build.
    this._agentIconCache = new Map();
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this._cache = null;
    this._expandedGroups = new Set([t('resumeLaterGroup')]);
    // v3.11: session-name search filter. When non-empty (already lowercased),
    // the _build* methods drop session leaves whose title doesn't include it;
    // empty groups then collapse to nothing. Set via setFilter() from the
    // searchSessions command, cleared by clearSessionFilter. Shared across the
    // unified + split views (each provider keeps its own copy).
    this._filterText = '';
    // v3.5.9: refresh() is called from many places (PTY state changes, exit,
    // restoreSessions, command handlers, heartbeat) — easily dozens of times
    // per minute on iloom-workspace with 5 active sessions. Debounce coalesces
    // a burst into a single fire so _buildGroups + _loadSessions runs once
    // instead of per event. 500 ms is short enough that the user perceives
    // the tree as live but long enough to absorb common cascades (PTY data
    // → state transition → status bar → tree refresh).
    this._refreshTimer = null;
    this._REFRESH_DEBOUNCE_MS = 500;
    // v3.5.9: file-level cache for extractAiTitle + extractFirstUserMessage.
    // Tree refresh used to call both on each of the top 30 jsonls every time;
    // extractAiTitle parses the whole file (no per-line cap), which compounds
    // hard with the iloom pattern (multiple 13-48 MB scm-pdca sessions in the
    // top 30). Cache key is {mtime, size}; an LRU cap of 100 entries keeps
    // memory bounded while comfortably covering the 30 top recent + tree
    // children across normal usage.
    this._fileMetaCache = new Map();
    this._FILE_META_CACHE_MAX = 100;

    // TreeDragAndDropController interface (read by createTreeView(options)).
    // MIME pair is agent-scoped so a drag in one view can't drop in another.
    this._sessionMime = agentMode === 'kiro' ? DND_KIRO_SESSION_MIME
      : agentMode === 'antigravity' ? DND_AGY_SESSION_MIME
      : agentMode === 'codex' ? DND_CODEX_SESSION_MIME
      : agentMode === 'grok' ? DND_GROK_SESSION_MIME
      : agentMode === 'gjc' ? DND_GJC_SESSION_MIME
      : agentMode === 'chief' ? DND_CHIEF_SESSION_MIME
      : DND_SESSION_MIME;
    this._groupMime = agentMode === 'kiro' ? DND_KIRO_GROUP_MIME
      : agentMode === 'antigravity' ? DND_AGY_GROUP_MIME
      : agentMode === 'codex' ? DND_CODEX_GROUP_MIME
      : agentMode === 'grok' ? DND_GROK_GROUP_MIME
      : agentMode === 'gjc' ? DND_GJC_GROUP_MIME
      : agentMode === 'chief' ? DND_CHIEF_GROUP_MIME
      : DND_GROUP_MIME;
    this.dropMimeTypes = [this._sessionMime, this._groupMime];
    this.dragMimeTypes = [this._sessionMime, this._groupMime];
  }

  // Resolve a logical store key ('groups', 'parent', ...) to the physical key
  // for this provider's agentMode. claude → historical keys; kiro → kiro keys.
  _storeKey(logical) {
    return (STORE_KEYS[this._agentMode] || STORE_KEYS.claude)[logical];
  }

  refresh() {
    if (this._refreshTimer) return; // a fire is already queued; coalesce
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this._cache = null;
      this._onDidChangeTreeData.fire();
    }, this._REFRESH_DEBOUNCE_MS);
  }

  // v3.11: set the session-name search filter (case-insensitive substring).
  // Empty / null clears it. Bypasses the refresh debounce so a search keystroke
  // feels immediate. Returns the normalized (trimmed, lowercased) filter so the
  // caller can sync the sessionFilterActive context key / view message.
  setFilter(text) {
    const next = (text || '').trim().toLowerCase();
    if (next === this._filterText) return next;
    this._filterText = next;
    if (this._refreshTimer) { clearTimeout(this._refreshTimer); this._refreshTimer = null; }
    this._cache = null;
    this._onDidChangeTreeData.fire();
    return next;
  }

  get filterActive() {
    return !!this._filterText;
  }

  // v3.11: case-insensitive substring test for the active filter. No filter →
  // everything matches. Used by every _build* path against a session's title.
  _matchesText(text) {
    if (!this._filterText) return true;
    return String(text || '').toLowerCase().includes(this._filterText);
  }

  // v3.11: single non-actionable row shown when a search filter is active but
  // nothing matches — keeps the view from falling back to the generic
  // "no session history" welcome, which is misleading during a search.
  _noMatchRow() {
    const item = new vscode.TreeItem(t('searchNoMatch'), vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('search-stop');
    item.contextValue = 'searchNoMatch';
    item.tooltip = `"${this._filterText}"`;
    return item;
  }

  // v3.5.9: hit/miss the file-level meta cache. Returns the cached entry
  // when {mtime, size} match the current stat; otherwise extracts fresh and
  // stores. Returns null only when the file can't be read.
  _getFileMeta(filePath, mtime, size) {
    if (!filePath) return null;
    const cached = this._fileMetaCache.get(filePath);
    if (cached && cached.mtime === mtime && cached.size === size) {
      // Refresh LRU order: re-set the key
      this._fileMetaCache.delete(filePath);
      this._fileMetaCache.set(filePath, cached);
      return cached;
    }
    const meta = {
      mtime,
      size,
      aiTitle: extractAiTitle(filePath),
      firstMsg: extractFirstUserMessage(filePath),
    };
    // Evict oldest before insert if at cap
    if (this._fileMetaCache.size >= this._FILE_META_CACHE_MAX) {
      const oldest = this._fileMetaCache.keys().next().value;
      if (oldest) this._fileMetaCache.delete(oldest);
    }
    this._fileMetaCache.set(filePath, meta);
    return meta;
  }

  getTreeItem(element) {
    return element;
  }

  getChildren(element) {
    if (!element) {
      if (this._cache) return this._cache;
      this._cache = this._agentMode === 'kiro'
        ? this._buildKiroSessions()
        : this._agentMode === 'antigravity'
          ? this._buildAntigravitySessions()
          : this._agentMode === 'codex'
            ? this._buildCodexSessions()
            : this._agentMode === 'grok'
              ? this._buildGrokSessions()
              : this._agentMode === 'gjc'
                ? this._buildGjcSessions()
                : this._agentMode === 'chief'
                  ? this._buildChiefSessions()
                  : this._buildGroups({ unified: this._agentMode === 'unified' });
      return this._cache;
    }
    // v3.5.9: lazy metadata row. Session items carry _jsonlPath + _mtime +
    // _fileSize but no pre-built metadata child — extractMessageCount runs
    // here on first expand, not on every tree refresh. Combined with the
    // sub-session list attached as _subSessions, the children we return on
    // expand are [metaRow, ...subSessions]. _composedChildren memoizes the
    // result so re-expand after collapse doesn't re-run extract.
    if (element._jsonlPath && element.contextValue !== 'sessionMeta') {
      if (element._composedChildren) return element._composedChildren;
      const children = [];
      const trashed = element.contextValue === 'trashed';
      const sizeStr = formatBytes(element._fileSize);
      // Skip extractMessageCount entirely for trash items — they only show
      // "trashed · <relTime> · <size>" which has no turn count component.
      // For active sessions, extractMessageCount still runs but ONLY on the
      // session the user just expanded (no longer fired on every refresh).
      const metaLabel = trashed
        ? `trashed · ${_relTime(element._mtime)}${sizeStr ? ' · ' + sizeStr : ''}`
        : (function() {
            const msgCount = extractMessageCount(element._jsonlPath);
            return `${msgCount} turn${msgCount === 1 ? '' : 's'} · ${_relTime(element._mtime)}${sizeStr ? ' · ' + sizeStr : ''}`;
          })();
      const metaRow = new vscode.TreeItem(metaLabel, vscode.TreeItemCollapsibleState.None);
      metaRow.iconPath = new vscode.ThemeIcon('info');
      metaRow.contextValue = 'sessionMeta';
      metaRow.tooltip = `Session: ${element._sessionId}\n${new Date(element._mtime).toLocaleString()}`;
      children.push(metaRow);
      if (Array.isArray(element._subSessions) && element._subSessions.length > 0) {
        children.push(...element._subSessions);
      }
      element._composedChildren = children;
      return children;
    }
    return element._children || [];
  }

  // v3.10: model (agent) icon for unified-view session leaves. Reuses the
  // per-agent svg assets the tab status indicator uses (icons/<agent>-idle.svg),
  // falling back to claude's asset, then a ThemeIcon when the extension path is
  // unavailable. Same {light, dark} shape as statusIndicator.setTabIcon.
  _agentIcon(agent) {
    if (this._agentIconCache.has(agent)) return this._agentIconCache.get(agent);
    let result = null;
    const extPath = this._context && this._context.extensionPath;
    if (extPath) {
      let file = path.join(extPath, 'icons', `${agent}-idle.svg`);
      if (!fs.existsSync(file)) file = path.join(extPath, 'icons', 'claude-idle.svg');
      if (fs.existsSync(file)) {
        const uri = vscode.Uri.file(file);
        result = { light: uri, dark: uri };
      }
    }
    if (!result) result = new vscode.ThemeIcon('comment-discussion');
    this._agentIconCache.set(agent, result);
    return result;
  }

  // v3.10: build leaf TreeItems for the non-claude agents (kiro/codex/grok/agy) so
  // _buildGroups can fold them into the unified view. Each leaf keeps the SAME
  // contextValue as its split-view counterpart (so the right-click menu `when`s
  // extend by OR rather than being cloned), carries _agent + _unified, and
  // resumes via the existing agent-branch of the resumeSession command. Title
  // precedence: the unified rename store (claudeSessionTitles) wins, then the
  // agent's own rename store, then the list*'s native title, then an id prefix.
  _loadOtherAgentItems() {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (!cwd) return [];
    const unifiedTitles = sessionStoreGet('claudeSessionTitles', {});
    const out = [];
    for (const spec of UNIFIED_OTHER_AGENTS) {
      let sessions = [];
      try {
        sessions = spec.agent === 'kiro' ? listKiroSessions(cwd)
          : spec.agent === 'antigravity' ? listAntigravitySessions(cwd)
            : spec.agent === 'grok' ? listGrokSessions(cwd)
              : spec.agent === 'gjc' ? listGjcSessions(cwd)
              : spec.agent === 'chief' ? listChiefSessions(cwd)
                : listCodexSessions(cwd);
      } catch (_) { sessions = []; }
      const agentTitles = sessionStoreGet(STORE_KEYS[spec.agent].titles, {});
      for (const s of sessions) {
        const label = unifiedTitles[s.sessionId] || agentTitles[s.sessionId] || s.title || `${(s.sessionId || '').substring(0, 8)}…`;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        const mtime = spec.mtimeOf(s);
        item.description = mtime ? _relTime(mtime) : '';
        item.iconPath = this._agentIcon(spec.agent);
        item.contextValue = spec.contextValue;
        item.tooltip = `${spec.agent} session: ${s.sessionId}\n${s.cwd || ''}`;
        item._sessionId = s.sessionId;
        item._agent = spec.agent;
        item._unified = true;
        item._cwd = s.cwd;
        item._mtime = mtime;
        item._searchText = label;
        item.command = {
          command: 'claudeCodeLauncher.resumeSession',
          title: 'Resume',
          arguments: [s.sessionId, { agent: spec.agent, [spec.resumeKey]: true, cwd: s.cwd, title: label }],
        };
        out.push(item);
      }
    }
    return out;
  }

  _getProjectDir() {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (!cwd) return null;
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) return null;
    const dirName = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const projDir = path.join(projectsDir, dirName);
    if (fs.existsSync(projDir)) return projDir;
    try {
      const wsName = path.basename(cwd).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
      const dirs = fs.readdirSync(projectsDir);
      const exact = dirs.find(d => d.toLowerCase() === dirName.toLowerCase());
      if (exact) return path.join(projectsDir, exact);
      const partial = dirs.find(d => d.toLowerCase().includes(wsName));
      if (partial) return path.join(projectsDir, partial);
    } catch (_) {}
    return null;
  }

  // Sort comparator: honors claudeSessionSortOrder, falls back to mtime DESC.
  // Metadata rows (contextValue === 'sessionMeta') always lead their parent's
  // child list so the stat row stays on top of any sub-sessions.
  _cmp(sortMap, mtimeMap) {
    return (a, b) => {
      if (a.contextValue === 'sessionMeta') return -1;
      if (b.contextValue === 'sessionMeta') return 1;
      const oa = sortMap[a._sessionId];
      const ob = sortMap[b._sessionId];
      if (oa != null && ob != null) return oa - ob;
      if (oa != null) return -1;
      if (ob != null) return 1;
      return (mtimeMap.get(b._sessionId) || 0) - (mtimeMap.get(a._sessionId) || 0);
    };
  }

  _buildGroups(opts = {}) {
    const unified = !!opts.unified;
    const projDir = this._getProjectDir();
    const customGroupsRaw = sessionStoreGet('claudeSessionGroups', {});
    // Phase 13 hotfix-2: synthesize empty ancestor paths so a saved tree
    // like { 'Foo/Bar': [...] } still renders 'Foo' as a root folder. The
    // store object is left untouched — synthesis is render-only.
    const customGroups = { ...customGroupsRaw };
    for (const key of Object.keys(customGroupsRaw)) {
      const segs = key.split('/');
      for (let i = 1; i < segs.length; i++) {
        const ancestor = segs.slice(0, i).join('/');
        if (!(ancestor in customGroups)) customGroups[ancestor] = [];
      }
    }
    const savedSessions = sessionStoreGet('claudeSavedSessions', []);
    const parents = sessionStoreGet('claudeSessionParent', {});
    const sortOrder = sessionStoreGet('claudeSessionSortOrder', {});
    // v3.6.9: derive protected vs archived id sets before loading sessions.
    // Archive membership wins — if a session is in both a regular group and an
    // archive group (a rare manual case), it gets the cheap archived path.
    const archivedGroups = new Set(sessionStoreGet('claudeSessionGroupArchived', []));
    const protectedIds = new Set();
    const archivedIds = new Set();
    for (const [name, ids] of Object.entries(customGroups)) {
      const isArchive = archivedGroups.has(name);
      for (const id of ids) {
        if (isArchive) archivedIds.add(id);
        else protectedIds.add(id);
      }
    }
    for (const s of savedSessions) {
      if (!archivedIds.has(s.sessionId)) protectedIds.add(s.sessionId);
    }
    const allItems = this._loadSessions(protectedIds, archivedIds);
    if (unified) {
      // Tag the claude leaves with their agent + a model icon, then fold in the
        // other agents' sessions (kiro/codex/grok/agy). They all share the same
      // itemMap / group / Recent / sort logic below, keyed by their own id.
      for (const it of allItems) {
        it._agent = 'claude';
        it._unified = true;
        it.iconPath = this._agentIcon('claude');
      }
      allItems.push(...this._loadOtherAgentItems());
    }

    // v3.11: apply the session-name search filter before grouping. Dropping
    // non-matching leaves here cascades through itemMap / custom groups /
    // Recent / Resume Later — empty groups collapse out (makeGroupNode returns
    // null on zero total) so only matching sessions render.
    const filterActive = !!this._filterText;
    const items = filterActive
      ? allItems.filter((it) => this._matchesText(it._searchText || it.label))
      : allItems;

    const itemMap = new Map();
    const mtimeMap = new Map();
    for (const item of items) {
      itemMap.set(item._sessionId, item);
      mtimeMap.set(item._sessionId, item._mtime || 0);
    }
    const cmp = this._cmp(sortOrder, mtimeMap);

    // Attach sub-sessions to their parent items. An item is a sub-session if
    // its parent exists in itemMap (otherwise the parent was deleted/trashed
    // and the child falls back to top level).
    // v3.5.9: store sub-sessions on _subSessions (not _children) so the lazy
    // getChildren can compose [metaRow, ...subSessions] on first expand
    // without running extractMessageCount on every tree refresh.
    const isSubSession = (sid) => {
      const pid = parents[sid];
      return pid && itemMap.has(pid);
    };
    for (const item of items) {
      const pid = parents[item._sessionId];
      if (pid && itemMap.has(pid)) {
        const parentItem = itemMap.get(pid);
        parentItem._subSessions = parentItem._subSessions || [];
        parentItem._subSessions.push(item);
        // Mark sub-session for context menu targeting
        item.contextValue = 'subSession';
      }
    }
    for (const item of items) {
      if (item._subSessions && item._subSessions.length > 0) {
        item._subSessions.sort(cmp);
      }
    }

    // Build map: sessionId → group name (for top-level sessions). Sessions
    // that fall in this set are excluded from Recent Sessions.
    const groupedSet = new Set();
    for (const ids of Object.values(customGroups)) {
      for (const id of ids) groupedSet.add(id);
    }
    for (const s of savedSessions) groupedSet.add(s.sessionId);

    // v3.6.9: archive prefix + folder icon flip is handled inside
    // makeGroupNode; captured here for closure access.
    const isGroupArchived = (name) => archivedGroups.has(name);

    const groups = [];
    const exp = this._expandedGroups;
    // v3.11: force every group open while a search filter is active so matches
    // aren't hidden inside collapsed groups.
    const stateOf = (name) => (filterActive || exp.has(name)) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;

    // Resume Later (pinned)
    const rlName = t('resumeLaterGroup');
    const savedItems = savedSessions
      .map(s => itemMap.get(s.sessionId))
      .filter(Boolean)
      .filter(it => !isSubSession(it._sessionId));
    if (savedItems.length > 0) {
      savedItems.sort(cmp);
      const savedGroup = new vscode.TreeItem(`${rlName} (${savedItems.length})`, stateOf(rlName));
      savedGroup.iconPath = new vscode.ThemeIcon('pin');
      savedGroup._children = savedItems;
      savedGroup.contextValue = 'resumeLaterGroup';
      savedGroup._unified = unified;
      groups.push(savedGroup);
    }

    // Custom groups — nested path support (Phase 13).
    // Only depth-1 groups are rendered at root. Deeper groups appear as
    // children of their parent group node via getChildren(item).
    //
    // Build a TreeItem for a given group path (recursive for sub-groups).
    const makeGroupNode = (name) => {
      // Direct sessions in this group (exclude sub-sessions of sessions)
      const ids = customGroups[name] || [];
      const directItems = ids
        .map(id => itemMap.get(id))
        .filter(Boolean)
        .filter(it => !isSubSession(it._sessionId));
      directItems.sort(cmp);
      // v3.4.12: trust VSCode's native tree indent. Earlier attempts at
      // forcing an indent column (NBSP/em-space prefix, visible glyphs,
      // phantom collapsible sibling) all introduced their own artefacts.
      // Users who want a more pronounced hierarchy can set
      // "workbench.tree.indent": 16 (or higher) in their settings.json.

      // Immediate child group paths (depth+1, same prefix)
      const myDepth = pathDepth(name);
      const childGroupNames = Object.keys(customGroups).filter(k => {
        if (pathDepth(k) !== myDepth + 1) return false;
        return k.startsWith(name + '/');
      });
      // Sort child groups by their position in customGroups key order
      const allGroupKeys = Object.keys(customGroups);
      childGroupNames.sort((a, b) => allGroupKeys.indexOf(a) - allGroupKeys.indexOf(b));

      // Phase 13 hotfix: makeGroupNode returns null for empty sub-groups
      // (depth-3 leaf with no sessions, etc.). filter(Boolean) is required
      // before the reduce — otherwise null._totalCount throws and the
      // whole tree fails to render, surfacing as 'No session history'
      // and a 'Cannot read properties of null' toast on every refresh.
      const subGroupNodes = childGroupNames.map(makeGroupNode).filter(Boolean);

      const totalCount = directItems.length + subGroupNodes.reduce((s, n) => s + (n._totalCount || 0), 0);
      if (totalCount === 0 && subGroupNodes.length === 0) return null;

      // Label: show only the leaf segment for non-root nodes; for root nodes
      // (depth 1) the full name IS the leaf, so it's the same.
      const leafLabel = name.includes('/') ? name.substring(name.lastIndexOf('/') + 1) : name;
      // v3.6.9: archive groups get a 📦 prefix so users can tell at a glance
      // which buckets skip title parsing.
      const archived = isGroupArchived(name);
      const displayLeaf = archived ? `📦 ${leafLabel}` : leafLabel;
      const label = totalCount > 0 ? `${displayLeaf} (${totalCount})` : displayLeaf;
      const collState = (subGroupNodes.length > 0 || directItems.length > 0)
        ? stateOf(name)
        : vscode.TreeItemCollapsibleState.None;
      const group = new vscode.TreeItem(label, collState);
      group.iconPath = archived
        ? new vscode.ThemeIcon('archive')
        : new vscode.ThemeIcon(subGroupNodes.length > 0 ? 'folder-opened' : 'folder');
      group.contextValue = 'customGroup';
      group._groupName = name;
      group._isArchive = archived;
      group._unified = unified;
      group._children = [...subGroupNodes, ...directItems];
      group._totalCount = totalCount;
      return group;
    };

    // Render only depth-1 groups at root level (sub-groups appear as children)
    const rootGroupNames = Object.keys(customGroups).filter(k => pathDepth(k) === 1);
    for (const name of rootGroupNames) {
      const node = makeGroupNode(name);
      if (node) groups.push(node);
    }

    // Recent Sessions (ungrouped top-level)
    const rsName = t('recentSessionsGroup');
    const recentItems = items.filter(item =>
      !groupedSet.has(item._sessionId) && !isSubSession(item._sessionId)
    );
    if (recentItems.length > 0) {
      recentItems.sort(cmp);
      const recentGroup = new vscode.TreeItem(`${rsName} (${recentItems.length})`, stateOf(rsName));
      recentGroup.iconPath = new vscode.ThemeIcon('history');
      recentGroup._children = recentItems;
      recentGroup.contextValue = 'recentGroup';
      recentGroup._unified = unified;
      groups.push(recentGroup);
    }

    // Trash
    if (projDir) {
      const trashDir = path.join(projDir, 'trash');
      if (fs.existsSync(trashDir)) {
        const trashFiles = fs.readdirSync(trashDir).filter(f => f.endsWith('.jsonl'));
        if (trashFiles.length > 0) {
          const titleMap = sessionStoreGet('claudeSessionTitles', {});
          const trashItems = [];
          for (const f of trashFiles) {
            const sid = f.replace('.jsonl', '');
            const fullPath = path.join(trashDir, f);
            const st = fs.statSync(fullPath);
            const mtime = st.mtimeMs;
            const date = new Date(mtime);
            const dateStr = `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
            const savedTitle = titleMap[sid];
            // v3.5.9: cache aiTitle + firstMsg so the same trash dir doesn't
            // re-parse every huge file on each tree refresh.
            const meta = this._getFileMeta(fullPath, mtime, st.size) || { aiTitle: null, firstMsg: null };
            const aiTitle = meta.aiTitle;
            const firstMsg = meta.firstMsg;
            if (!savedTitle && !aiTitle && !firstMsg) continue;
            const displayText = savedTitle || aiTitle || firstMsg;
            // v3.11: trash items honor the search filter too (matched on the
            // full title, not the 40-char-truncated label).
            if (filterActive && !this._matchesText(displayText)) continue;
            const label = displayText.length > 40 ? displayText.substring(0, 40) + '...' : displayText;
            // Same caret-column reservation reason as live sessions.
            const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
            item.description = dateStr;
            item.iconPath = new vscode.ThemeIcon('trash');
            item.contextValue = 'trashed';
            item._unified = unified;
            // v3.5.8: size-based decoration for trash items too — the size
            // recommendation in the tooltip flips to "휴지통에서 정리 권장".
            item.resourceUri = buildSessionDecorationUri(sid, st.size, true);
            const tooltipHead = savedTitle || aiTitle || firstMsg;
            item.tooltip = `${tooltipHead ? tooltipHead + '\n\n' : ''}Session: ${sid}\n${date.toLocaleString()}${_sizeWarningSuffix(st.size, true)}`;
            // v3.5.9: metadata row deferred until expand — see getChildren.
            // Trash items skip extractMessageCount entirely; the lazy label
            // is just "trashed · <relTime> · <size>".
            item._sessionId = sid;
            item._searchText = displayText;
            item._mtime = mtime;
            item._fileSize = st.size;
            item._jsonlPath = fullPath;
            item.command = { command: 'claudeCodeLauncher.resumeSession', title: 'Resume', arguments: [sid] };
            trashItems.push(item);
          }
          if (trashItems.length > 0) {
            const trashGroup = new vscode.TreeItem(`Trash (${trashItems.length})`, stateOf('Trash'));
            trashGroup.iconPath = new vscode.ThemeIcon('trash');
            trashGroup.contextValue = 'trashGroup';
            trashGroup._children = trashItems;
            trashGroup._unified = unified;
            groups.push(trashGroup);
          }
        }
      }
    }

    // v3.11: filter active but nothing matched — show a single "no match" row
    // instead of the generic empty-view welcome.
    if (filterActive && groups.length === 0) return [this._noMatchRow()];

    return groups;
  }

  // Kiro Sessions — used by the dedicated 'Kiro Sessions' view (agentMode
  // 'kiro'). Root children are the workspace's kiro sessions, listed from the
  // same cwd _getProjectDir derives the claude project dir from. Returns []
  // when there are no kiro sessions, leaving the view empty (the view itself
  // is hidden via the kiroAvailable context key when kiro isn't installed/
  // enabled). Click → resume via the real kiro id (--resume-id, kiroResume).
  _buildKiroSessions() {
    const kiroCwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (!kiroCwd) return [];
    const kiroSessions = listKiroSessions(kiroCwd);
    // Launcher-side rename store wins over the kiro meta title, so renaming a
    // kiro tab/session shows in this tree. saveSessions() writes kiro titles to
    // kiroSessionTitles (split from claudeSessionTitles) — _storeKey('titles')
    // resolves to kiroSessionTitles in kiro mode.
    const titleMap = sessionStoreGet(this._storeKey('titles'), {});

    // Build the leaf session items keyed by the real kiro session_id (from the
    // meta .json). The id is what group membership is stored against, mirroring
    // how claude keys membership by its session id.
    const itemMap = new Map();
    const mtimeMap = new Map();
    for (const s of kiroSessions) {
      const label = titleMap[s.sessionId] || s.title || `${(s.sessionId || '').substring(0, 8)}…`;
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      const mtime = Date.parse(s.updatedAt || '') || 0;
      item.description = mtime ? _relTime(mtime) : '';
      item.iconPath = new vscode.ThemeIcon('comment-discussion');
      item.contextValue = 'kiroSession';
      item._agentMode = 'kiro';
      item.tooltip = `Kiro session: ${s.sessionId}\n${s.cwd || ''}`;
      item._sessionId = s.sessionId;
      item._mtime = mtime;
      item.command = {
        command: 'claudeCodeLauncher.resumeSession',
        title: 'Resume',
        arguments: [s.sessionId, { agent: 'kiro', kiroResume: true, cwd: s.cwd, title: label }],
      };
      itemMap.set(s.sessionId, item);
      mtimeMap.set(s.sessionId, mtime);
    }

    // Custom groups + ungrouped, mirroring claude's _buildGroups custom-group
    // section but with no Resume Later / Recent / Trash / archive — kiro shows
    // its custom groups followed by every ungrouped session flat (current
    // behaviour for the ungrouped set). Group definitions live in the
    // kiro-only store keys (_storeKey), so claude groups never bleed in.
    return this._buildAgentGroups(itemMap, mtimeMap);
  }

  // Antigravity Sessions — used by the dedicated 'Antigravity Sessions' view
  // (agentMode 'antigravity'). Root children are the workspace's agy
  // conversations, parsed from ~/.gemini/antigravity-cli/history.jsonl
  // (listAntigravitySessions) and filtered to the current cwd, newest first.
  // Mirrors _buildKiroSessions: each conversation is one leaf keyed by its
  // conversationId, labelled by the launcher rename store → agy display title →
  // id prefix. Click → resume via `agy --conversation <id>` (the resumeSession
  // command's antigravity branch). No reader pane in Phase 1 — agy stores the
  // transcript as protobuf-in-SQLite (getSessionJsonlPath returns null), so the
  // reader is gated off until a later phase. Returns [] with no conversations
  // (view hidden via antigravityAvailable when agy isn't installed/enabled).
  _buildAntigravitySessions() {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (!cwd) return [];
    const sessions = listAntigravitySessions(cwd);
    // Launcher-side rename wins over the agy display title (parallel to kiro).
    const titleMap = sessionStoreGet(this._storeKey('titles'), {});

    const itemMap = new Map();
    const mtimeMap = new Map();
    for (const s of sessions) {
      const label = titleMap[s.sessionId] || s.title || `${(s.sessionId || '').substring(0, 8)}…`;
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      const mtime = s.mtime || 0;
      item.description = mtime ? _relTime(mtime) : '';
      item.iconPath = new vscode.ThemeIcon('comment-discussion');
      item.contextValue = 'antigravitySession';
      item._agentMode = 'antigravity';
      item.tooltip = `Antigravity conversation: ${s.sessionId}\n${s.cwd || ''}`;
      item._sessionId = s.sessionId;
      item._mtime = mtime;
      item.command = {
        command: 'claudeCodeLauncher.resumeSession',
        title: 'Resume',
        // antigravityResume → exact `agy --conversation <id>` resume in its cwd.
        arguments: [s.sessionId, { agent: 'antigravity', antigravityResume: true, cwd: s.cwd, title: label }],
      };
      itemMap.set(s.sessionId, item);
      mtimeMap.set(s.sessionId, mtime);
    }

    // Same custom-groups + Recent Sessions builder as kiro (no Trash — agy's
    // history.jsonl is an append-only log, not per-session files to move).
    return this._buildAgentGroups(itemMap, mtimeMap);
  }

  // Codex Sessions — used by the dedicated 'Codex Sessions' view (agentMode
  // 'codex'). Root children are the workspace's codex rollouts, listed from
  // ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (listCodexSessions: cwd from
  // each rollout's line-1 session_meta, title from session_index.jsonl) and
  // filtered to the current cwd, newest first. Mirrors _buildKiroSessions /
  // _buildAntigravitySessions: one leaf per session keyed by the rollout UUID,
  // labelled launcher rename store → thread_name/first message → id prefix.
  // Click → resume via `codex resume <id>` (the resumeSession command's codex
  // branch). Rollouts ARE jsonl, so resumed sessions get a working reader
  // (unlike antigravity). Returns [] with no sessions (view hidden via
  // codexAvailable when codex isn't installed/enabled).
  _buildCodexSessions() {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (!cwd) return [];
    const sessions = listCodexSessions(cwd);
    // Launcher-side rename wins over the codex thread_name (parallel to kiro).
    const titleMap = sessionStoreGet(this._storeKey('titles'), {});

    const itemMap = new Map();
    const mtimeMap = new Map();
    for (const s of sessions) {
      const label = titleMap[s.sessionId] || s.title || `${(s.sessionId || '').substring(0, 8)}…`;
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      const mtime = s.mtime || 0;
      item.description = mtime ? _relTime(mtime) : '';
      item.iconPath = new vscode.ThemeIcon('comment-discussion');
      item.contextValue = 'codexSession';
      item._agentMode = 'codex';
      item.tooltip = `Codex session: ${s.sessionId}\n${s.cwd || ''}`;
      item._sessionId = s.sessionId;
      item._mtime = mtime;
      item._searchText = label;
      item.command = {
        command: 'claudeCodeLauncher.resumeSession',
        title: 'Resume',
        // codexResume → exact `codex resume <id>` resume in its cwd.
        arguments: [s.sessionId, { agent: 'codex', codexResume: true, cwd: s.cwd, title: label }],
      };
      itemMap.set(s.sessionId, item);
      mtimeMap.set(s.sessionId, mtime);
    }

    // Same custom-groups + ungrouped builder as kiro/antigravity (no Trash —
    // rollouts live in codex's own date-sharded tree; we don't move its files).
    return this._buildAgentGroups(itemMap, mtimeMap);
  }

  // Grok Sessions — used by the dedicated 'Grok Sessions' view (agentMode
  // 'grok'). Root children are the workspace's grok sessions from
  // ~/.grok/sessions/<encoded-cwd>/<session-id>/summary.json + updates.jsonl,
  // filtered to the current cwd. Click → resume via `grok --resume <id>`.
  _buildGrokSessions() {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (!cwd) return [];
    const sessions = listGrokSessions(cwd);
    const titleMap = sessionStoreGet(this._storeKey('titles'), {});

    const itemMap = new Map();
    const mtimeMap = new Map();
    for (const s of sessions) {
      const label = titleMap[s.sessionId] || s.title || `${(s.sessionId || '').substring(0, 8)}…`;
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      const mtime = s.mtime || 0;
      item.description = mtime ? _relTime(mtime) : '';
      item.iconPath = new vscode.ThemeIcon('comment-discussion');
      item.contextValue = 'grokSession';
      item._agentMode = 'grok';
      item.tooltip = `Grok session: ${s.sessionId}\n${s.cwd || ''}`;
      item._sessionId = s.sessionId;
      item._mtime = mtime;
      item._searchText = label;
      item.command = {
        command: 'claudeCodeLauncher.resumeSession',
        title: 'Resume',
        arguments: [s.sessionId, { agent: 'grok', grokResume: true, cwd: s.cwd, title: label }],
      };
      itemMap.set(s.sessionId, item);
      mtimeMap.set(s.sessionId, mtime);
    }

    return this._buildAgentGroups(itemMap, mtimeMap);
  }

  // gjc (Gajae Code) Sessions — used by the dedicated 'Gajae Sessions' view
  // (agentMode 'gjc'). Root children are the workspace's gjc sessions from
  // <agentDir>/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl (listGjcSessions: cwd +
  // title from each file's line-1 header), filtered to the current cwd. Click →
  // resume via `gjc -r <path>` (the resumeSession command's gjc branch). gjc
  // sessions ARE jsonl, so resumed sessions get a working reader.
  _buildGjcSessions() {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (!cwd) return [];
    const sessions = listGjcSessions(cwd);
    const titleMap = sessionStoreGet(this._storeKey('titles'), {});

    const itemMap = new Map();
    const mtimeMap = new Map();
    for (const s of sessions) {
      const label = titleMap[s.sessionId] || s.title || `${(s.sessionId || '').substring(0, 8)}…`;
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      const mtime = s.mtime || 0;
      item.description = mtime ? _relTime(mtime) : '';
      item.iconPath = new vscode.ThemeIcon('comment-discussion');
      item.contextValue = 'gjcSession';
      item._agentMode = 'gjc';
      item.tooltip = `Gajae (gjc) session: ${s.sessionId}\n${s.cwd || ''}`;
      item._sessionId = s.sessionId;
      item._mtime = mtime;
      item._searchText = label;
      item.command = {
        command: 'claudeCodeLauncher.resumeSession',
        title: 'Resume',
        // gjcResume → exact `gjc -r <path>` resume in its cwd.
        arguments: [s.sessionId, { agent: 'gjc', gjcResume: true, cwd: s.cwd, title: label }],
      };
      itemMap.set(s.sessionId, item);
      mtimeMap.set(s.sessionId, mtime);
    }

    return this._buildAgentGroups(itemMap, mtimeMap);
  }

  // Chief Sessions — used by the dedicated 'Chief Sessions' view (agentMode
  // 'chief'). Root children are launcher-owned chief-repl sessions from
  // <chiefSessionsDir>/<session-id>/summary.json + updates.jsonl. Click →
  // resume via `chief-repl --resume <id>`.
  _buildChiefSessions() {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (!cwd) return [];
    const sessions = listChiefSessions(cwd);
    const titleMap = sessionStoreGet(this._storeKey('titles'), {});

    const itemMap = new Map();
    const mtimeMap = new Map();
    for (const s of sessions) {
      const label = titleMap[s.sessionId] || s.title || `${(s.sessionId || '').substring(0, 8)}…`;
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      const mtime = s.mtime || 0;
      item.description = mtime ? _relTime(mtime) : '';
      item.iconPath = this._agentIcon('chief');
      item.contextValue = 'chiefSession';
      item._agentMode = 'chief';
      item.tooltip = `Chief session: ${s.sessionId}\n${s.cwd || ''}`;
      item._sessionId = s.sessionId;
      item._mtime = mtime;
      item._searchText = label;
      item.command = {
        command: 'claudeCodeLauncher.resumeSession',
        title: 'Resume',
        arguments: [s.sessionId, { agent: 'chief', chiefResume: true, cwd: s.cwd, title: label }],
      };
      itemMap.set(s.sessionId, item);
      mtimeMap.set(s.sessionId, mtime);
    }

    return this._buildAgentGroups(itemMap, mtimeMap);
  }

  // Shared "custom groups + ungrouped sessions" builder used by the kiro and
  // antigravity views. claude keeps its richer _buildGroups (Resume
  // Later / Recent / Trash / archive) — this is the generalised subset:
  //   [ ...customGroupNodes, ...ungroupedSessionItems ]
  // All store reads go through _storeKey so the agent's own keys are used.
  _buildAgentGroups(itemMap, mtimeMap) {
    // v3.11: drop leaves that don't match the active search filter before
    // grouping; empty groups then collapse out via makeGroupNode's null return,
    // and stateOf force-expands the rest so matches are visible.
    const filterActive = !!this._filterText;
    if (filterActive) {
      for (const [sid, item] of [...itemMap]) {
        if (!this._matchesText(item._searchText || item.label)) {
          itemMap.delete(sid);
          mtimeMap.delete(sid);
        }
      }
    }
    const customGroupsRaw = sessionStoreGet(this._storeKey('groups'), {});
    // Synthesize empty ancestor paths so { 'Foo/Bar': [...] } renders 'Foo'.
    const customGroups = { ...customGroupsRaw };
    for (const key of Object.keys(customGroupsRaw)) {
      const segs = key.split('/');
      for (let i = 1; i < segs.length; i++) {
        const ancestor = segs.slice(0, i).join('/');
        if (!(ancestor in customGroups)) customGroups[ancestor] = [];
      }
    }
    const sortOrder = sessionStoreGet(this._storeKey('sortOrder'), {});
    const cmp = this._cmp(sortOrder, mtimeMap);

    // Sub-session nesting (same 2-level model as claude). A session is a
    // sub-session when its stored parent exists in itemMap. Kiro items have no
    // lazy _jsonlPath metadata row, so sub-sessions attach directly to the
    // parent's _children (getChildren returns element._children for these) and
    // the parent is flipped to a Collapsed state so the caret renders.
    const parents = sessionStoreGet(this._storeKey('parent'), {});
    const isSubSession = (sid) => {
      const pid = parents[sid];
      return pid && itemMap.has(pid);
    };
    for (const [sid, item] of itemMap) {
      const pid = parents[sid];
      if (pid && itemMap.has(pid)) {
        const kiroParent = itemMap.get(pid);
        // kiro items carry no lazy metadata row, so nested children attach
        // directly to _children (getChildren returns element._children here).
        const kids = kiroParent._children || [];
        kids.push(item);
        kiroParent._children = kids;
        item.contextValue = 'subSession';
        item._agentMode = this._agentMode;
      }
    }
    for (const item of itemMap.values()) {
      if (item._children && item._children.length > 0) {
        item._children.sort(cmp);
        item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      }
    }

    const groupedSet = new Set();
    for (const ids of Object.values(customGroups)) {
      for (const id of ids) groupedSet.add(id);
    }

    const exp = this._expandedGroups;
    // v3.11: force every group open while a search filter is active so matches
    // aren't hidden inside collapsed groups.
    const stateOf = (name) => (filterActive || exp.has(name)) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;

    const makeGroupNode = (name) => {
      const ids = customGroups[name] || [];
      const directItems = ids
        .map(id => itemMap.get(id))
        .filter(Boolean)
        .filter(it => !isSubSession(it._sessionId));
      directItems.sort(cmp);

      const myDepth = pathDepth(name);
      const childGroupNames = Object.keys(customGroups).filter(k => {
        if (pathDepth(k) !== myDepth + 1) return false;
        return k.startsWith(name + '/');
      });
      const allGroupKeys = Object.keys(customGroups);
      childGroupNames.sort((a, b) => allGroupKeys.indexOf(a) - allGroupKeys.indexOf(b));
      const subGroupNodes = childGroupNames.map(makeGroupNode).filter(Boolean);

      const totalCount = directItems.length + subGroupNodes.reduce((s, n) => s + (n._totalCount || 0), 0);
      if (totalCount === 0 && subGroupNodes.length === 0) return null;

      const leafLabel = name.includes('/') ? name.substring(name.lastIndexOf('/') + 1) : name;
      const label = totalCount > 0 ? `${leafLabel} (${totalCount})` : leafLabel;
      const collState = (subGroupNodes.length > 0 || directItems.length > 0)
        ? stateOf(name)
        : vscode.TreeItemCollapsibleState.Collapsed;
      const group = new vscode.TreeItem(label, collState);
      group.iconPath = new vscode.ThemeIcon(subGroupNodes.length > 0 ? 'folder-opened' : 'folder');
      group.contextValue = 'customGroup';
      group._groupName = name;
      group._agentMode = this._agentMode;
      group._children = [...subGroupNodes, ...directItems];
      group._totalCount = totalCount;
      return group;
    };

    const out = [];
    const rootGroupNames = Object.keys(customGroups).filter(k => pathDepth(k) === 1);
    for (const name of rootGroupNames) {
      const node = makeGroupNode(name);
      if (node) out.push(node);
    }

    // Recent Sessions — ungrouped sessions wrapped in a collapsible header,
    // mirroring the claude view (was previously appended flat). Sub-sessions
    // are excluded — they render nested under their parent.
    const ungrouped = [...itemMap.values()].filter(it =>
      !groupedSet.has(it._sessionId) && !isSubSession(it._sessionId)
    );
    ungrouped.sort(cmp);
    if (ungrouped.length > 0) {
      const rsName = t('recentSessionsGroup');
      const recentGroup = new vscode.TreeItem(`${rsName} (${ungrouped.length})`, stateOf(rsName));
      recentGroup.iconPath = new vscode.ThemeIcon('history');
      recentGroup.contextValue = 'recentGroup';
      recentGroup._children = ungrouped;
      out.push(recentGroup);
    }

    // Trash — kiro sessions moved to <kiro cli>/trash (both .json + .jsonl).
    // listKiroSessions reads only the top-level cli dir, so trashed sessions
    // are already excluded from the active items above; here we surface them in
    // a collapsible Trash node. Clicking a trashed item restores it (the
    // transcript lives in trash, so a direct resume would fail).
    if (this._agentMode === 'kiro') {
      const kiroCwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      let trashed = [];
      try { trashed = listKiroSessions(kiroCwd, this._kiroTrashDir()); } catch (_) {}
      if (trashed.length > 0) {
        const titleMap = sessionStoreGet(this._storeKey('titles'), {});
        const trashItems = trashed.map((s) => {
          const label = titleMap[s.sessionId] || s.title || `${(s.sessionId || '').substring(0, 8)}…`;
          const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
          const mtime = Date.parse(s.updatedAt || '') || 0;
          item.description = mtime ? `trashed · ${_relTime(mtime)}` : 'trashed';
          item.iconPath = new vscode.ThemeIcon('trash');
          item.contextValue = 'kiroTrashed';
          item.tooltip = `Trashed Kiro session: ${s.sessionId}\nClick to restore.`;
          item._sessionId = s.sessionId;
          item._cwd = kiroCwd;
          item._mtime = mtime;
          item.command = { command: 'claudeCodeLauncher.restoreKiroSession', title: 'Restore', arguments: [item] };
          return item;
        });
        const trashList = filterActive ? trashItems.filter((it) => this._matchesText(it.label)) : trashItems;
        if (trashList.length > 0) {
          const trashGroup = new vscode.TreeItem(`Trash (${trashList.length})`, stateOf('Trash'));
          trashGroup.iconPath = new vscode.ThemeIcon('trash');
          trashGroup.contextValue = 'kiroTrashGroup';
          trashGroup._children = trashList;
          out.push(trashGroup);
        }
      }
    }
    if (filterActive && out.length === 0) return [this._noMatchRow()];
    return out;
  }

  // Kiro trash dir — trashed kiro sessions (<id>.json + <id>.jsonl) live here,
  // a subdir of the cli sessions dir that listKiroSessions/kiro-cli don't scan.
  _kiroTrashDir() {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    return path.join(getKiroSessionsDir(cwd), 'trash');
  }

  // v3.6.9: protectedIds = ids in custom groups + Resume Later. archivedIds =
  // ids in groups flagged as archive via claudeSessionGroupArchived. The old
  // hard cap of `slice(0, 30)` dropped any session not in the top-30 mtime
  // list — sessions a user had explicitly bucketed into a group would silently
  // disappear once newer activity bumped them past the window. v3.6.9
  // keeps the Recent-Sessions hot path (top 30) AND surfaces:
  //   - protected members up to a soft cap of 100 (mtime DESC). The cap aligns
  //     with the v3.5.9 LRU file-meta cache (size 100), so the file-title /
  //     first-message parse never exceeds the cache's working set.
  //   - archived members regardless of count, but with **no title/firstMsg
  //     extraction** — only stat. extractAiTitle / extractFirstUserMessage are
  //     the heavy calls (whole-file read + parse) so skipping them is what
  //     makes archive groups cheap at scale. Labels fall back to the saved
  //     title or `<8-char prefix>…`.
  _loadSessions(protectedIds = new Set(), archivedIds = new Set()) {
    const projDir = this._getProjectDir();
    if (!projDir) return [];

    let allFiles;
    try {
      allFiles = fs.readdirSync(projDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const fullPath = path.join(projDir, f);
          const st = fs.statSync(fullPath);
          return { name: f, path: fullPath, mtime: st.mtimeMs, size: st.size };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      return [];
    }

    const PROTECTED_CAP = 100;
    const TOP_RECENT = 30;
    const top30 = allFiles.slice(0, TOP_RECENT);
    const top30Names = new Set(top30.map(f => f.name.replace('.jsonl', '')));

    // Protected (regular groups + Resume Later) not already in top-30, capped
    // at PROTECTED_CAP by mtime DESC. Archive membership wins over protected
    // when a session is in both — archived path is cheaper, so prefer it.
    const protectedExtras = [];
    for (const f of allFiles) {
      const sid = f.name.replace('.jsonl', '');
      if (top30Names.has(sid)) continue;
      if (archivedIds.has(sid)) continue;
      if (!protectedIds.has(sid)) continue;
      protectedExtras.push(f);
      if (protectedExtras.length >= PROTECTED_CAP) break;
    }

    // Archived: every member outside top-30. No cap. Title/firstMsg skipped.
    const archivedExtras = [];
    for (const f of allFiles) {
      const sid = f.name.replace('.jsonl', '');
      if (top30Names.has(sid)) continue;
      if (!archivedIds.has(sid)) continue;
      archivedExtras.push(f);
    }

    const titleMap = sessionStoreGet('claudeSessionTitles', {});
    const items = [];

    // Full-extract path: top 30 + protected extras. Title / firstMsg parsing
    // gates a session out of the tree if all three are missing.
    for (const file of [...top30, ...protectedExtras]) {
      const sessionId = file.name.replace('.jsonl', '');
      const savedTitle = titleMap[sessionId];
      // v3.5.9: cached extract. With ~30 top files and several multi-MB
      // sessions in iloom's recent list, this used to re-read + re-parse the
      // same file every refresh (12+ per minute on a live workspace). The
      // {mtime, size}-keyed cache makes repeat refreshes hit local memory.
      const meta = this._getFileMeta(file.path, file.mtime, file.size) || { aiTitle: null, firstMsg: null };
      const aiTitle = meta.aiTitle;
      const firstMsg = meta.firstMsg;
      if (!savedTitle && !aiTitle && !firstMsg) continue;

      const date = new Date(file.mtime);
      const dateStr = `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

      const displayText = savedTitle || aiTitle || firstMsg;
      const label = displayText.length > 40 ? displayText.substring(0, 40) + '...' : displayText;

      // Forced Collapsed reserves a caret column on every sibling row;
      // without it, leaf-only sub-group children render flush with their header.
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = dateStr;
      // v3.5.8: resourceUri carries size into the FileDecorationProvider so
      // the label gets a yellow/red tint at 5/10 MB. The query also encodes
      // trashed=0 so the recommendation tooltip differentiates from trash.
      item.resourceUri = buildSessionDecorationUri(sessionId, file.size, false);
      const tooltipHead = savedTitle || aiTitle;
      const tooltipBody = firstMsg && firstMsg !== tooltipHead ? firstMsg : '';
      item.tooltip = `${tooltipHead ? tooltipHead + '\n\n' : ''}${tooltipBody ? tooltipBody + '\n\n' : ''}Session: ${sessionId}\n${date.toLocaleString()}${_sizeWarningSuffix(file.size, false)}`;
      // v2.6.0: conversation-style icons. Titled sessions get a "discussion"
      // (two overlapping speech bubbles) icon; untitled get "comment-draft"
      // (dashed-border bubble) so the two are visually distinguishable.
      // Both saved titles and ai-generated titles count as "titled".
      item.iconPath = new vscode.ThemeIcon((savedTitle || aiTitle) ? 'comment-discussion' : 'comment-draft');
      item.command = {
        command: 'claudeCodeLauncher.resumeSession',
        title: t('resumeSession'),
        arguments: [sessionId]
      };
      item.contextValue = 'session';
      item._sessionId = sessionId;
      item._mtime = file.mtime;
      // v3.5.9: stash the path + size on the item so getChildren can build
      // the metadata row lazily on expand. extractMessageCount is the most
      // expensive call in this loop on huge sessions — deferring it cuts the
      // per-refresh fan-out from O(30 × file size) to O(30 × stat) on first
      // render, with extractMessageCount only ever running on items the user
      // has actively expanded.
      item._jsonlPath = file.path;
      item._fileSize = file.size;
      item._searchText = displayText;

      items.push(item);
    }

    // v3.6.9: archived path. No title/firstMsg parse — stat-only labels keep
    // a group with hundreds of multi-MB jsonls effectively free to render.
    // Label uses the saved title if any, otherwise the session id prefix; the
    // sessions are still resumable by command and the metadata row built
    // lazily on expand parses the file on demand (one-time + cached).
    for (const file of archivedExtras) {
      const sessionId = file.name.replace('.jsonl', '');
      const savedTitle = titleMap[sessionId];

      const date = new Date(file.mtime);
      const dateStr = `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

      const displayText = savedTitle || `${sessionId.substring(0, 8)}…`;
      const label = displayText.length > 40 ? displayText.substring(0, 40) + '...' : displayText;

      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = dateStr;
      item.resourceUri = buildSessionDecorationUri(sessionId, file.size, false);
      item.tooltip = `${savedTitle ? savedTitle + '\n\n' : ''}Session: ${sessionId}\n${date.toLocaleString()}\n(archived — title not parsed; expand to load)${_sizeWarningSuffix(file.size, false)}`;
      item.iconPath = new vscode.ThemeIcon(savedTitle ? 'comment-discussion' : 'archive');
      item.command = {
        command: 'claudeCodeLauncher.resumeSession',
        title: t('resumeSession'),
        arguments: [sessionId]
      };
      item.contextValue = 'session';
      item._sessionId = sessionId;
      item._mtime = file.mtime;
      item._jsonlPath = file.path;
      item._fileSize = file.size;
      item._archived = true;
      item._searchText = displayText;

      items.push(item);
    }
    return items;
  }

  // ─── Sort + Nest helpers (v2.6.0) ───────────────────────────────────────

  // Get a session's scope: { group?: string, parent?: string } where it lives.
  // If parent is set, that takes precedence (sibling set = same parent).
  // Else group membership determines sibling set.
  _getScope(sessionId) {
    const parents = sessionStoreGet(this._storeKey('parent'), {});
    if (parents[sessionId]) return { parent: parents[sessionId] };
    const groups = sessionStoreGet(this._storeKey('groups'), {});
    for (const [gname, ids] of Object.entries(groups)) {
      if (ids.includes(sessionId)) return { group: gname };
    }
    return {}; // ungrouped top-level (Recent Sessions)
  }

  // Agent-aware {id, mtime} list. claude reads .claude/projects jsonls via
  // _loadSessions; kiro reads the workspace's kiro session metas. Both feed the
  // sibling/sort logic so it works identically across agents.
  _loadSessionIds() {
    if (this._agentMode === 'kiro') {
      const kiroCwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      if (!kiroCwd) return [];
      return listKiroSessions(kiroCwd).map(s => ({
        _sessionId: s.sessionId,
        _mtime: Date.parse(s.updatedAt || '') || 0,
      }));
    }
    if (this._agentMode === 'antigravity') {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      if (!cwd) return [];
      // listAntigravitySessions already returns mtime as epoch-ms.
      return listAntigravitySessions(cwd).map(s => ({
        _sessionId: s.sessionId,
        _mtime: s.mtime || 0,
      }));
    }
    if (this._agentMode === 'codex') {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      if (!cwd) return [];
      return listCodexSessions(cwd).map(s => ({
        _sessionId: s.sessionId,
        _mtime: s.mtime || 0,
      }));
    }
    if (this._agentMode === 'grok') {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      if (!cwd) return [];
      return listGrokSessions(cwd).map(s => ({
        _sessionId: s.sessionId,
        _mtime: s.mtime || 0,
      }));
    }
    if (this._agentMode === 'gjc') {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      if (!cwd) return [];
      return listGjcSessions(cwd).map(s => ({
        _sessionId: s.sessionId,
        _mtime: s.mtime || 0,
      }));
    }
    if (this._agentMode === 'chief') {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      if (!cwd) return [];
      return listChiefSessions(cwd).map(s => ({
        _sessionId: s.sessionId,
        _mtime: s.mtime || 0,
      }));
    }
    if (this._agentMode === 'unified') {
      // claude leaves (top-recent set) + every other agent's sessions, so the
      // sibling/sort math spans all agents the unified view shows.
      const claude = this._loadSessions().map(i => ({ _sessionId: i._sessionId, _mtime: i._mtime || 0 }));
      const others = this._loadOtherAgentItems().map(i => ({ _sessionId: i._sessionId, _mtime: i._mtime || 0 }));
      return [...claude, ...others];
    }
    return this._loadSessions();
  }

  // Get ordered sibling list for a given scope. All sessionIds that share the
  // same scope, sorted by current effective order (sortOrder ? mtime).
  _getSiblings(scope) {
    const allItems = this._loadSessionIds();
    const idSet = new Set(allItems.map(i => i._sessionId));
    const parents = sessionStoreGet(this._storeKey('parent'), {});
    const groups = sessionStoreGet(this._storeKey('groups'), {});
    const sortOrder = sessionStoreGet(this._storeKey('sortOrder'), {});
    const mtimeMap = new Map(allItems.map(i => [i._sessionId, i._mtime || 0]));

    let siblings;
    if (scope.parent) {
      siblings = allItems.filter(i => parents[i._sessionId] === scope.parent).map(i => i._sessionId);
    } else if (scope.group) {
      siblings = (groups[scope.group] || [])
        .filter(id => idSet.has(id) && !parents[id]);
    } else {
      const grouped = new Set();
      for (const ids of Object.values(groups)) for (const id of ids) grouped.add(id);
      siblings = allItems
        .filter(i => !grouped.has(i._sessionId) && !parents[i._sessionId])
        .map(i => i._sessionId);
    }
    siblings.sort((a, b) => {
      const oa = sortOrder[a], ob = sortOrder[b];
      if (oa != null && ob != null) return oa - ob;
      if (oa != null) return -1;
      if (ob != null) return 1;
      return (mtimeMap.get(b) || 0) - (mtimeMap.get(a) || 0);
    });
    return siblings;
  }

  // Assign sparse integer sortOrder (10, 20, 30, ...) to an ordered id list.
  // Overwrites existing sortOrder entries for these ids only.
  _writeSortOrder(orderedIds) {
    const sortOrder = sessionStoreGet(this._storeKey('sortOrder'), {});
    let n = 10;
    for (const sid of orderedIds) {
      sortOrder[sid] = n;
      n += 10;
    }
    sessionStoreUpdate(this._storeKey('sortOrder'), sortOrder);
  }

  // Move a session up/down among its siblings.
  moveSessionUp(sessionId) {
    const scope = this._getScope(sessionId);
    const siblings = this._getSiblings(scope);
    const idx = siblings.indexOf(sessionId);
    if (idx <= 0) return;
    [siblings[idx - 1], siblings[idx]] = [siblings[idx], siblings[idx - 1]];
    this._writeSortOrder(siblings);
    this.refresh();
  }

  moveSessionDown(sessionId) {
    const scope = this._getScope(sessionId);
    const siblings = this._getSiblings(scope);
    const idx = siblings.indexOf(sessionId);
    if (idx < 0 || idx >= siblings.length - 1) return;
    [siblings[idx], siblings[idx + 1]] = [siblings[idx + 1], siblings[idx]];
    this._writeSortOrder(siblings);
    this.refresh();
  }

  // Set parent for session (nest as sub-session). 2-level limit enforced:
  // targetParent must itself be top-level (no parent), and sessionId must not
  // have children.
  setSessionParent(sessionId, parentSessionId) {
    if (sessionId === parentSessionId) return { ok: false, reason: 'self' };
    const parents = sessionStoreGet(this._storeKey('parent'), {});
    // 2-level limit: parent candidate must not itself be a sub-session
    if (parents[parentSessionId]) return { ok: false, reason: 'depth' };
    // sessionId must not have existing children (would push them to level 3)
    const hasChildren = Object.values(parents).some(p => p === sessionId);
    if (hasChildren) return { ok: false, reason: 'hasChildren' };
    parents[sessionId] = parentSessionId;
    sessionStoreUpdate(this._storeKey('parent'), parents);
    // Also remove sessionId from any custom group and saved sessions
    // (sub-sessions belong to their parent's scope, not an independent group)
    const groups = sessionStoreGet(this._storeKey('groups'), {});
    for (const g of Object.keys(groups)) {
      groups[g] = groups[g].filter(id => id !== sessionId);
      if (groups[g].length === 0) delete groups[g];
    }
    sessionStoreUpdate(this._storeKey('groups'), groups);
    this.refresh();
    return { ok: true };
  }

  removeSessionParent(sessionId) {
    const parents = sessionStoreGet(this._storeKey('parent'), {});
    if (!parents[sessionId]) return;
    delete parents[sessionId];
    sessionStoreUpdate(this._storeKey('parent'), parents);
    this.refresh();
  }

  // ─── TreeDragAndDropController ──────────────────────────────────────────

  handleDrag(source, dataTransfer, _token) {
    // Sessions (including sub-sessions + agent sessions) → session MIME.
    // The MIME is agent-scoped (_sessionMime), so a kiro drag carries the kiro
    // MIME and can only land in a target view that lists that MIME.
    const sessionIds = source
      .filter(it => it && (it.contextValue === 'session' || it.contextValue === 'subSession' || it.contextValue === 'kiroSession' || it.contextValue === 'antigravitySession' || it.contextValue === 'codexSession' || it.contextValue === 'grokSession' || it.contextValue === 'gjcSession' || it.contextValue === 'chiefSession'))
      .map(it => it._sessionId)
      .filter(Boolean);
    if (sessionIds.length > 0) {
      dataTransfer.set(this._sessionMime, new vscode.DataTransferItem(sessionIds));
    }
    // Custom groups → group MIME (for reordering)
    const groupNames = source
      .filter(it => it && it.contextValue === 'customGroup')
      .map(it => it._groupName)
      .filter(Boolean);
    if (groupNames.length > 0) {
      dataTransfer.set(this._groupMime, new vscode.DataTransferItem(groupNames));
    }
  }

  async handleDrop(target, dataTransfer, _token) {
    // Group drag takes precedence — dragged item is a group, reorder groups.
    const groupItem = dataTransfer.get(this._groupMime);
    if (groupItem) {
      const names = this._asArray(groupItem.value);
      if (names.length === 0) return;
      // Drop on another custom group → reorder before target.
      // Drop anywhere else → no-op (don't transform groups into sessions).
      if (target && target.contextValue === 'customGroup' && target._groupName) {
        this._reorderGroupsBefore(names, target._groupName);
        this.refresh();
      }
      return;
    }

    // Session drag (existing behavior)
    const sessItem = dataTransfer.get(this._sessionMime);
    if (!sessItem) return;
    const ids = this._asArray(sessItem.value);
    if (ids.length === 0) return;

    // Drop on custom group → move to that group (root level, end)
    if (target && target.contextValue === 'customGroup') {
      this._moveToGroup(ids, target._groupName);
      this.refresh();
      return;
    }

    // Drop on Recent Sessions group → ungrouped top level (claude only)
    if (target && target.contextValue === 'recentGroup') {
      this._moveToUngrouped(ids);
      this.refresh();
      return;
    }

    // Drop on another session → reorder: insert before target, inherit scope.
    // Agent session leaves are included so those sessions reorder/regroup like
    // claude ones inside their own MIME-scoped view.
    if (target && (target.contextValue === 'session' || target.contextValue === 'subSession' || target.contextValue === 'kiroSession' || target.contextValue === 'antigravitySession' || target.contextValue === 'codexSession' || target.contextValue === 'grokSession' || target.contextValue === 'gjcSession' || target.contextValue === 'chiefSession')) {
      this._reorderBefore(ids, target._sessionId);
      this.refresh();
      return;
    }

    // Drop in empty area — no-op
  }

  _asArray(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
      try { return JSON.parse(v); } catch (_) { return [v]; }
    }
    return [v];
  }

  // ─── Group ordering helpers (v2.6.0) ────────────────────────────────────

  // Rewrite claudeSessionGroups with the given name order. Preserves each
  // group's session-id array. Object insertion order is preserved by modern
  // JS engines for non-integer string keys, and JSON.stringify honors it —
  // so we get stable persistence without an extra order map.
  _writeGroupOrder(orderedNames) {
    const groups = sessionStoreGet(this._storeKey('groups'), {});
    const rebuilt = {};
    for (const name of orderedNames) {
      if (groups[name]) rebuilt[name] = groups[name];
    }
    // Append any groups that weren't in orderedNames (defensive)
    for (const [name, ids] of Object.entries(groups)) {
      if (!(name in rebuilt)) rebuilt[name] = ids;
    }
    sessionStoreUpdate(this._storeKey('groups'), rebuilt);
  }

  _reorderGroupsBefore(draggedNames, targetName) {
    const groups = sessionStoreGet(this._storeKey('groups'), {});
    const names = Object.keys(groups);
    const draggedSet = new Set(draggedNames);
    // Remove dragged names first
    const remaining = names.filter(n => !draggedSet.has(n));
    const tIdx = remaining.indexOf(targetName);
    const insertList = draggedNames.filter(n => names.includes(n));
    if (tIdx >= 0) {
      remaining.splice(tIdx, 0, ...insertList);
    } else {
      remaining.unshift(...insertList);
    }
    this._writeGroupOrder(remaining);
  }

  moveGroupUp(groupName) {
    const groups = sessionStoreGet(this._storeKey('groups'), {});
    const names = Object.keys(groups);
    const idx = names.indexOf(groupName);
    if (idx <= 0) return;
    [names[idx - 1], names[idx]] = [names[idx], names[idx - 1]];
    this._writeGroupOrder(names);
    this.refresh();
  }

  moveGroupDown(groupName) {
    const groups = sessionStoreGet(this._storeKey('groups'), {});
    const names = Object.keys(groups);
    const idx = names.indexOf(groupName);
    if (idx < 0 || idx >= names.length - 1) return;
    [names[idx], names[idx + 1]] = [names[idx + 1], names[idx]];
    this._writeGroupOrder(names);
    this.refresh();
  }

  _moveToGroup(sessionIds, groupName) {
    const groups = sessionStoreGet(this._storeKey('groups'), {});
    const parents = sessionStoreGet(this._storeKey('parent'), {});
    for (const sid of sessionIds) {
      // Remove from all groups and clear parent
      for (const g of Object.keys(groups)) {
        groups[g] = groups[g].filter(id => id !== sid);
      }
      delete parents[sid];
    }
    if (!groups[groupName]) groups[groupName] = [];
    for (const sid of sessionIds) {
      if (!groups[groupName].includes(sid)) groups[groupName].push(sid);
    }
    for (const g of Object.keys(groups)) {
      if (groups[g].length === 0) delete groups[g];
    }
    sessionStoreUpdate(this._storeKey('groups'), groups);
    sessionStoreUpdate(this._storeKey('parent'), parents);
  }

  _moveToUngrouped(sessionIds) {
    const groups = sessionStoreGet(this._storeKey('groups'), {});
    const parents = sessionStoreGet(this._storeKey('parent'), {});
    for (const sid of sessionIds) {
      for (const g of Object.keys(groups)) {
        groups[g] = groups[g].filter(id => id !== sid);
      }
      delete parents[sid];
    }
    for (const g of Object.keys(groups)) {
      if (groups[g].length === 0) delete groups[g];
    }
    sessionStoreUpdate(this._storeKey('groups'), groups);
    sessionStoreUpdate(this._storeKey('parent'), parents);
  }

  // Reorder: move sessionIds right before targetSessionId. Dragged items
  // inherit target's scope (same group + same parent). 2-level safety: if
  // target is a sub-session and any dragged item has children, reject those.
  _reorderBefore(sessionIds, targetSessionId) {
    const parents = sessionStoreGet(this._storeKey('parent'), {});
    const groups = sessionStoreGet(this._storeKey('groups'), {});
    const targetParent = parents[targetSessionId];
    let targetGroup = null;
    for (const [gname, gids] of Object.entries(groups)) {
      if (gids.includes(targetSessionId)) { targetGroup = gname; break; }
    }

    // Filter: can't drop onto self
    const incoming = sessionIds.filter(sid => sid !== targetSessionId);
    if (incoming.length === 0) return;

    // 2-level safety: if target has parent (target is sub-session), dragged
    // items also become sub-sessions under same parent. Skip any dragged
    // item that has children of its own.
    const filtered = [];
    for (const sid of incoming) {
      if (targetParent) {
        const hasChildren = Object.values(parents).some(p => p === sid);
        if (hasChildren) continue; // would exceed 2 levels
      }
      filtered.push(sid);
    }
    if (filtered.length === 0) return;

    // Update scope for each dragged item
    for (const sid of filtered) {
      // Clear from any existing group
      for (const g of Object.keys(groups)) {
        if (g !== targetGroup) groups[g] = groups[g].filter(id => id !== sid);
      }
      // Set parent or group
      if (targetParent) {
        parents[sid] = targetParent;
      } else {
        delete parents[sid];
        if (targetGroup) {
          if (!groups[targetGroup]) groups[targetGroup] = [];
          if (!groups[targetGroup].includes(sid)) groups[targetGroup].push(sid);
        }
      }
    }
    for (const g of Object.keys(groups)) {
      if (groups[g].length === 0) delete groups[g];
    }
    sessionStoreUpdate(this._storeKey('groups'), groups);
    sessionStoreUpdate(this._storeKey('parent'), parents);

    // Rewrite sortOrder among siblings (scope of target, now includes filtered)
    const scope = targetParent ? { parent: targetParent } : (targetGroup ? { group: targetGroup } : {});
    let siblings = this._getSiblings(scope);
    // Remove dragged ids from siblings list, then insert before target
    const draggedSet = new Set(filtered);
    siblings = siblings.filter(sid => !draggedSet.has(sid));
    const tIdx = siblings.indexOf(targetSessionId);
    if (tIdx >= 0) {
      siblings.splice(tIdx, 0, ...filtered);
    } else {
      siblings.unshift(...filtered);
    }
    this._writeSortOrder(siblings);
  }
}

module.exports = { SessionTreeDataProvider };
