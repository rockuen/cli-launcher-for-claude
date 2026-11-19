// @module store/noBypassSessions — session ids that must never get a
// permission bypass, whichever way they are reopened.
//
// A tab the browser bridge opens carries someone else's page in its
// transcript, so it runs without the agent's bypass / trust-all flags
// (createPanel noPermissionBypass). The flag rides on the panel entry and the
// saved tab list, but a session can also come back through the session tree,
// a session link or a hand-off — paths that build a fresh session object. The
// ids are remembered here (globalState, newest last, capped) and createPanel
// checks them whenever it opens a session.

'use strict';

const KEY = 'claudeCodeLauncher.noBypassSessions';
const MAX = 500;

function list(context) {
  try {
    const v = context && context.globalState && context.globalState.get(KEY, []);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch (_) {
    return [];
  }
}

function isNoBypassSession(context, sessionId) {
  return !!sessionId && list(context).includes(sessionId);
}

function rememberNoBypassSession(context, sessionId) {
  if (!sessionId || !context || !context.globalState) return;
  const next = list(context).filter((x) => x !== sessionId);
  next.push(sessionId);
  try {
    const done = context.globalState.update(KEY, next.slice(-MAX));
    if (done && typeof done.then === 'function') done.then(undefined, () => {});
  } catch (_) {}
}

module.exports = { isNoBypassSession, rememberNoBypassSession, KEY, MAX };
