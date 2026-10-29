// @module lib/slackInbox — pure helpers for the Slack inbox: a Slack message
// shortcut ("Send to Claude") that opens a new Claude tab with that message.
//
// Flow (runtime side in handlers/slackInbox.js):
//   Slack ⋯ menu → message shortcut → Socket Mode envelope → the window that
//   got it acks, checks the clicker is allowed, builds the prompt, and opens a
//   Claude tab in the configured folder — in the window that owns that folder,
//   handed over the way resume links are (lib/windowRoute).
//
// Socket Mode needs no public URL: the launcher dials out to Slack over a
// WebSocket, so it works on a PC behind a company firewall.
//
// No `vscode` require, so envelope triage, Slack markup cleanup and the prompt
// shape are unit testable.

const { t } = require('../i18n');

// The Callback ID the user gives the message shortcut in the Slack app config.
// Anything else the same app sends (another shortcut, a slash command) is acked
// and left alone.
const SHORTCUT_CALLBACK_ID = 'send_to_claude';
// The prompt modal the shortcut opens; its submission carries the draft id.
const MODAL_CALLBACK_ID = 'send_to_claude_modal';
const REQUEST_BLOCK_ID = 'request';
const REQUEST_ACTION_ID = 'value';
const DRAFT_ID_RE = /^[a-f0-9]{16,64}$/;
const PREVIEW_MAX = 500;

const BOT_TOKEN_RE = /^xoxb-[A-Za-z0-9-]{10,}$/;
const APP_TOKEN_RE = /^xapp-[A-Za-z0-9-]{10,}$/;
// Member ids: U… (or W… on Enterprise Grid).
const USER_ID_RE = /^[UW][A-Z0-9]{2,20}$/;
const TS_RE = /^\d+\.\d+$/;

const TITLE_MAX = 60;

function isValidBotToken(token) {
  return typeof token === 'string' && BOT_TOKEN_RE.test(token.trim());
}

function isValidAppToken(token) {
  return typeof token === 'string' && APP_TOKEN_RE.test(token.trim());
}

function isValidUserId(id) {
  return typeof id === 'string' && USER_ID_RE.test(id);
}

/**
 * Allowed member ids from the setting: an array, or a comma/space separated
 * string. Invalid entries are dropped, duplicates collapsed.
 * @returns {string[]}
 */
function parseUserIds(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  const out = [];
  for (const raw of list) {
    const id = String(raw || '').trim().toUpperCase();
    if (isValidUserId(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * What to do with one Socket Mode frame. Every frame that carries an
 * envelope_id must be acked, whatever the verdict, or Slack retries it.
 * @param {object} frame parsed JSON frame
 * @param {string[]} allowedUserIds
 * `hello` carries how long Slack means to keep the socket (seconds, 0 when
 * not given) — past that without a `disconnect`, the socket is likely dead.
 * The shortcut opens a modal; its `view_submission` (Send) is what starts the
 * session.
 * @returns {{kind:'hello'|'disconnect'|'ignore'|'rejected'|'shortcut'|'submission', connectionSeconds?:number, envelopeId?:string, reason?:string, userId?:string, responseUrl?:string, payload?:object}}
 */
function triageEnvelope(frame, allowedUserIds) {
  if (!frame || typeof frame !== 'object') return { kind: 'ignore' };
  if (frame.type === 'hello') {
    const secs = Number(frame.debug_info && frame.debug_info.approximate_connection_time);
    return { kind: 'hello', connectionSeconds: Number.isFinite(secs) && secs > 0 ? secs : 0 };
  }
  if (frame.type === 'disconnect') return { kind: 'disconnect', reason: String(frame.reason || '') };
  const envelopeId = typeof frame.envelope_id === 'string' ? frame.envelope_id : undefined;
  const p = frame.payload;
  if (frame.type !== 'interactive' || !p) return { kind: 'ignore', envelopeId };
  let kind;
  if (p.type === 'message_action' && p.callback_id === SHORTCUT_CALLBACK_ID) kind = 'shortcut';
  else if (p.type === 'view_submission' && p.view && p.view.callback_id === MODAL_CALLBACK_ID) kind = 'submission';
  else return { kind: 'ignore', envelopeId };
  const userId = p.user && p.user.id;
  // The app is installed for the whole workspace, so everyone sees the
  // shortcut — only the listed members may start a session on this PC.
  if (!isValidUserId(userId) || !(allowedUserIds || []).includes(userId)) {
    return { kind: 'rejected', envelopeId, userId, responseUrl: p.response_url };
  }
  return { kind, envelopeId, payload: p };
}

/** A draft id from the modal's private_metadata, or null when it is not one of ours. */
function draftIdFromView(view) {
  const id = view && typeof view.private_metadata === 'string' ? view.private_metadata : '';
  return DRAFT_ID_RE.test(id) ? id : null;
}

/** What the user typed in the modal ('' when left empty). */
function modalRequestText(view) {
  const values = view && view.state && view.state.values;
  const field = values && values[REQUEST_BLOCK_ID] && values[REQUEST_BLOCK_ID][REQUEST_ACTION_ID];
  return field && typeof field.value === 'string' ? field.value.trim() : '';
}

/**
 * The modal the shortcut opens: a "what should Claude do" box (optional —
 * empty sends the message with the default instruction) above a preview of
 * the message. Plain text only, so the preview cannot render as mrkdwn.
 * @param {{draftId:string, sender:string, channel:string, text:string}} o
 */
function buildPromptModal(o) {
  const chars = Array.from(oneLine(o.text));
  const preview = chars.length > PREVIEW_MAX ? chars.slice(0, PREVIEW_MAX - 1).join('') + '…' : chars.join('');
  const plain = (text) => ({ type: 'plain_text', text, emoji: true });
  const blocks = [
    {
      type: 'input',
      block_id: REQUEST_BLOCK_ID,
      optional: true,
      label: plain(t('slackModalLabel')),
      hint: plain(t('slackModalHint')),
      element: {
        type: 'plain_text_input',
        action_id: REQUEST_ACTION_ID,
        multiline: true,
        focus_on_load: true,
        placeholder: plain(t('slackModalPlaceholder')),
      },
    },
    { type: 'context', elements: [plain(`${oneLine(o.sender)} · ${oneLine(o.channel)}`)] },
  ];
  if (preview) blocks.push({ type: 'section', text: plain(preview) });
  return {
    type: 'modal',
    callback_id: MODAL_CALLBACK_ID,
    private_metadata: o.draftId,
    title: plain(t('slackModalTitle')),
    submit: plain(t('slackModalSubmit')),
    close: plain(t('slackModalClose')),
    blocks,
  };
}

/** True for a Slack response_url (the only place we POST a reply to). */
function isSlackResponseUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'hooks.slack.com';
  } catch (_) {
    return false;
  }
}

/** Member ids mentioned as `<@U…>` in Slack text, in order, without repeats. */
function mentionedUserIds(text) {
  const out = [];
  const re = /<@([UW][A-Z0-9]{2,20})(?:\|[^>]*)?>/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * Slack's mrkdwn markup → plain text: `<@U1>` → `@name`, `<#C1|general>` →
 * `#general`, `<!here>` → `@here`, `<url|label>` → `label (url)`, and the
 * &amp; &lt; &gt; escapes undone (last, so link targets are unescaped too).
 * @param {string} text
 * @param {Record<string,string>} [names] member id → display name
 */
function slackToPlainText(text, names) {
  const lookup = names || {};
  return String(text || '')
    .replace(/<([^<>]+)>/g, (_, inner) => {
      const bar = inner.indexOf('|');
      const target = bar === -1 ? inner : inner.slice(0, bar);
      const label = bar === -1 ? '' : inner.slice(bar + 1);
      if (target.startsWith('@')) {
        const id = target.slice(1);
        return '@' + (label || lookup[id] || id);
      }
      if (target.startsWith('#')) return '#' + (label || target.slice(1));
      // !here, !channel, !everyone, !subteam^S1, !date^…
      if (target.startsWith('!')) return label || '@' + target.slice(1).split('^')[0];
      return label && label !== target ? `${label} (${target})` : target;
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * The message's text. A bot post may carry it only in legacy attachments.
 * @param {{text?:string, attachments?:Array<{text?:string, fallback?:string, pretext?:string, title?:string}>}} message
 */
function messageBody(message) {
  const m = message || {};
  if (typeof m.text === 'string' && m.text.trim()) return m.text;
  const parts = [];
  for (const a of Array.isArray(m.attachments) ? m.attachments : []) {
    const text = a && (a.text || a.pretext || a.title || a.fallback);
    if (text) parts.push(String(text));
  }
  return parts.join('\n\n');
}

/** Attached files as {name, url}; the url is Slack's permalink (needs a login to open). */
function messageFiles(message) {
  const files = message && Array.isArray(message.files) ? message.files : [];
  return files.map((f) => ({
    name: String((f && (f.name || f.title)) || 'file'),
    url: String((f && (f.permalink || f.url_private)) || ''),
  }));
}

/**
 * Permalink for a message, built from the shortcut payload so no extra API
 * call (or channel membership) is needed. '' when a part looks wrong.
 */
function messagePermalink({ domain, channelId, ts, threadTs }) {
  if (!domain || !channelId || !ts) return '';
  if (!/^[A-Za-z0-9-]+$/.test(domain) || !/^[A-Z0-9]+$/.test(channelId) || !TS_RE.test(ts)) return '';
  let url = `https://${domain}.slack.com/archives/${channelId}/p${ts.replace('.', '')}`;
  if (threadTs && threadTs !== ts && TS_RE.test(threadTs)) url += `?thread_ts=${threadTs}&cid=${channelId}`;
  return url;
}

/** `#name` for a channel, 'DM' for a direct or group message. */
function channelLabel(channel) {
  const name = channel && typeof channel.name === 'string' ? channel.name : '';
  if (!name || name === 'directmessage' || name.startsWith('mpdm-')) return t('slackDirectMessage');
  if (name === 'privategroup') return t('slackPrivateChannel');
  return '#' + name;
}

/** Slack ts (epoch seconds as a string) → local `YYYY-MM-DD HH:mm`. */
function formatSlackTs(ts) {
  if (!TS_RE.test(String(ts || ''))) return '';
  const d = new Date(Math.floor(Number(ts) * 1000));
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Text bound for a PTY. Slack text is someone else's input: an ESC could end
 * the bracketed paste early and turn the rest into keystrokes, so every
 * control character except newline and tab goes (C1 too — 8-bit CSI).
 */
function sanitizeForPty(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

// A header field (sender, file name, …) on one line: a newline in a display
// name or file title would otherwise add unquoted lines to the prompt.
function oneLine(text) {
  return sanitizeForPty(text).replace(/\s+/g, ' ').trim();
}

/**
 * The first prompt of the new session: the instruction, where the message came
 * from, then the message itself quoted line by line, so it reads as the
 * forwarded message rather than as the instruction.
 *
 * `request` is what the user typed in the modal. It leads, as the user's own
 * instruction, followed by a line saying the quoted message below is
 * someone's message. Without it the default (or `instruction`) line leads.
 * @param {{request?:string, instruction?:string, sender:string, channel:string, when?:string, link?:string, text:string, files?:Array<{name:string,url:string}>}} o
 */
function buildSlackPrompt(o) {
  const lines = [];
  const request = String(o.request || '').trim();
  if (request) {
    lines.push(request);
    lines.push('');
    lines.push(t('slackPromptForwarded'));
  } else {
    lines.push((o.instruction && o.instruction.trim()) || t('slackPromptIntro'));
  }
  lines.push('');
  lines.push(`- ${t('slackPromptFrom')}: ${oneLine(o.sender)}`);
  lines.push(`- ${t('slackPromptChannel')}: ${oneLine(o.channel)}`);
  if (o.when) lines.push(`- ${t('slackPromptTime')}: ${oneLine(o.when)}`);
  if (o.link) lines.push(`- ${t('slackPromptLink')}: ${oneLine(o.link)}`);
  const files = o.files || [];
  if (files.length) {
    lines.push(`- ${t('slackPromptFiles')}:`);
    for (const f of files) lines.push(`  - ${oneLine(f.name)}${f.url ? ` (${oneLine(f.url)})` : ''}`);
  }
  lines.push('');
  const body = String(o.text || '').trim() || t('slackPromptEmpty');
  for (const line of body.split('\n')) lines.push(line ? `> ${line}` : '>');
  if (o.link) {
    lines.push('');
    lines.push(t('slackPromptContext'));
  }
  return sanitizeForPty(lines.join('\n'));
}

/** Tab / session title: `Slack · <sender>: <first line>`, cut to 60 characters. */
function slackTabTitle(sender, text) {
  const first = String(text || '')
    .split('\n')
    .map((s) => s.trim())
    .find(Boolean) || '';
  const title = oneLine(`Slack · ${sender}${first ? `: ${first}` : ''}`);
  const chars = Array.from(title);
  return chars.length > TITLE_MAX ? chars.slice(0, TITLE_MAX - 1).join('') + '…' : title;
}

module.exports = {
  SHORTCUT_CALLBACK_ID,
  MODAL_CALLBACK_ID,
  draftIdFromView,
  modalRequestText,
  buildPromptModal,
  isValidBotToken,
  isValidAppToken,
  isValidUserId,
  parseUserIds,
  triageEnvelope,
  isSlackResponseUrl,
  mentionedUserIds,
  slackToPlainText,
  messageBody,
  messageFiles,
  messagePermalink,
  channelLabel,
  formatSlackTs,
  sanitizeForPty,
  oneLine,
  buildSlackPrompt,
  slackTabTitle,
};
