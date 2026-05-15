// @module tree/SessionTreeDataProvider — sidebar tree view showing session groups.
// Groups: "Resume Later" (pinned) / custom groups / "Recent Sessions" / "Trash".
// Expansion state kept in _expandedGroups (Set), tracked via activate()'s onDidExpand/Collapse.
//
// v2.6.0: custom sort (claudeSessionSortOrder) + 2-level nesting (claudeSessionParent)
// + TreeDragAndDropController for drag-reorder / drag-to-group.

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { t } = require('../i18n');
const { sessionStoreGet, sessionStoreUpdate } = require('../store/sessionStore');
const { pathDepth, getDescendants } = require('../util/groupPath');
const { extractAiTitle, extractFirstUserMessage, extractMessageCount } = require('../lib/sessionJsonl');
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

class SessionTreeDataProvider {
  constructor(context) {
    this._context = context;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this._cache = null;
    this._expandedGroups = new Set([t('resumeLaterGroup')]);
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

    // TreeDragAndDropController interface (read by createTreeView(options))
    this.dropMimeTypes = [DND_SESSION_MIME, DND_GROUP_MIME];
    this.dragMimeTypes = [DND_SESSION_MIME, DND_GROUP_MIME];
  }

  refresh() {
    if (this._refreshTimer) return; // a fire is already queued; coalesce
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this._cache = null;
      this._onDidChangeTreeData.fire();
    }, this._REFRESH_DEBOUNCE_MS);
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
      this._cache = this._buildGroups();
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

  _buildGroups() {
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
    const allItems = this._loadSessions();

    const itemMap = new Map();
    const mtimeMap = new Map();
    for (const item of allItems) {
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
    for (const item of allItems) {
      const pid = parents[item._sessionId];
      if (pid && itemMap.has(pid)) {
        const parentItem = itemMap.get(pid);
        parentItem._subSessions = parentItem._subSessions || [];
        parentItem._subSessions.push(item);
        // Mark sub-session for context menu targeting
        item.contextValue = 'subSession';
      }
    }
    for (const item of allItems) {
      if (item._subSessions && item._subSessions.length > 0) {
        item._subSessions.sort(cmp);
      }
    }

    // Build map: sessionId → group name (for top-level sessions)
    const groupedSet = new Set();
    for (const ids of Object.values(customGroups)) {
      for (const id of ids) groupedSet.add(id);
    }
    for (const s of savedSessions) groupedSet.add(s.sessionId);

    const groups = [];
    const exp = this._expandedGroups;
    const stateOf = (name) => exp.has(name) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;

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
      const label = totalCount > 0 ? `${leafLabel} (${totalCount})` : leafLabel;
      const collState = (subGroupNodes.length > 0 || directItems.length > 0)
        ? stateOf(name)
        : vscode.TreeItemCollapsibleState.None;
      const group = new vscode.TreeItem(label, collState);
      group.iconPath = new vscode.ThemeIcon(subGroupNodes.length > 0 ? 'folder-opened' : 'folder');
      group.contextValue = 'customGroup';
      group._groupName = name;
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
    const recentItems = allItems.filter(item =>
      !groupedSet.has(item._sessionId) && !isSubSession(item._sessionId)
    );
    if (recentItems.length > 0) {
      recentItems.sort(cmp);
      const recentGroup = new vscode.TreeItem(`${rsName} (${recentItems.length})`, stateOf(rsName));
      recentGroup.iconPath = new vscode.ThemeIcon('history');
      recentGroup._children = recentItems;
      recentGroup.contextValue = 'recentGroup';
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
            const label = displayText.length > 40 ? displayText.substring(0, 40) + '...' : displayText;
            // Same caret-column reservation reason as live sessions.
            const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
            item.description = dateStr;
            item.iconPath = new vscode.ThemeIcon('trash');
            item.contextValue = 'trashed';
            // v3.5.8: size-based decoration for trash items too — the size
            // recommendation in the tooltip flips to "휴지통에서 정리 권장".
            item.resourceUri = buildSessionDecorationUri(sid, st.size, true);
            const tooltipHead = savedTitle || aiTitle || firstMsg;
            item.tooltip = `${tooltipHead ? tooltipHead + '\n\n' : ''}Session: ${sid}\n${date.toLocaleString()}${_sizeWarningSuffix(st.size, true)}`;
            // v3.5.9: metadata row deferred until expand — see getChildren.
            // Trash items skip extractMessageCount entirely; the lazy label
            // is just "trashed · <relTime> · <size>".
            item._sessionId = sid;
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
            groups.push(trashGroup);
          }
        }
      }
    }

    return groups;
  }

  _loadSessions() {
    const projDir = this._getProjectDir();
    if (!projDir) return [];

    let files;
    try {
      files = fs.readdirSync(projDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const fullPath = path.join(projDir, f);
          const st = fs.statSync(fullPath);
          return { name: f, path: fullPath, mtime: st.mtimeMs, size: st.size };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 30);
    } catch {
      return [];
    }

    const titleMap = sessionStoreGet('claudeSessionTitles', {});

    const items = [];
    for (const file of files) {
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

      items.push(item);
    }
    return items;
  }

  // ─── Sort + Nest helpers (v2.6.0) ───────────────────────────────────────

  // Get a session's scope: { group?: string, parent?: string } where it lives.
  // If parent is set, that takes precedence (sibling set = same parent).
  // Else group membership determines sibling set.
  _getScope(sessionId) {
    const parents = sessionStoreGet('claudeSessionParent', {});
    if (parents[sessionId]) return { parent: parents[sessionId] };
    const groups = sessionStoreGet('claudeSessionGroups', {});
    for (const [gname, ids] of Object.entries(groups)) {
      if (ids.includes(sessionId)) return { group: gname };
    }
    return {}; // ungrouped top-level (Recent Sessions)
  }

  // Get ordered sibling list for a given scope. All sessionIds that share the
  // same scope, sorted by current effective order (sortOrder ? mtime).
  _getSiblings(scope) {
    const allItems = this._loadSessions();
    const idSet = new Set(allItems.map(i => i._sessionId));
    const parents = sessionStoreGet('claudeSessionParent', {});
    const groups = sessionStoreGet('claudeSessionGroups', {});
    const sortOrder = sessionStoreGet('claudeSessionSortOrder', {});
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
    const sortOrder = sessionStoreGet('claudeSessionSortOrder', {});
    let n = 10;
    for (const sid of orderedIds) {
      sortOrder[sid] = n;
      n += 10;
    }
    sessionStoreUpdate('claudeSessionSortOrder', sortOrder);
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
    const parents = sessionStoreGet('claudeSessionParent', {});
    // 2-level limit: parent candidate must not itself be a sub-session
    if (parents[parentSessionId]) return { ok: false, reason: 'depth' };
    // sessionId must not have existing children (would push them to level 3)
    const hasChildren = Object.values(parents).some(p => p === sessionId);
    if (hasChildren) return { ok: false, reason: 'hasChildren' };
    parents[sessionId] = parentSessionId;
    sessionStoreUpdate('claudeSessionParent', parents);
    // Also remove sessionId from any custom group and saved sessions
    // (sub-sessions belong to their parent's scope, not an independent group)
    const groups = sessionStoreGet('claudeSessionGroups', {});
    for (const g of Object.keys(groups)) {
      groups[g] = groups[g].filter(id => id !== sessionId);
      if (groups[g].length === 0) delete groups[g];
    }
    sessionStoreUpdate('claudeSessionGroups', groups);
    this.refresh();
    return { ok: true };
  }

  removeSessionParent(sessionId) {
    const parents = sessionStoreGet('claudeSessionParent', {});
    if (!parents[sessionId]) return;
    delete parents[sessionId];
    sessionStoreUpdate('claudeSessionParent', parents);
    this.refresh();
  }

  // ─── TreeDragAndDropController ──────────────────────────────────────────

  handleDrag(source, dataTransfer, _token) {
    // Sessions (including sub-sessions) → session MIME
    const sessionIds = source
      .filter(it => it && (it.contextValue === 'session' || it.contextValue === 'subSession'))
      .map(it => it._sessionId)
      .filter(Boolean);
    if (sessionIds.length > 0) {
      dataTransfer.set(DND_SESSION_MIME, new vscode.DataTransferItem(sessionIds));
    }
    // Custom groups → group MIME (for reordering)
    const groupNames = source
      .filter(it => it && it.contextValue === 'customGroup')
      .map(it => it._groupName)
      .filter(Boolean);
    if (groupNames.length > 0) {
      dataTransfer.set(DND_GROUP_MIME, new vscode.DataTransferItem(groupNames));
    }
  }

  async handleDrop(target, dataTransfer, _token) {
    // Group drag takes precedence — dragged item is a group, reorder groups.
    const groupItem = dataTransfer.get(DND_GROUP_MIME);
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
    const sessItem = dataTransfer.get(DND_SESSION_MIME);
    if (!sessItem) return;
    const ids = this._asArray(sessItem.value);
    if (ids.length === 0) return;

    // Drop on custom group → move to that group (root level, end)
    if (target && target.contextValue === 'customGroup') {
      this._moveToGroup(ids, target._groupName);
      this.refresh();
      return;
    }

    // Drop on Recent Sessions group → ungrouped top level
    if (target && target.contextValue === 'recentGroup') {
      this._moveToUngrouped(ids);
      this.refresh();
      return;
    }

    // Drop on another session → reorder: insert before target, inherit scope
    if (target && (target.contextValue === 'session' || target.contextValue === 'subSession')) {
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
    const groups = sessionStoreGet('claudeSessionGroups', {});
    const rebuilt = {};
    for (const name of orderedNames) {
      if (groups[name]) rebuilt[name] = groups[name];
    }
    // Append any groups that weren't in orderedNames (defensive)
    for (const [name, ids] of Object.entries(groups)) {
      if (!(name in rebuilt)) rebuilt[name] = ids;
    }
    sessionStoreUpdate('claudeSessionGroups', rebuilt);
  }

  _reorderGroupsBefore(draggedNames, targetName) {
    const groups = sessionStoreGet('claudeSessionGroups', {});
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
    const groups = sessionStoreGet('claudeSessionGroups', {});
    const names = Object.keys(groups);
    const idx = names.indexOf(groupName);
    if (idx <= 0) return;
    [names[idx - 1], names[idx]] = [names[idx], names[idx - 1]];
    this._writeGroupOrder(names);
    this.refresh();
  }

  moveGroupDown(groupName) {
    const groups = sessionStoreGet('claudeSessionGroups', {});
    const names = Object.keys(groups);
    const idx = names.indexOf(groupName);
    if (idx < 0 || idx >= names.length - 1) return;
    [names[idx], names[idx + 1]] = [names[idx + 1], names[idx]];
    this._writeGroupOrder(names);
    this.refresh();
  }

  _moveToGroup(sessionIds, groupName) {
    const groups = sessionStoreGet('claudeSessionGroups', {});
    const parents = sessionStoreGet('claudeSessionParent', {});
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
    sessionStoreUpdate('claudeSessionGroups', groups);
    sessionStoreUpdate('claudeSessionParent', parents);
  }

  _moveToUngrouped(sessionIds) {
    const groups = sessionStoreGet('claudeSessionGroups', {});
    const parents = sessionStoreGet('claudeSessionParent', {});
    for (const sid of sessionIds) {
      for (const g of Object.keys(groups)) {
        groups[g] = groups[g].filter(id => id !== sid);
      }
      delete parents[sid];
    }
    for (const g of Object.keys(groups)) {
      if (groups[g].length === 0) delete groups[g];
    }
    sessionStoreUpdate('claudeSessionGroups', groups);
    sessionStoreUpdate('claudeSessionParent', parents);
  }

  // Reorder: move sessionIds right before targetSessionId. Dragged items
  // inherit target's scope (same group + same parent). 2-level safety: if
  // target is a sub-session and any dragged item has children, reject those.
  _reorderBefore(sessionIds, targetSessionId) {
    const parents = sessionStoreGet('claudeSessionParent', {});
    const groups = sessionStoreGet('claudeSessionGroups', {});
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
    sessionStoreUpdate('claudeSessionGroups', groups);
    sessionStoreUpdate('claudeSessionParent', parents);

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
