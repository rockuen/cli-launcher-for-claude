// @module store/sessionManager — save/restore open tabs across Reload Window.
// createPanel is injected as a callback to avoid circular imports with panel/ (Phase 6 target).

const state = require('../state');
const { sessionStoreGet, sessionStoreUpdate } = require('./sessionStore');
const { listAgents } = require('../agents/registry');

// Returns true when `title` is a default-generated tab title for any known agent
// (e.g. "Claude Code", "Claude Code (2)", "Kiro", "Kiro (3)").
// Used to skip overwriting titleMap entries with auto-generated names.
function isDefaultTabTitle(title) {
  if (!title) return false;
  return listAgents().some(({ label }) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( \\(\\d+\\))?$`).test(title));
}

function saveSessions() {
  const sessions = [];
  let order = 0;
  for (const [, entry] of state.panels) {
    if (entry.pty) {
      sessions.push({
        title: entry.title,
        memo: entry.memo || '',
        cwd: entry.cwd,
        sessionId: entry.sessionId,
        agent: entry.agent || 'claude',
        // Persist kiro Tree-resume flag so a Reload Window keeps the exact
        // --resume-id path instead of falling back to cwd-latest --resume.
        ...(entry.isKiroResume ? { isKiroResume: true } : {}),
        order: order++,
        viewColumn: entry.panel.viewColumn || 1
      });
    }
  }
  sessionStoreUpdate('claudeSessions', sessions);
  console.log('[Claude Launcher] saveSessions agents:', sessions.map(s => (s.title || '?') + '=' + (s.agent || '(none)')).join(' | '));

  // sessionId → title 매핑 저장 (사이드바 세션 목록용). agent별 스토어로 분리 —
  // claude는 claudeSessionTitles, kiro는 kiroSessionTitles. Kiro Sessions 트리가
  // kiroSessionTitles를 라벨로 읽으므로, 안 나누면 kiro 세션 rename이 claude
  // 스토어로 가 사이드바에 반영되지 않는다 (실제 버그였음).
  const claudeTitles = sessionStoreGet('claudeSessionTitles', {});
  const kiroTitles = sessionStoreGet('kiroSessionTitles', {});
  for (const s of sessions) {
    if (!s.sessionId || !s.title) continue;
    // 기본 탭 이름(Claude Code / Kiro 등 agent label + 번호)이면 기존 매핑 유지 (덮어쓰기 금지)
    if (isDefaultTabTitle(s.title)) continue;
    if (s.agent === 'kiro') kiroTitles[s.sessionId] = s.title;
    else claudeTitles[s.sessionId] = s.title;
  }
  sessionStoreUpdate('claudeSessionTitles', claudeTitles);
  sessionStoreUpdate('kiroSessionTitles', kiroTitles);
  state.refreshSessionTrees();
}

// Called at end of activate(). Restores in saved order with 500ms stagger
// for correct viewColumn placement in split views.
function restoreSessions(onRestore) {
  const sessions = sessionStoreGet('claudeSessions', []);
  console.log('[Claude Launcher] restoreSessions called, found:', sessions.length, 'sessions');
  console.log('[Claude Launcher] restore agents:', sessions.map(s => (s.title || '?') + '=' + (s.agent || '(none)')).join(' | '));
  if (sessions.length === 0) return;

  // Clear immediately to avoid double-restore on activate re-entry
  sessionStoreUpdate('claudeSessions', []);

  const sorted = [...sessions].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  sorted.forEach((session, i) => {
    setTimeout(() => {
      console.log('[Claude Launcher] Restoring session:', session.title, session.sessionId);
      onRestore(session);
    }, i * 500);
  });
}

module.exports = { saveSessions, restoreSessions };
