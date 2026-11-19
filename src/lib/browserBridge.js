// @module lib/browserBridge — pure half of the browser bridge
// (handlers/browserBridge): the connection key, request checks, and the page
// file / prompt / tab title a browser "ask about this page" turns into.
//
// No `vscode` require, so everything here is unit testable.

'use strict';

const path = require('path');
const crypto = require('crypto');
const { t } = require('../i18n');
const { isSafeLinkCwd } = require('./sessionLink');
const { sanitizeForPty, oneLine } = require('./slackInbox');

const API_VERSION = 1;
const DEFAULT_PORT = 47823;
const KEY_PREFIX = 'clb1';
// A long article as Markdown is well under 1 MB; this only stops a runaway body.
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const TITLE_MAX = 60;
// A page title is the page author's text; past this it is noise (and slow to
// type into a PTY).
const PAGE_TITLE_MAX = 300;
// Bidi controls and zero-width characters can hide text in a terminal.
// eslint-disable-next-line no-misleading-character-class
const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function isValidToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(token);
}

function isValidPort(port) {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

/** The one string the user copies into the browser extension: `clb1.<port>.<token>`. */
function encodeKey(port, token) {
  return `${KEY_PREFIX}.${port}.${token}`;
}

/** @returns {{port:number, token:string}|null} */
function decodeKey(key) {
  const m = /^clb1\.(\d{1,5})\.([A-Za-z0-9_-]+)$/.exec(String(key || '').trim());
  if (!m) return null;
  const port = Number(m[1]);
  if (!isValidPort(port) || !isValidToken(m[2])) return null;
  return { port, token: m[2] };
}

/** `Authorization: Bearer <token>` → token, or null. */
function bearerToken(header) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(header || '').trim());
  return m ? m[1] : null;
}

// Hashing first makes the comparison constant-time for any length.
function tokensMatch(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !given || !expected) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// A web page that fetches 127.0.0.1 sends its own Origin, which it cannot
// forge; only extension pages (and local tools, which send none) get through.
function isAllowedOrigin(origin) {
  if (origin === undefined || origin === null || origin === '') return true;
  return /^(chrome|moz|safari-web)-extension:\/\/[A-Za-z0-9._-]+$/.test(String(origin));
}

// DNS rebinding: a page on evil.example whose name resolves to 127.0.0.1 would
// otherwise be same-origin with this server. Its Host header gives it away.
function isAllowedHost(host, port) {
  const h = String(host || '').toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

/** `~` and `~/x` → the home folder, so one folder list works on Windows and Mac. */
function expandHome(p, home) {
  const s = String(p || '').trim();
  if (!home) return s;
  if (s === '~') return home;
  if (/^~[\\/]/.test(s)) return path.join(home, s.slice(2));
  return s;
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

/**
 * A line of page-supplied text (title, URL) made safe for the prompt: one
 * line, no invisible characters, and no `@` at all — Claude Code reads
 * `@.env` or `@~/.ssh/id_rsa` as a file to attach, after a space and also
 * after CJK punctuation such as 。、？！ inside a word. A full-width ＠ keeps
 * the text readable; the page file keeps the real URL.
 */
function pageLine(text, max) {
  let out = oneLine(str(text).replace(INVISIBLE_RE, '')).replace(/@/g, '\uff20');
  const chars = Array.from(out);
  if (max && chars.length > max) out = chars.slice(0, max - 1).join('') + '…';
  return out;
}

/**
 * Check and normalize a `POST /v1/ask` body.
 * @param {any} body parsed JSON
 * @param {{home?:string, platform?:string}} env
 * @returns {{ok:true, value:{url:string,title:string,content:string,selection:string,question:string,agent:string,cwd:string,focus:boolean}} | {ok:false, error:string, field?:string}}
 */
function parseAskBody(body, env = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'bad-request' };
  const url = str(body.url).trim();
  if (!/^(https?|file):\/\//i.test(url) || url.length > 8192) return { ok: false, error: 'bad-request', field: 'url' };
  const content = str(body.content);
  const selection = str(body.selection);
  if (!content.trim() && !selection.trim()) return { ok: false, error: 'empty-page' };
  const agent = str(body.agent).trim() || 'claude';
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(agent)) return { ok: false, error: 'unknown-agent' };
  const cwd = expandHome(str(body.cwd), env.home);
  if (!cwd || !isSafeLinkCwd(cwd, env.platform)) return { ok: false, error: 'bad-folder', field: 'cwd' };
  return {
    ok: true,
    value: {
      url,
      title: pageLine(body.title, PAGE_TITLE_MAX) || url,
      content,
      selection,
      question: sanitizeForPty(str(body.question)).trim(),
      agent,
      cwd,
      focus: body.focus !== false,
    },
  };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Names pageFileName makes — the only files the sweep may delete. */
const PAGE_FILE_RE = /^web-\d{6}-\d{6}-[0-9a-z]+\.md$/i;

/** `web-YYMMDD-HHMMSS-<rand>.md` — sortable, no title in it (titles carry any character). */
function pageFileName(date, rand) {
  const d = date || new Date();
  const stamp = `${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `web-${stamp}-${String(rand || '').replace(/[^a-z0-9]/gi, '') || '0'}.md`;
}

/**
 * The Markdown file the agent reads: front matter, then the selection (when
 * the user had one) and the page itself under headings it can tell apart.
 * @param {{title:string, url:string, content?:string, selection?:string, capturedAt?:Date}} o
 */
function buildPageFile(o) {
  const lines = [
    '---',
    `title: ${JSON.stringify(oneLine(o.title))}`,
    `url: ${JSON.stringify(oneLine(o.url))}`,
    `captured: ${(o.capturedAt || new Date()).toISOString()}`,
    '---',
    '',
    `# ${oneLine(o.title)}`,
    '',
    `${t('bridgeFileSource')}: ${oneLine(o.url)}`,
    '',
  ];
  const selection = str(o.selection).trim();
  const content = str(o.content).trim();
  if (selection) {
    lines.push(`## ${t('bridgeFileSelection')}`, '', selection, '');
  }
  if (content) {
    lines.push(`## ${t('bridgeFileContent')}`, '', content, '');
  }
  return lines.join('\n');
}

// Forward slashes: an `@C:\…` mention can be misread as escapes by TUI editors.
function toCliPath(absPath) {
  return String(absPath || '').replace(/\\/g, '/');
}

/**
 * The first prompt of the new tab. Where the page came from and the file that
 * holds it come first; the user's request comes last, so the cursor ends on
 * plain text (an `@path` at the very end could leave a file picker open over
 * the Enter that submits). Claude gets an `@` mention, which attaches the file;
 * other agents are asked to read it.
 * @param {{question?:string, title:string, url:string, filePath:string, agent:string, hasSelection?:boolean}} o
 */
function buildAskPrompt(o) {
  const file = toCliPath(o.filePath);
  // An @ mention ends at whitespace, so a path with a space is given plain and
  // Claude reads it like any other agent would.
  const ref = o.agent === 'claude' && !/\s/.test(file) ? `@${file}` : file;
  const lines = [
    t('bridgePromptIntro'),
    '',
    `- ${t('bridgePromptTitle')}: ${pageLine(o.title, PAGE_TITLE_MAX)}`,
    `- ${t('bridgePromptUrl')}: ${pageLine(o.url)}`,
    `- ${t('bridgePromptFile')}: ${ref}`,
  ];
  if (o.hasSelection) lines.push(`- ${t('bridgePromptSelection')}`);
  lines.push('');
  lines.push(`${t('bridgePromptRequest')}:`);
  lines.push(String(o.question || '').trim() || t('bridgePromptDefaultQuestion'));
  return sanitizeForPty(lines.join('\n'));
}

/** Tab / session title: `Web · <page title>`, cut to 60 characters. */
function browserTabTitle(title) {
  const full = oneLine(`Web · ${pageLine(title) || '-'}`);
  const chars = Array.from(full);
  return chars.length > TITLE_MAX ? chars.slice(0, TITLE_MAX - 1).join('') + '…' : full;
}

module.exports = {
  API_VERSION,
  DEFAULT_PORT,
  MAX_BODY_BYTES,
  generateToken,
  isValidToken,
  isValidPort,
  encodeKey,
  decodeKey,
  bearerToken,
  tokensMatch,
  isAllowedOrigin,
  isAllowedHost,
  expandHome,
  pageLine,
  parseAskBody,
  pageFileName,
  PAGE_FILE_RE,
  buildPageFile,
  toCliPath,
  buildAskPrompt,
  browserTabTitle,
  sanitizeForPty,
  oneLine,
};
