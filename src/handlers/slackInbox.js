// @module handlers/slackInbox — Slack message shortcut → new Claude tab.
//
// Slack ⋯ menu → "Send to Claude" (a message shortcut, Callback ID
// `send_to_claude`) → this window receives it over Socket Mode → a new Claude
// tab opens in the configured folder and the message goes in as its first
// prompt. Pure parts (triage, markup, prompt) live in lib/slackInbox.
//
// Connection: every window with the feature on keeps its own Socket Mode
// WebSocket. Slack hands each envelope to ONE connection, so whichever window
// gets it routes it: the folder is open here → the tab opens here; otherwise a
// pending record goes to globalStorage and the editor CLI focuses (or opens)
// the window that owns the folder, which claims the record — the same hand-off
// resume links use (uri/sessionUriHandler, lib/windowRoute).
//
// Trust: the tab runs someone else's text, often with permissions bypassed.
// So the settings that decide who may start a session and where are read from
// USER settings only (a repo's .vscode/settings.json must not widen them), the
// folder must be configured (no "whatever this window has open" fallback), and
// tokens (bot xoxb-, app-level xapp-) live in SecretStorage, never settings.

'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const state = require('../state');
const { t } = require('../i18n');
const lib = require('../lib/slackInbox');
const { isSafeLinkCwd, notificationText } = require('../lib/sessionLink');
const { isCwdInWorkspace, shouldClaimPending, PENDING_TTL_MS } = require('../lib/windowRoute');
const { openFolderWindow } = require('../lib/editorCli');
const { writePtyChunked } = require('../pty/write');
const { writeSubmitInput } = require('../pty/submitInput');
const { detectPromptAffordance } = require('../lib/promptAffordance');

const BOT_TOKEN_KEY = 'claudeCodeLauncher.slackInbox.botToken';
const APP_TOKEN_KEY = 'claudeCodeLauncher.slackInbox.appToken';
const PENDING_PREFIX = 'pending-slack-';
const DRAFT_PREFIX = 'slack-draft-';
// A response_url lives 30 minutes, so a draft is no use after that.
const DRAFT_TTL_MS = 30 * 60_000;
const DRAFT_WAIT_MS = 5000;
const DRAFT_POLL_MS = 200;
const SLACK_APPS_URL = 'https://api.slack.com/apps';

const API_TIMEOUT_MS = 10_000;
// Reconnect backoff: 1 s doubling to a minute.
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 60_000;
// Attempts in a row that never reach `hello` before the user is told.
const WARN_AFTER_FAILURES = 5;
// Slack errors that no retry will fix — stop and tell the user.
const FATAL_ERRORS = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'account_inactive', 'not_allowed_token_type']);
// A socket can survive sleep or a network change half-open, with no close
// event, and the runtime's WebSocket hides pings. A clock tick this late means
// the PC slept: reconnect. Otherwise every socket is replaced after Slack's
// connection time (hello) or 30 minutes, whichever is sooner — the overlap
// makes that seamless, and it bounds how long a dead socket can go unnoticed.
// A socket with no hello this long after opening is closed and retried.
const CLOCK_TICK_MS = 30_000;
const SLEPT_AFTER_MS = 120_000;
const REFRESH_MAX_SECONDS = 30 * 60;
const CONNECTION_GRACE_MS = 60_000;
const HELLO_TIMEOUT_MS = 30_000;
const RESTART_DEBOUNCE_MS = 500;

// The new tab is typed into once Claude's start-up screen has settled.
const READY_POLL_MS = 250;
const READY_MIN_MS = 2000;
const READY_QUIET_MS = 1500;
const READY_GIVE_UP_MS = 5 * 60_000;

let socket = null; // { stop() } while connected or retrying
let restartTimer = null;
const nameCache = new Map();
const warned = new Set();

function cfg() {
  return vscode.workspace.getConfiguration('claudeCodeLauncher');
}

// User (global) settings only. package.json scopes these settings to
// application/machine, which already keeps a workspace's value out; this is the
// backstop, since a repo someone else controls must never decide who can start
// a session on this PC, or where.
function userSetting(key, def) {
  const info = cfg().inspect(key);
  return info && info.globalValue !== undefined ? info.globalValue : def;
}

function allowedUserIds() {
  return lib.parseUserIds(userSetting('slackInbox.allowedUserIds', []));
}

function log(...args) {
  console.log('[Claude Launcher][slack]', ...args);
}

// One notification per problem per window, not one per reconnect attempt.
function warnOnce(key, message, ...actions) {
  if (warned.has(key)) return Promise.resolve(undefined);
  warned.add(key);
  return vscode.window.showWarningMessage(message, ...actions);
}

function offerSetup(key, message) {
  warnOnce(key, message, t('slackSetupAction')).then((c) => {
    if (c) vscode.commands.executeCommand('claudeCodeLauncher.slackInbox.setup');
  });
}

function workspaceFolderPaths() {
  return (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
}

function globalStorageDir(context) {
  const dir = context.globalStorageUri ? context.globalStorageUri.fsPath : context.globalStoragePath;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
  return dir;
}

// isSafeLinkCwd first: stat()ing a UNC path would contact that host.
function isUsableFolder(dir) {
  if (!dir || typeof dir !== 'string' || !isSafeLinkCwd(dir)) return false;
  try {
    return fs.statSync(dir).isDirectory();
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Slack Web API
// ---------------------------------------------------------------------------

async function slackApi(method, token, params) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    },
    body: new URLSearchParams(params || {}).toString(),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  return res.json();
}

/**
 * Display names for member ids (users.info, cached for the window's life).
 * @returns {Promise<{names: Record<string,string>, error: string|null}>} error =
 *   Slack's last error code (e.g. missing_scope when the bot lacks users:read)
 */
async function resolveNames(botToken, ids) {
  const names = {};
  let error = null;
  for (const id of ids) {
    if (nameCache.has(id)) {
      names[id] = nameCache.get(id);
      continue;
    }
    if (!botToken) continue;
    try {
      const res = await slackApi('users.info', botToken, { user: id });
      const u = res && res.ok && res.user;
      const name = u && ((u.profile && (u.profile.display_name || u.profile.real_name)) || u.real_name || u.name);
      if (name) {
        nameCache.set(id, name);
        names[id] = name;
      } else if (res && res.error) {
        error = res.error;
      }
    } catch (e) {
      error = (e && e.message) || 'network';
    }
  }
  return { names, error };
}

/** Ephemeral reply (only the clicker sees it) through the shortcut's response_url. */
async function reply(responseUrl, text) {
  if (!lib.isSlackResponseUrl(responseUrl)) return;
  try {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Opening the tab
// ---------------------------------------------------------------------------

// The configured folder, or null. No fallback to "this window's folder":
// Slack picks which window gets a shortcut, so that would be a random project
// (or the home folder) running someone else's text.
function resolveTargetCwd() {
  const dir = String(userSetting('slackInbox.cwd', '') || '').trim();
  return isUsableFolder(dir) ? dir : null;
}

// Type the prompt once the start-up screen has gone quiet, unless Claude is
// asking something first (folder trust, a menu) — then wait for the user to
// answer it. If the tab never gets there, offer the prompt for copying.
function injectWhenReady(entry, prompt, title) {
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
      // A button, not a silent clipboard write: the text is someone else's and
      // the clipboard may hold something the user still needs.
      vscode.window
        .showWarningMessage(t('slackInjectGaveUp').replace('{0}', notificationText(title, 80)), t('slackCopyPrompt'))
        .then((c) => {
          if (c) vscode.env.clipboard.writeText(prompt);
        });
      return;
    }
    setTimeout(tick, READY_POLL_MS);
  };
  setTimeout(tick, READY_POLL_MS);
}

function openHere(context, record) {
  // Required lazily: createPanel pulls in the whole panel stack.
  const { createPanel } = require('../panel/createPanel');
  // Sanitized again here: a record can come from globalStorage, not only
  // from this module's own prompt builder.
  const title = lib.oneLine(record.title);
  const prompt = lib.sanitizeForPty(record.prompt);
  const before = state.tabCounter;
  createPanel(context, context.extensionPath, { cwd: record.cwd, title }, { agent: 'claude' });
  // createPanel bumps the counter before it can fail, so check the entry too
  // (it has already told the user why, e.g. Claude Code not installed).
  const entry = state.tabCounter !== before ? state.panels.get(state.tabCounter) : null;
  if (!entry) return false;
  injectWhenReady(entry, prompt, title);
  return true;
}

function writePending(context, record) {
  const file = path.join(globalStorageDir(context), `${PENDING_PREFIX}${crypto.randomBytes(6).toString('hex')}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify({ ...record, ts: Date.now() }), 'utf8');
    return file;
  } catch (_) {
    return null;
  }
}

/**
 * Open the tab here, or hand it to the window that owns the folder.
 * @returns {'opened'|'handed-off'|'failed'}
 */
function deliver(context, record) {
  if (isCwdInWorkspace(record.cwd, workspaceFolderPaths())) {
    return openHere(context, record) ? 'opened' : 'failed';
  }
  const file = writePending(context, record);
  if (file && openFolderWindow(record.cwd, vscode.env.appRoot)) return 'handed-off';
  // No other window can take it — better a tab here than nothing.
  if (file) {
    try { fs.unlinkSync(file); } catch (_) {}
  }
  return openHere(context, record) ? 'opened' : 'failed';
}

// Reading and deleting is the claim: whichever window unlinks a record first
// opens it, so two windows on overlapping folders cannot both act. Expired
// records are swept so the folder does not collect them.
function claimPending(context) {
  const dir = globalStorageDir(context);
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.startsWith(PENDING_PREFIX) && n.endsWith('.json'));
  } catch (_) {
    return;
  }
  const folders = workspaceFolderPaths();
  const now = Date.now();
  for (const name of names) {
    const file = path.join(dir, name);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      continue; // still being written
    }
    const valid = record && typeof record.ts === 'number' && now - record.ts <= PENDING_TTL_MS
      && typeof record.prompt === 'string' && typeof record.title === 'string' && isSafeLinkCwd(record.cwd);
    if (!valid) {
      try { fs.unlinkSync(file); } catch (_) {}
      continue;
    }
    if (!shouldClaimPending(record, folders, now)) continue;
    try {
      fs.unlinkSync(file);
    } catch (_) {
      continue; // another window got there first
    }
    let opened = false;
    try {
      opened = openHere(context, record);
    } catch (e) {
      log('opening a handed-over tab failed:', e && e.message);
    }
    // The sending window already said "handed off"; correct it if that failed.
    if (!opened) reply(record.responseUrl, t('slackReplyFailed'));
  }
}

// ---------------------------------------------------------------------------
// Drafts: the message between the shortcut and Send in its modal
// ---------------------------------------------------------------------------

function draftPath(context, id) {
  return path.join(globalStorageDir(context), `${DRAFT_PREFIX}${id}.json`);
}

function writeDraft(context, id, draft) {
  try {
    fs.writeFileSync(draftPath(context, id), JSON.stringify({ ...draft, ts: Date.now() }), 'utf8');
  } catch (e) {
    log('could not save the draft:', e && e.message);
  }
}

function isValidDraft(d, now) {
  return !!d && typeof d.ts === 'number' && now - d.ts <= DRAFT_TTL_MS
    && typeof d.title === 'string' && typeof d.text === 'string'
    && typeof d.sender === 'string' && typeof d.channel === 'string';
}

// Read-and-delete is the claim, as with pending records. The shortcut's window
// may still be looking up names when Send arrives, so wait a little for it.
async function takeDraft(context, id) {
  const file = draftPath(context, id);
  const until = Date.now() + DRAFT_WAIT_MS;
  for (;;) {
    let draft = null;
    try {
      draft = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {}
    if (draft) {
      try {
        fs.unlinkSync(file);
      } catch (_) {
        return null; // another window took it
      }
      return isValidDraft(draft, Date.now()) ? draft : null;
    }
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, DRAFT_POLL_MS));
  }
}

// A modal that was cancelled leaves its draft behind; drop the expired ones.
function sweepDrafts(context) {
  const dir = globalStorageDir(context);
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.startsWith(DRAFT_PREFIX));
  } catch (_) {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > DRAFT_TTL_MS) fs.unlinkSync(file);
    } catch (_) {}
  }
}

function senderFallback(message) {
  return (message.user_profile && (message.user_profile.display_name || message.user_profile.real_name))
    || (message.bot_profile && message.bot_profile.name)
    || message.username
    || message.user
    || '?';
}

function reportNoFolder() {
  const configured = String(userSetting('slackInbox.cwd', '') || '');
  offerSetup('cwd', t('slackCwdMissing').replace('{0}', notificationText(configured || '-', 160)));
}

// ---------------------------------------------------------------------------
// The shortcut
// ---------------------------------------------------------------------------

// The shortcut opens a modal right away (its trigger_id lasts 3 seconds), then
// resolves names and parks the message as a draft. Send in the modal arrives as
// a separate envelope that Slack may hand to ANY window's socket, so the draft
// lives in globalStorage, which every window of this editor shares.
async function handleShortcut(context, payload) {
  sweepDrafts(context);
  if (!resolveTargetCwd()) {
    reportNoFolder();
    await reply(payload.response_url, t('slackReplyNoFolder'));
    return;
  }
  const botToken = await context.secrets.get(BOT_TOKEN_KEY);
  if (!botToken) {
    offerSetup('token', t('slackNoTokens'));
    await reply(payload.response_url, t('slackReplyFailed'));
    return;
  }
  const message = payload.message || {};
  const raw = lib.messageBody(message);
  const draftId = crypto.randomBytes(12).toString('hex');
  let opened;
  try {
    opened = await slackApi('views.open', botToken, {
      trigger_id: payload.trigger_id,
      view: JSON.stringify(lib.buildPromptModal({
        draftId,
        sender: senderFallback(message),
        channel: lib.channelLabel(payload.channel),
        text: lib.slackToPlainText(raw),
      })),
    });
  } catch (e) {
    opened = { ok: false, error: (e && e.message) || 'network' };
  }
  if (!opened || !opened.ok) {
    const error = (opened && opened.error) || 'unknown';
    log('views.open failed:', error);
    await reply(payload.response_url, t('slackReplyModalFailed').replace('{0}', error));
    return;
  }

  const ids = lib.mentionedUserIds(raw);
  if (lib.isValidUserId(message.user) && !ids.includes(message.user)) ids.unshift(message.user);
  const { names } = await resolveNames(botToken, ids);
  const sender = names[message.user] || senderFallback(message);
  const text = lib.slackToPlainText(raw, names);
  const ts = message.ts || payload.message_ts;
  writeDraft(context, draftId, {
    title: lib.slackTabTitle(sender, text),
    sender,
    channel: lib.channelLabel(payload.channel),
    when: lib.formatSlackTs(ts),
    link: lib.messagePermalink({
      domain: payload.team && payload.team.domain,
      channelId: payload.channel && payload.channel.id,
      ts,
      threadTs: message.thread_ts,
    }),
    text,
    files: lib.messageFiles(message),
    // Valid for 30 minutes: the reply after Send, from whichever window gets it.
    responseUrl: lib.isSlackResponseUrl(payload.response_url) ? payload.response_url : undefined,
  });
}

// Send in the modal: what the user typed leads the prompt.
async function handleSubmission(context, payload) {
  const draftId = lib.draftIdFromView(payload.view);
  const draft = draftId ? await takeDraft(context, draftId) : null;
  if (!draft) {
    vscode.window.showWarningMessage(t('slackDraftMissing'));
    return;
  }
  const cwd = resolveTargetCwd();
  if (!cwd) {
    reportNoFolder();
    await reply(draft.responseUrl, t('slackReplyNoFolder'));
    return;
  }
  const record = {
    cwd,
    title: draft.title,
    prompt: lib.buildSlackPrompt({
      request: lib.modalRequestText(payload.view),
      instruction: String(userSetting('slackInbox.instruction', '') || ''),
      sender: draft.sender,
      channel: draft.channel,
      when: draft.when,
      link: draft.link,
      text: draft.text,
      files: draft.files,
    }),
    responseUrl: draft.responseUrl,
  };
  const folder = path.basename(cwd) || cwd;
  const result = deliver(context, record);
  log('send from', payload.user && payload.user.id, '→', result, cwd);
  if (result === 'opened') await reply(draft.responseUrl, t('slackReplyOpened').replace('{0}', folder));
  else if (result === 'handed-off') await reply(draft.responseUrl, t('slackReplyHandedOff').replace('{0}', folder));
  else await reply(draft.responseUrl, t('slackReplyFailed'));
}

// ---------------------------------------------------------------------------
// Socket Mode connection
// ---------------------------------------------------------------------------

function stopSocket() {
  if (socket) socket.stop();
  socket = null;
}

function startSocket(context) {
  stopSocket();
  if (!userSetting('slackInbox.enabled', false)) return;
  if (typeof WebSocket !== 'function' || typeof fetch !== 'function') {
    warnOnce('runtime', t('slackNoWebSocket'));
    return;
  }
  if (!allowedUserIds().length) {
    offerSetup('allowed', t('slackNoAllowedUsers'));
    return;
  }

  let stopped = false;
  let ws = null;                  // the current socket
  const live = new Set();         // every socket not closed yet — stop() closes them all
  const greeted = new WeakSet();  // sockets that got hello
  const dropped = new WeakSet();  // sockets closed on purpose (not a failure)
  const retiring = new Set();     // greeted sockets being replaced, closed on the new one's hello
  let timer = null;
  let expiry = null;
  let connecting = false;
  let attempt = 0;
  let failures = 0;               // attempts in a row that never reached hello
  let lastProblem = '';
  let lastTick = Date.now();

  const drop = (sock) => {
    dropped.add(sock);
    try { sock.close(); } catch (_) {}
  };

  const noteFailure = (problem) => {
    if (stopped) return;
    lastProblem = problem;
    failures++;
    if (failures >= WARN_AFTER_FAILURES) {
      warnOnce('unreachable', t('slackUnreachable').replace('{0}', notificationText(lastProblem, 120)));
    }
  };

  const schedule = () => {
    if (stopped || timer) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
    attempt++;
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, delay);
  };

  // A fresh socket now. A current socket that is up keeps serving until the new
  // one says hello; one still handshaking is dropped, or it would be orphaned.
  const reconnectNow = (why) => {
    if (stopped || connecting) return;
    log('reconnecting:', why);
    if (timer) clearTimeout(timer);
    timer = null;
    const current = ws;
    ws = null;
    if (current && greeted.has(current)) retiring.add(current);
    else if (current) drop(current);
    connect();
  };

  const onHello = (sock, verdict) => {
    if (sock !== ws) {
      drop(sock); // replaced while it was handshaking
      return;
    }
    attempt = 0;
    failures = 0;
    for (const old of retiring) drop(old);
    retiring.clear();
    if (expiry) clearTimeout(expiry);
    const secs = Math.min(verdict.connectionSeconds || REFRESH_MAX_SECONDS, REFRESH_MAX_SECONDS);
    expiry = setTimeout(() => reconnectNow('refresh'), secs * 1000 + CONNECTION_GRACE_MS);
    log('connected');
  };

  const onFrame = (sock, data) => {
    if (stopped) return;
    let frame;
    try {
      frame = JSON.parse(String(data));
    } catch (_) {
      return;
    }
    // Read per frame so a settings change applies without a reconnect.
    const verdict = lib.triageEnvelope(frame, allowedUserIds());
    if (verdict.envelopeId) {
      try { sock.send(JSON.stringify({ envelope_id: verdict.envelopeId })); } catch (_) {}
    }
    if (verdict.kind === 'hello') {
      greeted.add(sock);
      onHello(sock, verdict);
    } else if (verdict.kind === 'disconnect') {
      // refresh_requested / warning: Slack is about to drop this socket.
      if (sock === ws) reconnectNow('disconnect: ' + verdict.reason);
    } else if (verdict.kind === 'rejected') {
      log('shortcut from a member not in allowedUserIds:', verdict.userId);
      reply(verdict.responseUrl, t('slackReplyNotAllowed'));
    } else if (verdict.kind === 'shortcut') {
      handleShortcut(context, verdict.payload).catch((e) => {
        log('shortcut failed:', e && e.message);
        reply(verdict.payload.response_url, t('slackReplyFailed'));
      });
    } else if (verdict.kind === 'submission') {
      // The plain ack above closes the modal.
      handleSubmission(context, verdict.payload).catch((e) => {
        log('send failed:', e && e.message);
      });
    }
  };

  const openSocket = async () => {
    const appToken = await context.secrets.get(APP_TOKEN_KEY);
    if (stopped) return;
    if (!appToken) {
      offerSetup('token', t('slackNoTokens'));
      return;
    }
    let res;
    try {
      res = await slackApi('apps.connections.open', appToken);
    } catch (e) {
      log('connections.open failed:', e && e.message);
      noteFailure((e && e.message) || 'network');
      schedule();
      return;
    }
    if (stopped) return;
    if (!res || !res.ok || !res.url) {
      const error = (res && res.error) || 'unknown';
      log('connections.open refused:', error);
      if (FATAL_ERRORS.has(error)) {
        offerSetup('auth', t('slackAuthFailed').replace('{0}', error));
        return;
      }
      noteFailure(error);
      schedule();
      return;
    }
    const sock = new WebSocket(res.url);
    ws = sock;
    live.add(sock);
    // A socket the network accepts but never relays (a proxy, TLS inspection)
    // would sit silent forever: no hello in time → close, counted, retried.
    const helloTimer = setTimeout(() => {
      if (!greeted.has(sock)) {
        try { sock.close(); } catch (_) {}
      }
    }, HELLO_TIMEOUT_MS);
    sock.addEventListener('message', (ev) => onFrame(sock, ev.data));
    sock.addEventListener('close', (ev) => {
      clearTimeout(helloTimer);
      live.delete(sock);
      retiring.delete(sock);
      if (stopped) return;
      const why = `closed ${ev && ev.code}${ev && ev.reason ? ' ' + ev.reason : ''}`;
      log(why);
      if (!greeted.has(sock) && !dropped.has(sock)) noteFailure(why);
      if (ws === sock) {
        ws = null;
        schedule();
      }
    });
    sock.addEventListener('error', () => {}); // a close event follows
  };

  const connect = () => {
    if (stopped || connecting) return;
    connecting = true;
    openSocket()
      .catch((e) => {
        log('connect failed:', e && e.message);
        noteFailure((e && e.message) || 'error');
        schedule();
      })
      .finally(() => {
        connecting = false;
      });
  };

  const clock = setInterval(() => {
    const now = Date.now();
    const late = now - lastTick > SLEPT_AFTER_MS;
    lastTick = now;
    if (late && ws) reconnectNow('woke from sleep');
  }, CLOCK_TICK_MS);

  socket = {
    stop() {
      stopped = true;
      clearInterval(clock);
      if (timer) clearTimeout(timer);
      if (expiry) clearTimeout(expiry);
      timer = null;
      expiry = null;
      for (const s of live) {
        try { s.close(); } catch (_) {}
      }
      live.clear();
      retiring.clear();
      ws = null;
    },
  };
  connect();
}

// Settings and secrets change in bursts (setup writes several), so restart once.
function restartSoon(context) {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    warned.clear();
    startSocket(context);
  }, RESTART_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// Setup / disable commands
// ---------------------------------------------------------------------------

async function askToken(context, key, { prompt, placeHolder, isValid, invalidMessage }) {
  const saved = await context.secrets.get(key);
  const value = await vscode.window.showInputBox({
    prompt: saved ? `${prompt} ${t('slackSetupKeepSaved')}` : prompt,
    placeHolder,
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => {
      if (!v && saved) return null;
      return isValid(v) ? null : invalidMessage;
    },
  });
  if (value === undefined) return undefined; // cancelled
  return value ? value.trim() : saved;
}

async function pickFolder() {
  const current = String(userSetting('slackInbox.cwd', '') || '');
  const items = [];
  const seen = new Set();
  for (const p of [current, ...workspaceFolderPaths()]) {
    if (p && !seen.has(p.toLowerCase())) {
      seen.add(p.toLowerCase());
      items.push({ label: path.basename(p) || p, description: p, folder: p });
    }
  }
  items.push({ label: t('slackSetupOtherFolder'), folder: null });
  const picked = await vscode.window.showQuickPick(items, { placeHolder: t('slackSetupFolder'), ignoreFocusOut: true });
  if (!picked) return undefined;
  const folder = picked.folder
    || ((await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false })) || [])
      .map((u) => u.fsPath)[0];
  if (!folder) return undefined;
  if (!isUsableFolder(folder)) {
    vscode.window.showErrorMessage(t('slackSetupBadFolder').replace('{0}', notificationText(folder, 160)));
    return undefined;
  }
  return folder;
}

async function checkToken(method, token) {
  let res;
  try {
    res = await slackApi(method, token);
  } catch (e) {
    vscode.window.showErrorMessage(t('slackSetupNetwork').replace('{0}', (e && e.message) || ''));
    return null;
  }
  if (!res || !res.ok) {
    vscode.window.showErrorMessage(t('slackAuthFailed').replace('{0}', (res && res.error) || 'unknown'));
    return null;
  }
  return res;
}

async function setupSlackInbox(context) {
  const botToken = await askToken(context, BOT_TOKEN_KEY, {
    prompt: t('slackSetupBotToken'),
    placeHolder: 'xoxb-…',
    isValid: lib.isValidBotToken,
    invalidMessage: t('slackSetupBadBotToken'),
  });
  if (!botToken) return;
  const auth = await checkToken('auth.test', botToken);
  if (!auth) return;

  const appToken = await askToken(context, APP_TOKEN_KEY, {
    prompt: t('slackSetupAppToken'),
    placeHolder: 'xapp-…',
    isValid: lib.isValidAppToken,
    invalidMessage: t('slackSetupBadAppToken'),
  });
  if (!appToken) return;
  if (!(await checkToken('apps.connections.open', appToken))) return;

  const idInput = await vscode.window.showInputBox({
    prompt: t('slackSetupUserId'),
    placeHolder: 'U0123456789',
    value: allowedUserIds().join(', '),
    ignoreFocusOut: true,
    validateInput: (v) => (lib.parseUserIds(v).length ? null : t('slackSetupBadUserId')),
  });
  if (idInput === undefined) return;
  const ids = lib.parseUserIds(idInput);
  const { names, error } = await resolveNames(botToken, ids);
  if (error === 'missing_scope') {
    vscode.window.showErrorMessage(t('slackSetupMissingScope'));
    return;
  }
  const missing = ids.filter((id) => !names[id]);
  if (missing.length) {
    vscode.window.showErrorMessage(t('slackSetupUnknownUser').replace('{0}', missing.join(', ')).replace('{1}', error || '-'));
    return;
  }

  const folder = await pickFolder();
  if (!folder) return;

  await context.secrets.store(BOT_TOKEN_KEY, botToken);
  await context.secrets.store(APP_TOKEN_KEY, appToken);
  const target = vscode.ConfigurationTarget.Global;
  try {
    await cfg().update('slackInbox.allowedUserIds', ids, target);
    await cfg().update('slackInbox.cwd', folder, target);
    await cfg().update('slackInbox.enabled', true, target);
  } catch (e) {
    // "not a registered configuration": the extension was updated with
    // Restart Extensions, which does not register new settings — a window
    // reload does. The tokens above are already saved.
    const reload = t('slackSetupReload');
    const choice = await vscode.window.showErrorMessage(
      t('slackSetupSettingsFailed').replace('{0}', notificationText((e && e.message) || '', 200)),
      reload
    );
    if (choice === reload) vscode.commands.executeCommand('workbench.action.reloadWindow');
    return;
  }
  // Re-running setup with the same values fires no change event.
  restartSoon(context);

  const who = ids.map((id) => `${names[id]} (${id})`).join(', ');
  const choice = await vscode.window.showInformationMessage(
    t('slackSetupDone').replace('{0}', auth.team || '').replace('{1}', who).replace('{2}', lib.SHORTCUT_CALLBACK_ID),
    { modal: true },
    t('slackSetupOpenSlack')
  );
  if (choice) vscode.env.openExternal(vscode.Uri.parse(SLACK_APPS_URL));
}

async function disableSlackInbox() {
  stopSocket();
  await cfg().update('slackInbox.enabled', false, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(t('slackDisabled'));
}

/** Wire the commands, the pending hand-off and the connection (called once from activate). */
function registerSlackInbox(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.slackInbox.setup', () => setupSlackInbox(context)),
    vscode.commands.registerCommand('claudeCodeLauncher.slackInbox.disable', () => disableSlackInbox()),
    // cwd and instruction are read per shortcut; only these change the connection.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeCodeLauncher.slackInbox.enabled')
        || e.affectsConfiguration('claudeCodeLauncher.slackInbox.allowedUserIds')) {
        restartSoon(context);
      }
    }),
    {
      dispose() {
        if (restartTimer) clearTimeout(restartTimer);
        restartTimer = null;
        stopSocket();
      },
    }
  );
  // Tokens saved from another window (setup ran there).
  if (context.secrets.onDidChange) {
    context.subscriptions.push(
      context.secrets.onDidChange((e) => {
        if (e.key === BOT_TOKEN_KEY || e.key === APP_TOKEN_KEY) restartSoon(context);
      })
    );
  }

  // Records handed over by another window. A running window learns of them
  // through the watcher; a window the editor CLI just opened, at start-up.
  const dir = globalStorageDir(context);
  try {
    const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
      if (filename && !String(filename).startsWith(PENDING_PREFIX)) return;
      claimPending(context);
    });
    context.subscriptions.push({ dispose: () => { try { watcher.close(); } catch (_) {} } });
  } catch (_) {}
  // Deferred so the tree providers exist before a panel is created.
  setTimeout(() => claimPending(context), 1500);

  startSocket(context);
}

module.exports = { registerSlackInbox, _test: { resolveTargetCwd, deliver, claimPending, userSetting } };
