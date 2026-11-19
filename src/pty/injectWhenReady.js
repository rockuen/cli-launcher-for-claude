// @module pty/injectWhenReady — type a first prompt into a freshly opened tab.
//
// Shared by the inboxes that open a tab for text that arrives from outside the
// editor (handlers/slackInbox, handlers/browserBridge). The prompt is typed
// once the agent's start-up screen has gone quiet, unless the agent is asking
// something first (folder trust, a menu) — then it waits for the user to answer
// it. If the tab never gets there, `onGiveUp` is called so the caller can offer
// the prompt some other way.

'use strict';

const { writePtyChunked } = require('./write');
const { writeSubmitInput } = require('./submitInput');
const { detectPromptAffordance } = require('../lib/promptAffordance');

const READY_POLL_MS = 250;
const READY_MIN_MS = 2000;
const READY_QUIET_MS = 1500;
const READY_GIVE_UP_MS = 5 * 60_000;

/**
 * @param {object} entry panel entry (state.panels value)
 * @param {string} prompt text to submit
 * @param {{ onGiveUp?: () => void }} [opts]
 */
function injectWhenReady(entry, prompt, opts = {}) {
  const startedAt = Date.now();
  const tick = () => {
    if (entry._disposed) return;
    const now = Date.now();
    const quiet = !!entry._lastOutputAt && now - entry._lastOutputAt >= READY_QUIET_MS;
    const asking = quiet && !!detectPromptAffordance(entry._recentTail || '');
    if (entry.pty && quiet && !asking && now - startedAt >= READY_MIN_MS) {
      writeSubmitInput(entry, prompt, writePtyChunked);
      entry._recentTail = ''; // as a launcher submit does (panel/messageRouter)
      return;
    }
    if (now - startedAt >= READY_GIVE_UP_MS) {
      if (opts.onGiveUp) opts.onGiveUp();
      return;
    }
    setTimeout(tick, READY_POLL_MS);
  };
  setTimeout(tick, READY_POLL_MS);
}

module.exports = { injectWhenReady, READY_MIN_MS, READY_QUIET_MS, READY_GIVE_UP_MS };
