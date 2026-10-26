// @module lib/agentNotify — notifications the agent sends itself.
//
// The launcher has always guessed when a turn ends: output quiet for 3 s after
// 7 s of running → "needs attention" + desktop toast. That guess misfires
// whenever an agent goes quiet mid-turn (a long tool call, a slow model
// response) and stays silent when a turn finishes quickly. Agents that can
// report it themselves do so through `cli-launcher notify`; for Claude Code
// the launcher wires its hooks to that command.
//
// Pure functions only (no `vscode`): hook input → event, and the decisions a
// tab makes about it. createPanel / restartPty apply them.

// done / attention / info come from `cli-launcher notify`; busy marks a new
// turn (Claude Code's UserPromptSubmit hook).
const NOTIFY_EVENTS = new Set(['done', 'attention', 'info', 'busy']);

// The command the injected Claude Code hooks run (bin/path is on the tab's PATH).
const HOOK_COMMAND = 'cli-launcher notify --from-hook';

// Claude Code Notification types that mean "come back, I need you". The rest
// (auth_success, elicitation_complete / _response, quota_auto_resume_*,
// plugin_notification, agent_completed, and types added later) are not a
// reason to call the user over. An older Claude Code sends no type at all.
const ATTENTION_KINDS = new Set([
  'permission_prompt',
  'idle_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
]);

// Kinds the on-screen prompt detector also catches — the two must not both toast.
const PROMPT_KINDS = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog']);

// A Stop is confirmed at the next quiet moment, and cancelled if output then
// keeps flowing this long without a break: another Stop hook (OMC ralph,
// /goal) blocked the stop and Claude is still working. Claude's own
// end-of-turn redraws are short bursts, well under this.
const PENDING_SUSTAIN_MS = 2000;
// Chunks further apart than this are separate bursts, not one stream.
const OUTPUT_LIVE_GAP_MS = 600;

// Within this window, a toast from one source (hook / detector / guess) makes
// the other's toast for the same moment a duplicate.
const DEDUP_MS = 15 * 1000;

function stopFailureMessage(input) {
  // Claude's own wording ("API Error: Rate limit reached") reads best.
  if (typeof input.last_assistant_message === 'string' && input.last_assistant_message.trim()) {
    return input.last_assistant_message.trim();
  }
  const err = input.error;
  if (typeof err === 'string' && err.trim()) return `Stopped: ${err.trim()}`;
  if (err && typeof err === 'object' && typeof err.message === 'string') return `Stopped: ${err.message}`;
  return 'Stopped with an error';
}

/**
 * Claude Code hook stdin → a notify event, or null when the hook is not one
 * the launcher reacts to.
 * @param {any} input parsed hook JSON ({hook_event_name, message, notification_type, …})
 * @returns {{event:string, message?:string, kind?:string|null}|null}
 */
function notifyFromHookInput(input) {
  if (!input || typeof input !== 'object') return null;
  switch (input.hook_event_name) {
    case 'Stop':
      return { event: 'done' };
    case 'StopFailure':
      // The turn ended on an API error (rate limit, overload, auth) — Stop does
      // not fire for it.
      return { event: 'attention', message: stopFailureMessage(input), kind: 'stop_failure' };
    case 'UserPromptSubmit':
      return { event: 'busy' };
    case 'Notification': {
      const kind = typeof input.notification_type === 'string' ? input.notification_type : null;
      if (kind !== null && !ATTENTION_KINDS.has(kind)) return null;
      return { event: 'attention', message: typeof input.message === 'string' ? input.message : '', kind };
    }
    default:
      return null;
  }
}

/**
 * What an agent notification does to its tab.
 * @param {{event:string, kind?:string|null}} ev
 * @param {{state?:string, alive?:boolean, announced?:boolean, viewing?:boolean}} tab
 *   alive = the agent process is running; announced = this turn was already
 *   announced; viewing = the user is looking at the tab right now
 * @returns {{attention:boolean, toast:boolean}}
 */
function planAgentNotify(ev, tab) {
  const t = tab || {};
  if (!ev || !NOTIFY_EVENTS.has(ev.event) || ev.event === 'busy') return { attention: false, toast: false };
  // A finished or crashed tab keeps its state; a late hook or a backgrounded
  // `… && cli-launcher notify` still reaches the user.
  if (t.alive === false) return { attention: false, toast: true };
  if (ev.event === 'info') return { attention: false, toast: true };
  // Claude Code's idle reminder (~60 s after a turn) repeats an announced turn
  // end; it is the fallback when nothing was announced.
  if (ev.kind === 'idle_prompt' && t.announced) return { attention: false, toast: false };
  // The user is looking at this very tab: nothing to call them over for.
  if (t.viewing) return { attention: false, toast: false };
  return { attention: true, toast: true };
}

/**
 * A pending Stop sees output. Returns the updated pending record, or null when
 * one unbroken run of output has gone on long enough to mean Claude kept
 * working. Separate bursts (a statusline refresh, then the title escape two
 * seconds later) never add up to a run.
 * @param {{at:number, firstOut?:number, lastOut?:number}} pending
 */
function pendingAfterOutput(pending, now) {
  if (!pending) return null;
  const continues = pending.lastOut && now - pending.lastOut <= OUTPUT_LIVE_GAP_MS;
  const firstOut = continues ? pending.firstOut : now;
  if (now - firstOut >= PENDING_SUSTAIN_MS) return null;
  return { ...pending, firstOut, lastOut: now };
}

/**
 * Start of the current unbroken run of output, given the previous run start
 * and the previous chunk's time. A gap over OUTPUT_LIVE_GAP_MS starts a new run.
 */
function outputRunStart(prevRunStart, prevLastOut, now) {
  return prevRunStart && prevLastOut && now - prevLastOut <= OUTPUT_LIVE_GAP_MS ? prevRunStart : now;
}

/** Has one unbroken run of output lasted long enough to mean real work? */
function isSustainedRun(runStart, now) {
  return typeof runStart === 'number' && now - runStart >= PENDING_SUSTAIN_MS;
}

/** Does a hook event end the turn (as opposed to a prompt inside it)? */
function endsTurn(ev) {
  return !!ev && (ev.event === 'done' || ev.kind === 'stop_failure');
}

/**
 * Hooks run as separate processes, so their notifications can arrive out of
 * order: a UserPromptSubmit hook started before a short turn's Stop may land
 * after it. `t` is when each hook process started (Claude starts them in
 * order). A busy older than the last turn end is stale.
 */
function isStaleBusy(busyT, lastTurnEndT) {
  return typeof busyT === 'number' && typeof lastTurnEndT === 'number' && busyT < lastTurnEndT;
}

/** Is a toast at `now` a duplicate of one from another source at `other`? */
function isDuplicate(other, now) {
  return typeof other === 'number' && other > 0 && now - other < DEDUP_MS;
}

/** Toast text for an event: the agent's own message, else a short default. */
function notifyMessage(ev) {
  if (ev && typeof ev.message === 'string' && ev.message.trim()) return ev.message.trim();
  if (ev && ev.event === 'done') return 'Finished';
  if (ev && ev.event === 'attention') return 'Needs your input';
  return '';
}

/**
 * Claude Code settings that run HOOK_COMMAND on Stop, StopFailure,
 * Notification and UserPromptSubmit. Passed with `--settings <file>` for one
 * launcher tab; the user's own settings and hooks are left alone (hooks from
 * every settings source run). async: the hook cannot change what Claude does,
 * and Claude does not wait for it.
 */
function claudeHookSettings(command) {
  const hook = { type: 'command', command: command || HOOK_COMMAND, timeout: 10, async: true };
  return {
    hooks: {
      Stop: [{ hooks: [hook] }],
      StopFailure: [{ hooks: [hook] }],
      Notification: [{ hooks: [hook] }],
      UserPromptSubmit: [{ hooks: [hook] }],
    },
  };
}

module.exports = {
  NOTIFY_EVENTS,
  HOOK_COMMAND,
  ATTENTION_KINDS,
  PROMPT_KINDS,
  PENDING_SUSTAIN_MS,
  OUTPUT_LIVE_GAP_MS,
  DEDUP_MS,
  notifyFromHookInput,
  planAgentNotify,
  pendingAfterOutput,
  outputRunStart,
  isSustainedRun,
  endsTurn,
  isStaleBusy,
  isDuplicate,
  notifyMessage,
  claudeHookSettings,
};
